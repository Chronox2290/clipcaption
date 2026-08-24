//! Voice dynamics: where each stretch of speech sits in the stereo field, and
//! how loud it is relative to everything else in the clip.
//!
//! Proximity-chat games pan voices by where the speaker is relative to you, so
//! the recording already carries real positional information — measured on a
//! two-minute session clip, a third of all windows sat more than 15% off
//! centre, spanning -0.65 to +0.90. Captions can follow that instead of
//! sitting dead centre, which is what makes an argument across a room read as
//! an argument across a room.
//!
//! Loudness is measured here for the same reason: someone far away across the
//! map is quiet, someone screaming in your ear is not, and captions that
//! shrink, grow and shake to match are the difference between a transcript and
//! something worth watching.
//!
//! Deliberately a separate ffmpeg pass from the one that feeds whisper: that
//! one downmixes to mono (whisper needs mono) and runs dynaudnorm, which
//! normalises away loudness differences and adjusts channels in ways that
//! would muddy both measurements taken here.

use std::io::Read;
use std::process::Stdio;

use crate::sidecar;

const SAMPLE_RATE: usize = 16_000;
/// Pan is averaged over windows this long. Short enough to follow someone
/// moving, long enough not to swing wildly on individual syllables.
const WINDOW_SEC: f64 = 0.25;
/// Below this RMS a window is treated as having no usable pan at all rather
/// than reporting the pan of room tone.
const SILENCE_FLOOR: f32 = 0.01;

/// What the audio was doing across one span of speech.
#[derive(Debug, Clone, Copy)]
pub struct SpanAudio {
    /// -1 (hard left) to +1 (hard right); 0 when the source is mono.
    pub pan: f32,
    /// 0 (the quietest speech in this clip) to 1 (the loudest). Relative to
    /// the clip's own range rather than an absolute dB level, so it means the
    /// same thing whatever the recording gain was.
    pub intensity: f32,
}

pub struct PanTrack {
    /// Seconds per window.
    step: f64,
    /// (pan in -1..1, energy) per window; pan is NaN where the window was
    /// below the silence floor.
    windows: Vec<(f32, f32)>,
    /// False for mono sources, where L and R are identical and there is no
    /// position to report.
    stereo: bool,
    /// Energies that intensity 0 and 1 map to — the 10th and 90th percentile
    /// of non-silent windows. Percentiles rather than min/max so one clipped
    /// spike or one near-silent window doesn't flatten everything else into
    /// the middle of the range.
    quiet: f32,
    loud: f32,
}

impl PanTrack {
    /// Energy-weighted mean pan across `[start, end)`, or None when that span
    /// is silent, out of range, or the source wasn't stereo.
    ///
    /// Weighting by energy matters: a span that is mostly silence with one
    /// loud panned shout should report the shout's position, not an average
    /// dragged toward centre by near-silent windows that barely register.
    /// Pan and intensity for `[start, end)`, or None when that span is
    /// silent or out of range.
    pub fn span_for(&self, start: f64, end: f64) -> Option<SpanAudio> {
        let pan = self.pan_for_span(start, end);
        let intensity = self.intensity_for_span(start, end)?;
        Some(SpanAudio {
            pan: if self.stereo { pan.unwrap_or(0.0) } else { 0.0 },
            intensity,
        })
    }

    /// Energy-weighted mean loudness across `[start, end)`, normalised into
    /// 0..1 against the clip's own quiet/loud range.
    fn intensity_for_span(&self, start: f64, end: f64) -> Option<f32> {
        if self.step <= 0.0 || end <= start {
            return None;
        }
        let first = (start / self.step).floor().max(0.0) as usize;
        let last = ((end / self.step).ceil() as usize).min(self.windows.len());
        let slice = self.windows.get(first..last)?;
        // The loudest window, not the mean: a scream inside an otherwise
        // ordinary line is the thing worth reacting to, and averaging it
        // against the calm words around it is exactly how you lose it.
        let peak = slice
            .iter()
            .filter(|(p, _)| !p.is_nan()) // NaN pan marks a below-the-floor window
            .map(|(_, e)| *e)
            .fold(f32::NAN, f32::max);
        if peak.is_nan() || peak <= 0.0 {
            return None;
        }
        let span = (self.loud - self.quiet).max(1e-6);
        Some(((peak - self.quiet) / span).clamp(0.0, 1.0))
    }

    pub fn pan_for_span(&self, start: f64, end: f64) -> Option<f32> {
        if self.step <= 0.0 || end <= start {
            return None;
        }
        let first = (start / self.step).floor().max(0.0) as usize;
        let last = ((end / self.step).ceil() as usize).min(self.windows.len());
        let mut sum = 0.0f64;
        let mut weight = 0.0f64;
        for (pan, energy) in self.windows.get(first..last)?.iter() {
            if pan.is_nan() {
                continue;
            }
            sum += (*pan as f64) * (*energy as f64);
            weight += *energy as f64;
        }
        if weight <= 0.0 {
            return None;
        }
        Some((sum / weight) as f32)
    }
}

/// Decodes the (optionally range-limited) audio as raw stereo and measures its
/// pan over time. Returns None for mono sources or any ffmpeg failure —
/// spatial captions are an enhancement and must never block a transcript.
pub fn analyze(path: &str, start: Option<f64>, end: Option<f64>) -> Option<PanTrack> {
    let offset = start.unwrap_or(0.0).max(0.0);
    let mut cmd = sidecar::command("ffmpeg");
    cmd.arg("-v").arg("error");
    if offset > 0.0 {
        cmd.args(["-ss", &format!("{offset:.3}")]);
    }
    cmd.args(["-i", path]);
    if let Some(end) = end {
        cmd.args(["-t", &format!("{:.3}", (end - offset).max(0.1))]);
    }
    let mut child = cmd
        .args([
            "-vn",
            "-ac",
            "2",
            "-ar",
            &SAMPLE_RATE.to_string(),
            "-f",
            "s16le",
            "-",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    let mut raw = Vec::new();
    child.stdout.as_mut()?.read_to_end(&mut raw).ok()?;
    let _ = child.wait();

    let frames = raw.len() / 4; // 2 channels * 2 bytes
    if frames == 0 {
        return None;
    }

    let per_window = (WINDOW_SEC * SAMPLE_RATE as f64) as usize;
    let mut windows = Vec::with_capacity(frames / per_window + 1);
    let mut i = 0usize;
    while i < frames {
        let stop = (i + per_window).min(frames);
        let (mut l_sq, mut r_sq) = (0f64, 0f64);
        for f in i..stop {
            let b = f * 4;
            let l = i16::from_le_bytes([raw[b], raw[b + 1]]) as f64 / 32768.0;
            let r = i16::from_le_bytes([raw[b + 2], raw[b + 3]]) as f64 / 32768.0;
            l_sq += l * l;
            r_sq += r * r;
        }
        let n = (stop - i) as f64;
        let l = (l_sq / n).sqrt() as f32;
        let r = (r_sq / n).sqrt() as f32;
        let energy = (l + r) / 2.0;
        let pan = if l + r > SILENCE_FLOOR * 2.0 {
            (r - l) / (r + l)
        } else {
            f32::NAN
        };
        windows.push((pan, energy));
        i = stop;
    }

    // A mono file decoded to two channels has identical L and R, so every
    // window reads as dead centre. The track is still useful — loudness
    // works fine on mono — but there is no position to follow, so say so
    // rather than reporting a confident 0.0 pan for everything.
    let stereo = windows
        .iter()
        .filter(|(p, _)| !p.is_nan())
        .any(|(p, _)| p.abs() >= 0.001);

    let mut levels: Vec<f32> = windows
        .iter()
        .filter(|(_, e)| *e > SILENCE_FLOOR)
        .map(|(_, e)| *e)
        .collect();
    if levels.is_empty() {
        return None; // nothing audible anywhere
    }
    levels.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let pct = |p: f64| levels[((levels.len() - 1) as f64 * p).round() as usize];

    Some(PanTrack {
        step: WINDOW_SEC,
        windows,
        stereo,
        quiet: pct(0.10),
        loud: pct(0.90),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(windows: Vec<(f32, f32)>) -> PanTrack {
        PanTrack { step: 0.25, windows, stereo: true, quiet: 0.0, loud: 1.0 }
    }

    #[test]
    fn averages_pan_across_the_span() {
        let t = track(vec![(-0.5, 1.0), (-0.5, 1.0), (0.5, 1.0), (0.5, 1.0)]);
        assert!((t.pan_for_span(0.0, 1.0).unwrap() - 0.0).abs() < 1e-6);
        assert!((t.pan_for_span(0.0, 0.5).unwrap() + 0.5).abs() < 1e-6);
    }

    #[test]
    fn a_loud_shout_outweighs_near_silence_around_it() {
        // Without energy weighting this would average to about +0.1 and the
        // caption would sit near the middle instead of hard right where the
        // only thing actually audible is.
        let t = track(vec![(-0.2, 0.01), (0.9, 1.0), (-0.2, 0.01)]);
        assert!(t.pan_for_span(0.0, 0.75).unwrap() > 0.8);
    }

    #[test]
    fn silent_spans_have_no_pan() {
        let t = track(vec![(f32::NAN, 0.0), (f32::NAN, 0.0)]);
        assert!(t.pan_for_span(0.0, 0.5).is_none());
    }

    #[test]
    fn intensity_tracks_the_loudest_moment_in_the_span() {
        let t = track(vec![(0.0, 0.1), (0.0, 0.95), (0.0, 0.1)]);
        let a = t.span_for(0.0, 0.75).unwrap();
        assert!(a.intensity > 0.9, "a scream mid-sentence should read loud: {}", a.intensity);

        let quiet = track(vec![(0.0, 0.05), (0.0, 0.05)]);
        assert!(quiet.span_for(0.0, 0.5).unwrap().intensity < 0.1);
    }

    #[test]
    fn mono_sources_report_no_position_but_still_report_loudness() {
        let mut t = track(vec![(0.0, 0.8), (0.0, 0.8)]);
        t.stereo = false;
        let a = t.span_for(0.0, 0.5).unwrap();
        assert_eq!(a.pan, 0.0);
        assert!(a.intensity > 0.5);
    }

    #[test]
    fn out_of_range_spans_do_not_panic() {
        let t = track(vec![(0.5, 1.0)]);
        assert!(t.pan_for_span(90.0, 95.0).is_none());
        assert!(t.pan_for_span(0.0, 0.0).is_none());
        assert!(t.span_for(90.0, 95.0).is_none());
    }
}

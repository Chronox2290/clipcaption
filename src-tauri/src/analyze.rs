//! Highlight detection: scan the whole VOD's audio for excitement
//! (sustained loudness spikes relative to the local baseline) and return
//! ranked clip windows. Cheap first pass — transcription then only runs on
//! the windows the user keeps.

use serde::Serialize;
use std::io::Read;
use std::process::Stdio;
use std::sync::Arc;
use tauri::AppHandle;

use crate::jobs::{emit_done, emit_error, emit_progress, JobHandle};
use crate::media;
use crate::sidecar;

/// 100 ms analysis frames at 16 kHz mono s16le
const SAMPLE_RATE: usize = 16_000;
const FRAME_SAMPLES: usize = SAMPLE_RATE / 10;
const FRAME_SEC: f64 = 0.1;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Highlight {
    pub start: f64,
    pub end: f64,
    pub peak: f64,
    pub score: f64,
    pub rank: u32,
}

pub fn run(app: AppHandle, job_id: String, handle: Arc<JobHandle>, path: String, max_count: usize) {
    match run_inner(&app, &job_id, &handle, &path, max_count) {
        Ok(json) => emit_done(&app, &job_id, "analyzing", Some(json)),
        Err(e) => {
            if handle.is_cancelled() {
                emit_error(&app, &job_id, "analyzing", "Cancelled".into());
            } else {
                emit_error(&app, &job_id, "analyzing", e);
            }
        }
    }
}

fn run_inner(
    app: &AppHandle,
    job_id: &str,
    handle: &Arc<JobHandle>,
    path: &str,
    max_count: usize,
) -> Result<String, String> {
    let info = media::probe(path)?;
    let duration = info.duration_sec;
    if duration < 30.0 {
        return Err("Clip is too short for highlight detection — just caption it directly.".into());
    }

    emit_progress(app, job_id, "analyzing", 0.0, Some("scanning audio".into()));

    // Stream mono 16 kHz PCM straight out of ffmpeg — no temp WAV on disk.
    let mut child = sidecar::command("ffmpeg")
        .args([
            "-v", "error",
            "-i", path,
            "-vn",
            "-ac", "1",
            "-ar", "16000",
            "-f", "s16le",
            "pipe:1",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Could not run ffmpeg: {e}"))?;

    let mut stdout = child.stdout.take().ok_or("no ffmpeg stdout")?;
    handle.set_child(child);

    let expected_frames = (duration / FRAME_SEC) as usize;
    let mut rms: Vec<f32> = Vec::with_capacity(expected_frames + 16);

    let mut buf = vec![0u8; FRAME_SAMPLES * 2];
    let mut filled = 0usize;
    let mut last_emit = 0usize;

    loop {
        if handle.is_cancelled() {
            return Err("Cancelled".into());
        }
        let n = stdout.read(&mut buf[filled..]).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        filled += n;
        if filled == buf.len() {
            rms.push(frame_rms(&buf));
            filled = 0;
            if rms.len() - last_emit >= 600 {
                last_emit = rms.len();
                let p = (rms.len() as f32 / expected_frames.max(1) as f32).min(0.95);
                emit_progress(app, job_id, "analyzing", p, Some("scanning audio".into()));
            }
        }
    }
    if filled >= 2 {
        rms.push(frame_rms(&buf[..filled - (filled % 2)]));
    }

    let status = {
        let mut guard = handle.child.lock().unwrap();
        match guard.as_mut() {
            Some(child) => child.wait().map_err(|e| e.to_string())?,
            None => return Err("Cancelled".into()),
        }
    };
    handle.clear_child();
    if !status.success() {
        return Err("ffmpeg failed while reading audio".into());
    }

    emit_progress(app, job_id, "analyzing", 0.97, Some("finding highlights".into()));

    let highlights = detect_highlights(&rms, duration, max_count);
    serde_json::to_string(&highlights).map_err(|e| e.to_string())
}

fn frame_rms(bytes: &[u8]) -> f32 {
    let mut sum = 0.0f64;
    let n = bytes.len() / 2;
    if n == 0 {
        return 0.0;
    }
    for chunk in bytes.chunks_exact(2) {
        let s = i16::from_le_bytes([chunk[0], chunk[1]]) as f64 / 32768.0;
        sum += s * s;
    }
    ((sum / n as f64).sqrt()) as f32
}

/// Pure detection logic (unit-tested): RMS frames -> ranked highlight windows.
pub fn detect_highlights(rms: &[f32], duration: f64, max_count: usize) -> Vec<Highlight> {
    if rms.len() < 300 {
        return Vec::new();
    }

    // 1. Smooth the envelope over ~0.5 s
    let smooth = moving_avg(rms, 5);

    // 2. Excitement score: z-score against a rolling ±60 s baseline.
    //    The baseline is computed on a percentile-clipped copy of the signal so
    //    a loud sustained burst cannot inflate its own baseline and hide itself,
    //    and a global std floor stops dead-quiet sections from over-amplifying
    //    tiny noises.
    let p90 = percentile(&smooth, 0.90);
    let clipped: Vec<f32> = smooth.iter().map(|&v| v.min(p90)).collect();
    let z = rolling_z(&smooth, &clipped, 600);

    // 3. Sustained excitement over ~1.2 s (a single loud frame is not a highlight)
    let sustained = moving_avg(&z, 12);

    // 4. Group frames above threshold into regions (gaps < 5 s merge)
    const THRESHOLD: f32 = 1.6;
    const MERGE_GAP_FRAMES: usize = 50;
    let mut regions: Vec<(usize, usize, f32)> = Vec::new(); // (start, end, peak_z)
    let mut cur: Option<(usize, usize, f32)> = None;
    let mut gap = 0usize;

    for (i, &v) in sustained.iter().enumerate() {
        if v >= THRESHOLD {
            match cur.as_mut() {
                Some(r) => {
                    r.1 = i;
                    r.2 = r.2.max(v);
                }
                None => cur = Some((i, i, v)),
            }
            gap = 0;
        } else if let Some(r) = cur {
            gap += 1;
            if gap > MERGE_GAP_FRAMES {
                regions.push(r);
                cur = None;
                gap = 0;
            }
        }
    }
    if let Some(r) = cur {
        regions.push(r);
    }

    // drop blips: excitement must last at least ~0.8 s to count
    regions.retain(|r| r.1 - r.0 >= 8);

    // 5. Score = peak excitement + a bonus for how long it stayed exciting
    let mut scored: Vec<(f64, f64, f64, f64)> = regions
        .iter()
        .map(|&(s, e, peak)| {
            let dur_frames = (e - s + 1) as f32;
            let score = peak + (dur_frames / 10.0).sqrt().min(3.0);
            // find peak frame position within region
            let peak_idx = (s..=e)
                .max_by(|&a, &b| sustained[a].partial_cmp(&sustained[b]).unwrap())
                .unwrap_or(s);
            (
                s as f64 * FRAME_SEC,
                e as f64 * FRAME_SEC,
                peak_idx as f64 * FRAME_SEC,
                score as f64,
            )
        })
        .collect();

    scored.sort_by(|a, b| b.3.partial_cmp(&a.3).unwrap());
    scored.truncate(max_count.max(1));
    scored.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());

    // 6. Expand into clip windows: pre-roll for context, post-roll for payoff
    const PRE_ROLL: f64 = 6.0;
    const POST_ROLL: f64 = 4.0;
    const MIN_LEN: f64 = 8.0;
    const MAX_LEN: f64 = 75.0;

    let mut out: Vec<Highlight> = Vec::new();
    for (i, &(rs, re, peak, score)) in scored.iter().enumerate() {
        let mut start = (rs - PRE_ROLL).max(0.0);
        let mut end = (re + POST_ROLL).min(duration);
        if end - start < MIN_LEN {
            let need = MIN_LEN - (end - start);
            start = (start - need / 2.0).max(0.0);
            end = (end + need / 2.0).min(duration);
        }
        if end - start > MAX_LEN {
            // keep the window centered on the peak
            start = (peak - MAX_LEN * 0.4).max(0.0);
            end = (start + MAX_LEN).min(duration);
        }
        // merge with previous window if overlapping
        if let Some(prev) = out.last_mut() {
            if start < prev.end {
                prev.end = end.max(prev.end);
                prev.score = prev.score.max(score);
                continue;
            }
        }
        out.push(Highlight {
            start,
            end,
            peak,
            score,
            rank: i as u32 + 1,
        });
    }

    // re-rank by score
    let mut by_score: Vec<usize> = (0..out.len()).collect();
    by_score.sort_by(|&a, &b| out[b].score.partial_cmp(&out[a].score).unwrap());
    for (rank, idx) in by_score.into_iter().enumerate() {
        out[idx].rank = rank as u32 + 1;
    }

    out
}

fn moving_avg(data: &[f32], half: usize) -> Vec<f32> {
    let n = data.len();
    let mut prefix = vec![0.0f64; n + 1];
    for i in 0..n {
        prefix[i + 1] = prefix[i] + data[i] as f64;
    }
    (0..n)
        .map(|i| {
            let a = i.saturating_sub(half);
            let b = (i + half + 1).min(n);
            ((prefix[b] - prefix[a]) / (b - a) as f64) as f32
        })
        .collect()
}

fn percentile(data: &[f32], p: f32) -> f32 {
    let mut sorted: Vec<f32> = data.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let idx = ((sorted.len() as f32 - 1.0) * p) as usize;
    sorted[idx]
}

/// z-score of `data` against rolling mean/std computed over `baseline_src`.
fn rolling_z(data: &[f32], baseline_src: &[f32], half: usize) -> Vec<f32> {
    let n = data.len();
    let mut prefix = vec![0.0f64; n + 1];
    let mut prefix2 = vec![0.0f64; n + 1];
    for i in 0..n {
        let v = baseline_src[i] as f64;
        prefix[i + 1] = prefix[i] + v;
        prefix2[i + 1] = prefix2[i] + v * v;
    }
    // global std as a floor so silent stretches don't over-amplify noise
    let g_cnt = n as f64;
    let g_mean = prefix[n] / g_cnt;
    let g_var = (prefix2[n] / g_cnt - g_mean * g_mean).max(1e-12);
    let std_floor = (g_var.sqrt() * 0.5).max(1e-6);

    (0..n)
        .map(|i| {
            let a = i.saturating_sub(half);
            let b = (i + half + 1).min(n);
            let cnt = (b - a) as f64;
            let mean = (prefix[b] - prefix[a]) / cnt;
            let var = ((prefix2[b] - prefix2[a]) / cnt - mean * mean).max(1e-12);
            let std = var.sqrt().max(std_floor);
            (((data[i] as f64) - mean) / std) as f32
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn synthetic(duration_sec: usize, bursts: &[(usize, usize, f32)]) -> Vec<f32> {
        // quiet base with mild noise + loud bursts (start_sec, len_sec, level)
        let frames = duration_sec * 10;
        let mut rms = vec![0.05f32; frames];
        for i in 0..frames {
            rms[i] += 0.01 * ((i as f32 * 0.7).sin().abs());
        }
        for &(start, len, level) in bursts {
            for i in start * 10..((start + len) * 10).min(frames) {
                rms[i] = level;
            }
        }
        rms
    }


    #[test]
    fn finds_loud_bursts() {
        // 10 min "vod" with three shouting moments
        let rms = synthetic(600, &[(100, 4, 0.5), (300, 6, 0.6), (500, 3, 0.45)]);
        let hl = detect_highlights(&rms, 600.0, 10);
        assert_eq!(hl.len(), 3, "expected 3 highlights, got {:?}", hl);
        // windows should contain the bursts
        assert!(hl[0].start <= 100.0 && hl[0].end >= 104.0);
        assert!(hl[1].start <= 300.0 && hl[1].end >= 306.0);
        assert!(hl[2].start <= 500.0 && hl[2].end >= 503.0);
        // the longest/loudest burst should be rank 1
        let best = hl.iter().find(|h| h.rank == 1).unwrap();
        assert!(best.start <= 300.0 && best.end >= 306.0);
    }

    #[test]
    fn quiet_audio_returns_nothing_big() {
        let rms = synthetic(600, &[]);
        let hl = detect_highlights(&rms, 600.0, 10);
        assert!(
            hl.len() <= 2,
            "flat audio should produce few/no highlights, got {}",
            hl.len()
        );
    }

    #[test]
    fn respects_max_count() {
        let bursts: Vec<(usize, usize, f32)> =
            (0..20).map(|i| (30 + i * 25, 3, 0.5f32)).collect();
        let rms = synthetic(600, &bursts);
        let hl = detect_highlights(&rms, 600.0, 5);
        assert!(hl.len() <= 5);
    }

    #[test]
    fn window_lengths_clamped() {
        let rms = synthetic(600, &[(200, 120, 0.5)]); // 2-minute sustained loudness
        let hl = detect_highlights(&rms, 600.0, 10);
        for h in &hl {
            assert!(h.end - h.start <= 75.5, "window too long: {:?}", h);
            assert!(h.end - h.start >= 7.5, "window too short: {:?}", h);
        }
    }
}

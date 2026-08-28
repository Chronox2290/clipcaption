//! Motion-based "smart" auto-reframe: instead of the static center-crop
//! `fit_mode: "fill"` already does when forcing a wide source into a
//! narrower export (9:16 vertical, etc.), tracks where the on-screen action
//! actually is horizontally and pans the crop window to follow it.
//!
//! No bundled face/object-detection model exists in this app (adding one is
//! its own real bundling decision, not made here - see CLAUDE-CODE-BRIEF's
//! own framing of that trade-off elsewhere for audio separation). This is
//! classical motion-saliency (frame-to-frame pixel differencing, weighted by
//! column position), not deep tracking - genuinely better than a fixed
//! center-crop for gameplay where the action is often off-center, but it
//! follows MOTION specifically, not necessarily "the important thing": a
//! flashing UI element or a moving background can pull it just as much as
//! real gameplay action. Honest about that limit rather than overselling it
//! as face/object tracking.

use std::io::Read;
use std::path::PathBuf;
use std::process::Stdio;

use crate::sidecar;

/// Everything export.rs's filter_and_map_args needs to build the "track"
/// crop - assembled by run_single_source (probe + analysis + writing the
/// sendcmd file, all of which need I/O) and handed in, since
/// filter_and_map_args itself stays a pure command-string builder.
pub(crate) struct TrackConfig {
    pub sendcmd_path: PathBuf,
    pub crop_w: u32,
    pub src_h: u32,
}

/// Small and cheap on purpose - this decodes the WHOLE clip to analyze it,
/// so the per-frame cost has to stay negligible next to the real encode
/// that follows. 80x45 is plenty of resolution for a coarse "where's the
/// motion, left or right" read; nothing here needs to resolve fine detail.
const SAMPLE_W: u32 = 80;
const SAMPLE_H: u32 = 45;
const SAMPLE_FPS: f64 = 4.0;
/// Exponential smoothing factor for the raw per-frame motion centroid - low
/// so the crop pans smoothly rather than snapping/jittering with every
/// noisy frame-to-frame difference. Higher = more responsive but jerkier.
const SMOOTHING_ALPHA: f64 = 0.15;
/// Below this much total per-frame pixel-difference, treat the frame as
/// essentially static (a menu, a black loading screen, genuine stillness) -
/// not a real motion signal worth trusting, so hold the last smoothed
/// position instead of drifting toward whatever noise happens to sum
/// highest in a near-empty diff.
const MOTION_FLOOR: u64 = 200;

/// Column-band motion energy between two same-sized grayscale frames,
/// reduced to a single horizontal centroid (0..1, fraction of width) - None
/// when the total difference is at or below MOTION_FLOOR, i.e. there's no
/// real motion signal worth trusting (also avoids a divide-by-zero on two
/// identical frames). Split out from analyze_pan's decode loop so this pure
/// math is directly unit-testable without spawning ffmpeg.
fn motion_centroid(prev: &[u8], cur: &[u8], w: u32, h: u32) -> Option<f64> {
    let mut col_energy = vec![0u32; w as usize];
    let mut total = 0u64;
    for y in 0..h as usize {
        for x in 0..w as usize {
            let i = y * w as usize + x;
            let d = (cur[i] as i32 - prev[i] as i32).unsigned_abs();
            col_energy[x] += d;
            total += d as u64;
        }
    }
    if total <= MOTION_FLOOR {
        return None;
    }
    let weighted: f64 = col_energy
        .iter()
        .enumerate()
        .map(|(x, &e)| (x as f64 + 0.5) * e as f64)
        .sum();
    Some(weighted / total as f64 / w as f64)
}

pub struct PanSample {
    pub t: f64,
    /// Smoothed horizontal center of motion, as a fraction (0..1) of the
    /// source's own width - resolution-independent on purpose, so this
    /// works the same whether the crop happens at native resolution or
    /// after a scale step.
    pub center_frac: f64,
}

/// Decodes `video_path` at a small size/low frame rate and computes a
/// smoothed horizontal motion-centroid track across the whole clip. Cheap:
/// SAMPLE_W*SAMPLE_H bytes/frame at SAMPLE_FPS means even a several-minute
/// clip is a few MB of raw pixels total, not a real decode cost next to the
/// encode that follows it.
pub fn analyze_pan(video_path: &str) -> Result<Vec<PanSample>, String> {
    let mut child = sidecar::command("ffmpeg")
        .args([
            "-v",
            "error",
            "-i",
            video_path,
            "-vf",
            &format!("fps={SAMPLE_FPS},scale={SAMPLE_W}:{SAMPLE_H}"),
            "-f",
            "rawvideo",
            "-pix_fmt",
            "gray",
            "pipe:1",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Could not run ffmpeg: {e}"))?;

    let mut out = child.stdout.take().ok_or("ffmpeg gave no stdout")?;
    let frame_bytes = (SAMPLE_W * SAMPLE_H) as usize;
    let mut buf = vec![0u8; frame_bytes];
    let mut prev: Option<Vec<u8>> = None;
    let mut samples: Vec<PanSample> = Vec::new();
    // Starts centered so a clip that opens on a static frame doesn't pan
    // toward an arbitrary edge before any real motion has been seen.
    let mut smoothed = 0.5_f64;
    let mut idx = 0u64;

    loop {
        if out.read_exact(&mut buf).is_err() {
            break; // EOF (or a short final read) - not an error, just done
        }
        if let Some(prev_frame) = &prev {
            if let Some(raw_center) = motion_centroid(prev_frame, &buf, SAMPLE_W, SAMPLE_H) {
                smoothed = SMOOTHING_ALPHA * raw_center + (1.0 - SMOOTHING_ALPHA) * smoothed;
            }
            samples.push(PanSample {
                t: idx as f64 / SAMPLE_FPS,
                center_frac: smoothed,
            });
        }
        prev = Some(buf.clone());
        idx += 1;
    }
    let _ = child.wait();
    Ok(samples)
}

/// Builds a `sendcmd` script (see ffmpeg's sendcmd filter) driving a crop
/// filter instance named `panner`'s `x` parameter over time, so the crop
/// window pans to follow `samples`' tracked motion instead of sitting at a
/// fixed center. Clamped so the window never runs past either edge of the
/// source frame. `src_w`/`crop_w` are in the SAME coordinate space the crop
/// filter itself operates in (the original decoded source, not any later
/// scale step - see reframe integration in export.rs for why crop happens
/// before scale specifically).
pub fn build_sendcmd_script(samples: &[PanSample], src_w: u32, crop_w: u32) -> String {
    let max_x = src_w.saturating_sub(crop_w) as f64;
    let mut out = String::new();
    for s in samples {
        let x = (s.center_frac * src_w as f64 - crop_w as f64 / 2.0).clamp(0.0, max_x);
        out.push_str(&format!("{:.3} crop@panner x '{}';\n", s.t, x.round() as i64));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(t: f64, frac: f64) -> PanSample {
        PanSample { t, center_frac: frac }
    }

    #[test]
    fn centers_the_crop_window_on_the_tracked_fraction() {
        // src 1000px wide, crop window 400px - centroid at the exact middle
        // (0.5) should put the window's left edge at 300 (300..700).
        let script = build_sendcmd_script(&[sample(0.0, 0.5)], 1000, 400);
        assert!(script.contains("0.000 crop@panner x '300';"), "{script}");
    }

    #[test]
    fn clamps_to_the_left_edge_rather_than_going_negative() {
        // centroid all the way at the left (0.0) would put x at -200 unclamped.
        let script = build_sendcmd_script(&[sample(0.0, 0.0)], 1000, 400);
        assert!(script.contains("0.000 crop@panner x '0';"), "{script}");
    }

    #[test]
    fn clamps_to_the_right_edge_rather_than_overflowing_the_source() {
        // centroid all the way at the right (1.0) would put x at 800,
        // right edge would be 1200 - past the 1000px source. Max valid x
        // is src_w - crop_w = 600.
        let script = build_sendcmd_script(&[sample(0.0, 1.0)], 1000, 400);
        assert!(script.contains("0.000 crop@panner x '600';"), "{script}");
    }

    #[test]
    fn a_crop_as_wide_as_the_source_never_has_anywhere_to_pan() {
        let script = build_sendcmd_script(&[sample(0.0, 0.9), sample(1.0, 0.1)], 400, 400);
        let lines: Vec<&str> = script.lines().collect();
        assert_eq!(lines.len(), 2, "expected both samples to produce a line: {script}");
        for line in &lines {
            assert!(line.ends_with("x '0';"), "expected every line clamped to 0: {line}");
        }
    }

    #[test]
    fn multiple_samples_each_get_their_own_timestamped_command() {
        let script = build_sendcmd_script(&[sample(0.0, 0.5), sample(0.25, 0.5)], 1000, 400);
        let lines: Vec<&str> = script.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].starts_with("0.000 "), "{}", lines[0]);
        assert!(lines[1].starts_with("0.250 "), "{}", lines[1]);
    }

    #[test]
    fn identical_frames_produce_no_motion_signal() {
        // Must not divide by zero or panic on two frames with zero diff.
        let frame = vec![0u8; (SAMPLE_W * SAMPLE_H) as usize];
        assert_eq!(motion_centroid(&frame, &frame, SAMPLE_W, SAMPLE_H), None);
    }

    #[test]
    fn a_faint_difference_below_the_floor_is_still_ignored() {
        // A handful of pixels changing by 1 each (well under MOTION_FLOOR's
        // total) shouldn't be trusted as real motion either - camera noise
        // or compression artifacts, not gameplay action.
        let w = 10;
        let h = 10;
        let prev = vec![0u8; w * h];
        let mut cur = vec![0u8; w * h];
        cur[0] = 1;
        cur[1] = 1;
        assert_eq!(motion_centroid(&prev, &cur, w as u32, h as u32), None);
    }

    #[test]
    fn motion_concentrated_on_the_left_centers_there() {
        let w = 10u32;
        let h = 4u32;
        let prev = vec![0u8; (w * h) as usize];
        let mut cur = vec![0u8; (w * h) as usize];
        // Bright motion only in column 0, every row.
        for y in 0..h {
            cur[(y * w) as usize] = 255;
        }
        let center = motion_centroid(&prev, &cur, w, h).expect("should detect motion");
        assert!(center < 0.2, "expected a left-biased centroid, got {center}");
    }

    #[test]
    fn motion_concentrated_on_the_right_centers_there() {
        let w = 10u32;
        let h = 4u32;
        let prev = vec![0u8; (w * h) as usize];
        let mut cur = vec![0u8; (w * h) as usize];
        for y in 0..h {
            cur[(y * w + (w - 1)) as usize] = 255;
        }
        let center = motion_centroid(&prev, &cur, w, h).expect("should detect motion");
        assert!(center > 0.8, "expected a right-biased centroid, got {center}");
    }

    #[test]
    fn symmetric_motion_on_both_edges_centers_in_the_middle() {
        let w = 10u32;
        let h = 4u32;
        let prev = vec![0u8; (w * h) as usize];
        let mut cur = vec![0u8; (w * h) as usize];
        for y in 0..h {
            cur[(y * w) as usize] = 255;
            cur[(y * w + (w - 1)) as usize] = 255;
        }
        let center = motion_centroid(&prev, &cur, w, h).expect("should detect motion");
        assert!((center - 0.5).abs() < 0.05, "expected a centered centroid, got {center}");
    }

    /// Not run in CI: the bundled ffmpeg binary is gitignored (fetched via
    /// scripts/get-sidecars.ps1, not committed), same reason align.rs's
    /// real-model test is #[ignore]d. Run manually with
    /// `cargo test --no-default-features reframe:: -- --ignored` once
    /// sidecars are fetched, to sanity-check the real ffmpeg decode+diff
    /// pipeline end-to-end, not just the pure math above.
    #[test]
    #[ignore]
    fn tracks_a_real_left_to_right_pan_through_actual_ffmpeg() {
        let dir = std::env::temp_dir().join("cc_reframe_test");
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("pan.mp4");

        // A white square moving left (x=40) to right (x=1120) over 4s on a
        // 1280x720 black background - built via `overlay`'s own x expression
        // (drawbox's x expression silently produced nothing on this ffmpeg
        // build when checked by hand - overlay is the reliable technique).
        let status = sidecar::command("ffmpeg")
            .args([
                "-y", "-v", "error",
                "-f", "lavfi", "-i", "color=c=black:s=1280x720:d=4:r=10",
                "-f", "lavfi", "-i", "color=c=white:s=100x100:d=4:r=10",
                "-filter_complex", "[0][1]overlay=x='40+t*270':y=310",
                "-c:v", "libx264", "-pix_fmt", "yuv420p",
            ])
            .arg(&src)
            .status()
            .unwrap();
        assert!(status.success(), "failed to build the synthetic test clip");

        let samples = analyze_pan(&src.to_string_lossy()).unwrap();
        assert!(samples.len() > 5, "expected several samples across a 4s clip, got {}", samples.len());

        // Early samples should read left-of-center, late samples right-of-
        // center - confirms the smoothed centroid actually follows the
        // square's real motion rather than sitting flat or drifting the
        // wrong way. Not a tight bound - EMA smoothing (alpha=0.15) means
        // the very first samples lag behind the true position.
        let first = samples.first().unwrap().center_frac;
        let last = samples.last().unwrap().center_frac;
        assert!(first < 0.5, "expected the early centroid left of center, got {first}");
        assert!(last > 0.5, "expected the late centroid right of center, got {last}");
        assert!(last > first, "expected the centroid to move rightward over time: {first} -> {last}");

        let _ = std::fs::remove_dir_all(&dir);
    }
}

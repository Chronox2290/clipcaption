use serde::Deserialize;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use tauri::{AppHandle, Manager};

use crate::encoders;
use crate::jobs::{emit_done, emit_error, emit_progress, JobHandle};
use crate::sidecar;

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub input_path: String,
    pub output_path: String,
    pub ass_content: String,
    pub target_w: Option<u32>,
    pub target_h: Option<u32>,
    pub target_size_mb: Option<f64>,
    pub crf: Option<u32>,
    pub fps: Option<f64>,
    pub audio_kbps: u32,
    pub duration_sec: f64,
    /// Optional trim: cut this range out of the source before encoding.
    pub trim_start: Option<f64>,
    pub trim_end: Option<f64>,
    /// Optional multi-segment cut: several (start, end) ranges from the same
    /// source, concatenated in order into one output. Used to compile several
    /// selected highlights into a single file. Takes priority over
    /// trim_start/trim_end when present and non-empty.
    pub cut_ranges: Option<Vec<(f64, f64)>>,
    /// "auto" | "x264" | "nvenc" | "amf" | "qsv" (None = auto)
    pub encoder: Option<String>,
    /// How to reconcile source aspect ratio with a forced target_w/target_h:
    /// "fill" (default, hard center-crop) or "fit" (whole frame visible,
    /// letterboxed with a blurred zoomed copy of itself instead of black bars).
    /// Ignored when target_w/target_h aren't both set.
    #[serde(default)]
    pub fit_mode: Option<String>,
    /// Cap the output's height when target_w/target_h aren't set (i.e. no
    /// forced crop) — never upscales past the source's own resolution.
    #[serde(default)]
    pub max_height: Option<u32>,
}

impl ExportRequest {
    fn ranges(&self) -> Option<&[(f64, f64)]> {
        self.cut_ranges.as_deref().filter(|r| !r.is_empty())
    }

    /// Duration of the encoded output (after trimming/concatenating).
    fn effective_duration(&self) -> f64 {
        if let Some(ranges) = self.ranges() {
            return ranges.iter().map(|(s, e)| (e - s).max(0.0)).sum::<f64>().max(0.1);
        }
        match (self.trim_start, self.trim_end) {
            (Some(s), Some(e)) => (e - s).max(0.1),
            (Some(s), None) => (self.duration_sec - s).max(0.1),
            (None, Some(e)) => e.max(0.1),
            (None, None) => self.duration_sec,
        }
    }

    /// ffmpeg input args: the single trim (-ss before -i, -t after). Never
    /// called with cut_ranges present - run_inner resolves those into a
    /// joined temp file first and neutralizes cut_ranges before this or
    /// filter_and_map_args ever sees the request (see prepare_ranges_source).
    fn input_args(&self) -> Vec<String> {
        debug_assert!(self.ranges().is_none(), "input_args called with unresolved cut_ranges");
        let mut args: Vec<String> = vec!["-y".into()];
        if let Some(s) = self.trim_start {
            if s > 0.0 {
                args.extend(["-ss".into(), format!("{s:.3}")]);
            }
        }
        args.extend(["-i".into(), self.input_path.clone()]);
        if self.trim_end.is_some() || self.trim_start.is_some() {
            args.extend(["-t".into(), format!("{:.3}", self.effective_duration())]);
        }
        args
    }

    /// Builds the full "-filter_complex ... -map ... [-map ...]" args for this
    /// request: crop/"fit" letterboxing, the resolution cap, and subtitle
    /// burn-in as one filtergraph. Never called with cut_ranges present -
    /// see input_args's own doc comment for why.
    ///
    /// `include_audio`: false for the audio-less first pass of a 2-pass x264
    /// encode (run with -an) — a filtergraph output pad that's never consumed
    /// by a -map is a hard ffmpeg error, not a harmless no-op, so the audio
    /// stages must not be built at all in that case, not just left unmapped.
    fn filter_and_map_args(&self, ass_path: Option<&Path>, include_audio: bool) -> Vec<String> {
        debug_assert!(self.ranges().is_none(), "filter_and_map_args called with unresolved cut_ranges");
        let mut fc = String::new();
        let mut v_label = "0:v".to_string();

        // 1) Crop/fit into a forced target size, or just cap the resolution.
        if let (Some(w), Some(h)) = (self.target_w, self.target_h) {
            if !fc.is_empty() {
                fc.push(';');
            }
            if self.fit_mode.as_deref() == Some("fit") {
                // Whole frame visible ("zoomed out"): a blurred, cropped copy
                // of the same frame fills the background instead of black bars.
                fc.push_str(&format!(
                    "[{v_label}]split[vb0][vf0];\
                     [vb0]scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},gblur=sigma=20[vb1];\
                     [vf0]scale={w}:{h}:force_original_aspect_ratio=decrease[vf1];\
                     [vb1][vf1]overlay=(W-w)/2:(H-h)/2[vcrop]"
                ));
            } else {
                fc.push_str(&format!(
                    "[{v_label}]scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h}[vcrop]"
                ));
            }
            v_label = "vcrop".to_string();
        } else if let Some(mh) = self.max_height {
            if !fc.is_empty() {
                fc.push(';');
            }
            // min(ih,H) never upscales — a no-op once the source is already <= H.
            fc.push_str(&format!("[{v_label}]scale=-2:min(ih\\,{mh})[vres]"));
            v_label = "vres".to_string();
        }

        // 2) Burn in subtitles last, after any crop/scale.
        if let Some(ass) = ass_path {
            if !fc.is_empty() {
                fc.push(';');
            }
            fc.push_str(&format!(
                "[{v_label}]subtitles=filename='{}'[vout]",
                escape_filter_path(&ass.to_string_lossy())
            ));
            v_label = "vout".to_string();
        }

        if fc.is_empty() {
            // Nothing touched the video at all — let ffmpeg auto-map both
            // streams exactly as if no -filter_complex/-map were given.
            return vec![];
        }
        let mut args = vec!["-filter_complex".into(), fc, "-map".into(), format!("[{v_label}]")];
        if include_audio {
            // Audio is untouched by anything in this filtergraph - map the raw stream.
            args.extend(["-map".into(), "0:a".into()]);
        }
        args
    }
}

pub fn run(app: AppHandle, job_id: String, handle: Arc<JobHandle>, req: ExportRequest) {
    match run_inner(&app, &job_id, &handle, &req) {
        Ok(()) => emit_done(&app, &job_id, "exporting", Some(req.output_path.clone())),
        Err(e) => {
            if handle.is_cancelled() {
                emit_error(&app, &job_id, "exporting", "Cancelled".into());
            } else {
                emit_error(&app, &job_id, "exporting", e);
            }
        }
    }
}

/// The whole single-source encode pipeline (trim/concat, crop, resolution
/// cap, subtitle burn-in, quality- or size-targeted encode) as one reusable
/// step - `pub(crate)` so montage.rs can render each of a montage's clips
/// through the exact same, already-proven path instead of a second one.
pub(crate) fn run_inner(
    app: &AppHandle,
    job_id: &str,
    handle: &Arc<JobHandle>,
    req: &ExportRequest,
) -> Result<(), String> {
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("export");
    std::fs::create_dir_all(&cache).map_err(|e| e.to_string())?;

    // Multi-range requests (compiling several highlights into one file, a
    // reel) get their ranges resolved into one joined temp file FIRST, fast
    // and independent of the source's total length - see
    // prepare_ranges_source's own doc comment for why this replaced a
    // single-filtergraph approach that decoded almost the whole source for
    // a handful of short clips. Once resolved, everything below runs
    // exactly the single-source path it always has, just pointed at the
    // joined file instead of the original.
    let joined_source: Option<PathBuf> = if req.ranges().is_some() {
        Some(prepare_ranges_source(app, job_id, handle, req, &cache)?)
    } else {
        None
    };
    let owned_req;
    let req: &ExportRequest = if let Some(joined) = &joined_source {
        owned_req = ExportRequest {
            input_path: joined.to_string_lossy().into_owned(),
            // duration_sec must become the JOINED file's own duration, not
            // the original (possibly much longer) source's - effective_duration()
            // on the neutralized request below falls through to duration_sec
            // once cut_ranges is None, and the final pass's progress tracking
            // depends on this being right.
            duration_sec: req.effective_duration(),
            cut_ranges: None,
            ..req.clone()
        };
        &owned_req
    } else {
        req
    };
    let result = run_single_source(app, job_id, handle, req, &cache);

    if let Some(joined) = &joined_source {
        let _ = std::fs::remove_file(joined);
    }
    result
}

/// The single-source encode pipeline (crop/scale, resolution cap,
/// subtitle burn-in, quality- or size-targeted encode) - split out from
/// run_inner so the joined-temp-file cleanup above can run unconditionally
/// (success or error) without every early return inside here needing to
/// remember it separately.
fn run_single_source(
    app: &AppHandle,
    job_id: &str,
    handle: &Arc<JobHandle>,
    req: &ExportRequest,
    cache: &Path,
) -> Result<(), String> {
    // Write the .ass subtitle file if captions are being burned
    let ass_path: Option<PathBuf> = if req.ass_content.trim().is_empty() {
        None
    } else {
        let p = cache.join(format!("{job_id}.ass"));
        std::fs::write(&p, &req.ass_content).map_err(|e| e.to_string())?;
        Some(p)
    };

    let fps_str = req.fps.map(|f| format!("{f}"));
    let audio_bitrate = format!("{}k", req.audio_kbps);

    let out_duration = req.effective_duration();
    let encoder = encoders::resolve(req.encoder.as_deref());

    if let Some(target_mb) = req.target_size_mb {
        // ---- Target-size mode: two-pass x264 ----
        if out_duration <= 0.0 {
            return Err("Unknown clip duration — cannot compute target bitrate".into());
        }
        // 93% budget for video+audio, leave headroom for container overhead
        let total_kbits = target_mb * 8192.0 * 0.93;
        // clamp: below 100 kbps is unwatchable; above ~30 Mbps a short clip just
        // wastes space against a generous target (e.g. Nitro 500 MB), so the
        // file simply comes out smaller than the cap
        let video_kbps = ((total_kbits / out_duration) - req.audio_kbps as f64)
            .clamp(100.0, 30_000.0) as u64;

        if encoder != "x264" {
            // GPU encoders: single pass, size bounded by VBV (maxrate/bufsize)
            let mut args: Vec<String> = req.input_args();
            args.extend(req.filter_and_map_args(ass_path.as_deref(), true));
            if let Some(f) = &fps_str {
                args.extend(["-r".into(), f.clone()]);
            }
            args.extend(encoders::bitrate_args(&encoder, video_kbps));
            args.extend([
                "-pix_fmt".into(), "yuv420p".into(),
                "-c:a".into(), "aac".into(),
                "-b:a".into(), audio_bitrate.clone(),
                "-movflags".into(), "+faststart".into(),
                req.output_path.clone(),
            ]);
            run_ffmpeg(app, job_id, handle, &args, out_duration, 0.0, 1.0, "encoding (GPU)")?;
            if let Some(ass) = ass_path {
                let _ = std::fs::remove_file(ass);
            }
            return Ok(());
        }

        let passlog = cache.join(format!("{job_id}_2pass"));
        let passlog_s = passlog.to_string_lossy().to_string();
        let null_out = if cfg!(windows) { "NUL" } else { "/dev/null" };

        // Pass 1
        let mut args1: Vec<String> = req.input_args();
        args1.extend(req.filter_and_map_args(ass_path.as_deref(), false));
        if let Some(f) = &fps_str {
            args1.extend(["-r".into(), f.clone()]);
        }
        args1.extend([
            "-c:v".into(), "libx264".into(),
            "-preset".into(), "medium".into(),
            "-b:v".into(), format!("{video_kbps}k"),
            "-pix_fmt".into(), "yuv420p".into(),
            "-pass".into(), "1".into(),
            "-passlogfile".into(), passlog_s.clone(),
            "-an".into(),
            "-f".into(), "mp4".into(),
            null_out.into(),
        ]);
        run_ffmpeg(app, job_id, handle, &args1, out_duration, 0.0, 0.5, "pass 1/2")?;

        // Pass 2
        let mut args2: Vec<String> = req.input_args();
        args2.extend(req.filter_and_map_args(ass_path.as_deref(), true));
        if let Some(f) = &fps_str {
            args2.extend(["-r".into(), f.clone()]);
        }
        args2.extend([
            "-c:v".into(), "libx264".into(),
            "-preset".into(), "medium".into(),
            "-b:v".into(), format!("{video_kbps}k"),
            "-pix_fmt".into(), "yuv420p".into(),
            "-pass".into(), "2".into(),
            "-passlogfile".into(), passlog_s.clone(),
            "-c:a".into(), "aac".into(),
            "-b:a".into(), audio_bitrate.clone(),
            "-movflags".into(), "+faststart".into(),
            req.output_path.clone(),
        ]);
        run_ffmpeg(app, job_id, handle, &args2, out_duration, 0.5, 1.0, "pass 2/2")?;

        // clean pass logs
        for ext in ["log", "log.mbtree"] {
            let _ = std::fs::remove_file(format!("{passlog_s}-0.{ext}"));
        }
    } else {
        // ---- Quality (CRF) mode: single pass ----
        let crf = req.crf.unwrap_or(20);
        let mut args: Vec<String> = req.input_args();
        args.extend(req.filter_and_map_args(ass_path.as_deref(), true));
        if let Some(f) = &fps_str {
            args.extend(["-r".into(), f.clone()]);
        }
        args.extend(encoders::quality_args(&encoder, crf));
        args.extend([
            "-pix_fmt".into(), "yuv420p".into(),
            "-c:a".into(), "aac".into(),
            "-b:a".into(), audio_bitrate,
            "-movflags".into(), "+faststart".into(),
            req.output_path.clone(),
        ]);
        let label = if encoder == "x264" { "encoding" } else { "encoding (GPU)" };
        run_ffmpeg(app, job_id, handle, &args, out_duration, 0.0, 1.0, label)?;
    }

    if let Some(ass) = ass_path {
        let _ = std::fs::remove_file(ass);
    }
    Ok(())
}

/// Extracts each of req's cut_ranges to its own fast, frame-accurate temp
/// file (keyframe-accelerated seek + a short re-encode, NOT a filtergraph
/// trim off the original source), then joins them with the concat
/// demuxer. Returns the joined file's path.
///
/// Replaces an earlier approach that built one filter_complex trimming N
/// ranges out of a single decode of the ORIGINAL source - correct in
/// principle, but a real, reproduced problem in practice: ffmpeg's
/// filtergraph has to decode the source from frame 0 through the LAST cut
/// point in one sequential pass, so compiling a few short clips from late
/// in a long recording (a ~3-minute reel pulled from an 83-minute session,
/// in the case that surfaced this) forced it to decode nearly the whole
/// recording - confirmed to eventually stall outright (0% CPU, no
/// progress, for a full 15 seconds straight and almost certainly longer)
/// rather than just being slow. This approach's total work instead scales
/// with the SUM of the ranges' own durations, which is what a
/// reel/compilation actually needs.
fn prepare_ranges_source(
    app: &AppHandle,
    job_id: &str,
    handle: &Arc<JobHandle>,
    req: &ExportRequest,
    cache: &Path,
) -> Result<PathBuf, String> {
    let ranges = req
        .ranges()
        .ok_or("prepare_ranges_source called with no cut_ranges")?;
    let encoder = encoders::resolve(req.encoder.as_deref());
    let n = ranges.len();

    let mut part_paths: Vec<PathBuf> = Vec::with_capacity(n);
    let cleanup = |paths: &[PathBuf]| {
        for p in paths {
            let _ = std::fs::remove_file(p);
        }
    };

    for (i, &(start, end)) in ranges.iter().enumerate() {
        if handle.is_cancelled() {
            cleanup(&part_paths);
            return Err("Cancelled".into());
        }
        let part = cache.join(format!("{job_id}_range{i}.mp4"));
        let dur = (end - start).max(0.1);
        let args = range_extract_args(&req.input_path, start, dur, &encoder, &part.to_string_lossy());
        let p_from = i as f32 / n as f32 * 0.5; // extraction fills the first half of progress
        let p_to = (i + 1) as f32 / n as f32 * 0.5;
        if let Err(e) = run_ffmpeg(app, job_id, handle, &args, dur, p_from, p_to, "preparing clips") {
            cleanup(&part_paths);
            return Err(format!("Preparing clip {}/{} failed: {e}", i + 1, n));
        }
        part_paths.push(part);
    }

    let list_path = cache.join(format!("{job_id}_ranges_list.txt"));
    std::fs::write(&list_path, concat_list_content(&part_paths)).map_err(|e| e.to_string())?;

    let joined = cache.join(format!("{job_id}_joined.mp4"));
    let join_args = vec![
        "-y".to_string(),
        "-f".to_string(),
        "concat".to_string(),
        "-safe".to_string(),
        "0".to_string(),
        "-i".to_string(),
        list_path.to_string_lossy().into_owned(),
        "-c".to_string(),
        "copy".to_string(),
        joined.to_string_lossy().into_owned(),
    ];
    // A stream copy - fast enough not to need its own progress slice;
    // report it as the extraction half finishing out to completion.
    let join_result = run_ffmpeg(app, job_id, handle, &join_args, 0.0, 0.5, 0.5, "joining clips");

    cleanup(&part_paths);
    let _ = std::fs::remove_file(&list_path);
    join_result?;

    Ok(joined)
}

/// ffmpeg args for extracting one frame-accurate range: `-ss` before `-i`
/// for fast keyframe-accelerated seeking, then a short re-encode (not
/// `-c copy`) because stream-copy trimming can only cut on keyframes -
/// close enough for a rough preview, not for word-synced captions, which
/// need the cut to land exactly where the caller asked. CRF 16 keeps this
/// intermediate step visually lossless; the actual requested quality/
/// bitrate is applied once, in the final pass over the (short) joined
/// result, not duplicated here.
fn range_extract_args(input_path: &str, start: f64, dur: f64, encoder: &str, out_path: &str) -> Vec<String> {
    let mut args = vec![
        "-y".to_string(),
        "-ss".to_string(),
        format!("{start:.3}"),
        "-i".to_string(),
        input_path.to_string(),
        "-t".to_string(),
        format!("{dur:.3}"),
        "-avoid_negative_ts".to_string(),
        "make_zero".to_string(),
    ];
    args.extend(encoders::quality_args(encoder, 16));
    args.extend([
        "-pix_fmt".to_string(),
        "yuv420p".to_string(),
        "-c:a".to_string(),
        "aac".to_string(),
        "-b:a".to_string(),
        "192k".to_string(),
        out_path.to_string(),
    ]);
    args
}

/// ffmpeg concat-demuxer list file content: single-quoted paths, with an
/// embedded single quote escaped as '\'' - the format ffmpeg's own docs
/// specify for `-f concat`. Same escaping montage.rs already uses for the
/// same format.
fn concat_list_content(paths: &[PathBuf]) -> String {
    let mut out = String::new();
    for p in paths {
        let escaped = p.to_string_lossy().replace('\'', r"'\''");
        out.push_str(&format!("file '{escaped}'\n"));
    }
    out
}

/// Escape a path for use inside an ffmpeg filter argument.
fn escape_filter_path(path: &str) -> String {
    path.replace('\\', "/").replace(':', "\\:").replace('\'', "\\'")
}

fn run_ffmpeg(
    app: &AppHandle,
    job_id: &str,
    handle: &Arc<JobHandle>,
    args: &[String],
    duration: f64,
    p_from: f32,
    p_to: f32,
    stage_msg: &str,
) -> Result<(), String> {
    let mut cmd = sidecar::command("ffmpeg");
    cmd.args(["-progress", "pipe:1", "-nostats", "-loglevel", "error"]);
    cmd.args(args);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Could not run ffmpeg: {e}. Run scripts/get-sidecars.ps1 first."))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    handle.set_child(child);

    // capture stderr on a side thread for error reporting
    let err_buf = std::thread::spawn(move || {
        let mut buf = String::new();
        if let Some(stderr) = stderr {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                buf.push_str(&line);
                buf.push('\n');
                if buf.len() > 8000 {
                    buf.drain(..4000);
                }
            }
        }
        buf
    });

    if let Some(stdout) = stdout {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if handle.is_cancelled() {
                break;
            }
            let us: Option<f64> = line
                .strip_prefix("out_time_us=")
                .or_else(|| line.strip_prefix("out_time_ms="))
                .and_then(|v| v.trim().parse().ok());
            if let (Some(us), true) = (us, duration > 0.0) {
                let frac = ((us / 1_000_000.0) / duration).clamp(0.0, 1.0) as f32;
                emit_progress(
                    app,
                    job_id,
                    "exporting",
                    p_from + frac * (p_to - p_from),
                    Some(stage_msg.to_string()),
                );
            }
        }
    }

    let status = {
        let mut guard = handle.child.lock().unwrap();
        match guard.as_mut() {
            Some(child) => child.wait().map_err(|e| e.to_string())?,
            None => return Err("Cancelled".into()),
        }
    };
    handle.clear_child();

    if handle.is_cancelled() {
        return Err("Cancelled".into());
    }
    if !status.success() {
        let err = err_buf.join().unwrap_or_default();
        let last = err.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("unknown error");
        return Err(format!("ffmpeg failed: {last}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_req() -> ExportRequest {
        ExportRequest {
            input_path: "in.mp4".into(),
            output_path: "out.mp4".into(),
            ass_content: String::new(),
            target_w: None,
            target_h: None,
            target_size_mb: None,
            crf: Some(20),
            fps: None,
            audio_kbps: 160,
            duration_sec: 100.0,
            trim_start: None,
            trim_end: None,
            cut_ranges: None,
            encoder: None,
            fit_mode: None,
            max_height: None,
        }
    }

    #[test]
    fn cut_ranges_duration_sums_segments() {
        let mut req = base_req();
        req.cut_ranges = Some(vec![(10.0, 20.0), (50.0, 63.5)]);
        assert!((req.effective_duration() - 23.5).abs() < 1e-6);
    }

    #[test]
    fn single_trim_still_uses_ss_and_t() {
        let mut req = base_req();
        req.trim_start = Some(5.0);
        req.trim_end = Some(15.0);
        let args = req.input_args();
        assert_eq!(args, vec!["-y", "-ss", "5.000", "-i", "in.mp4", "-t", "10.000"]);
    }

    #[test]
    fn no_op_request_returns_no_filter_args() {
        let req = base_req();
        assert_eq!(req.filter_and_map_args(None, true), Vec::<String>::new());
    }

    #[test]
    fn empty_cut_ranges_vec_is_treated_as_absent() {
        let mut req = base_req();
        req.cut_ranges = Some(vec![]);
        assert_eq!(req.input_args(), vec!["-y", "-i", "in.mp4"]);
        assert_eq!(req.filter_and_map_args(None, true), Vec::<String>::new());
    }

    #[test]
    fn target_dims_fill_mode_builds_scale_and_crop() {
        let mut req = base_req();
        req.target_w = Some(1080);
        req.target_h = Some(1920);
        let args = req.filter_and_map_args(None, true);
        let fc = &args[1];
        assert!(fc.contains("[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920[vcrop]"));
        assert!(!fc.contains("gblur"), "fill mode must not blur: {fc}");
        assert_eq!(&args[2..], &["-map", "[vcrop]", "-map", "0:a"]);
    }

    #[test]
    fn target_dims_fit_mode_builds_blurred_overlay() {
        let mut req = base_req();
        req.target_w = Some(1080);
        req.target_h = Some(1920);
        req.fit_mode = Some("fit".into());
        let args = req.filter_and_map_args(None, true);
        let fc = &args[1];
        assert!(fc.contains("split[vb0][vf0]"), "fit mode must split into bg/fg: {fc}");
        assert!(fc.contains("gblur=sigma=20"), "fit mode's background must be blurred: {fc}");
        assert!(fc.contains("force_original_aspect_ratio=decrease"), "foreground must fit inside, not fill: {fc}");
        assert!(fc.contains("overlay=(W-w)/2:(H-h)/2[vcrop]"));
        assert_eq!(&args[2..], &["-map", "[vcrop]", "-map", "0:a"]);
    }

    #[test]
    fn max_height_caps_resolution_without_cropping() {
        let mut req = base_req();
        req.max_height = Some(720);
        let args = req.filter_and_map_args(None, true);
        let fc = &args[1];
        assert_eq!(fc, "[0:v]scale=-2:min(ih\\,720)[vres]");
        assert_eq!(&args[2..], &["-map", "[vres]", "-map", "0:a"]);
    }

    #[test]
    fn target_dims_take_priority_over_max_height() {
        let mut req = base_req();
        req.target_w = Some(1080);
        req.target_h = Some(1920);
        req.max_height = Some(720);
        let args = req.filter_and_map_args(None, true);
        let fc = &args[1];
        assert!(fc.contains("crop=1080:1920[vcrop]"));
        assert!(!fc.contains("[vres]"), "max_height must be ignored once target dims are set: {fc}");
    }

    #[test]
    fn subtitles_without_cut_ranges_burn_directly_on_source_stream() {
        let mut req = base_req();
        let args = req.filter_and_map_args(Some(Path::new("cap.ass")), true);
        assert_eq!(&args[1], "[0:v]subtitles=filename='cap.ass'[vout]");
        assert_eq!(&args[2..], &["-map", "[vout]", "-map", "0:a"]);
        req.max_height = Some(480); // sanity: chains after an earlier stage too
        let args2 = req.filter_and_map_args(Some(Path::new("cap.ass")), true);
        assert_eq!(&args2[1], "[0:v]scale=-2:min(ih\\,480)[vres];[vres]subtitles=filename='cap.ass'[vout]");
    }

    // ---- cut_ranges resolution (prepare_ranges_source and its pure helpers) ----
    //
    // prepare_ranges_source itself spawns real ffmpeg processes, so it isn't
    // unit-tested directly (same reasoning as run_ffmpeg above) - these cover
    // the pure argument/list-building it depends on, which is where a real
    // regression (a wrong seek, a malformed concat list) would actually show up.

    #[test]
    fn range_extract_args_seeks_before_input_for_fast_keyframe_seeking() {
        let args = range_extract_args("in.mp4", 12.5, 8.25, "x264", "part0.mp4");
        // -ss before -i, not after — this is what makes the seek fast
        // (keyframe-accelerated) instead of decoding from the start.
        let ss_pos = args.iter().position(|a| a == "-ss").unwrap();
        let i_pos = args.iter().position(|a| a == "-i").unwrap();
        assert!(ss_pos < i_pos, "-ss must come before -i: {args:?}");
        assert_eq!(args[ss_pos + 1], "12.500");
        assert_eq!(args[i_pos + 1], "in.mp4");
        let t_pos = args.iter().position(|a| a == "-t").unwrap();
        assert_eq!(args[t_pos + 1], "8.250");
        assert!(args.contains(&"part0.mp4".to_string()));
        // Not a stream copy: -c copy can only cut on keyframes, which would
        // desync word-synced captions at the cut point.
        assert!(!args.iter().any(|a| a == "copy"), "range extraction must re-encode, not stream-copy: {args:?}");
    }

    #[test]
    fn concat_list_content_quotes_paths_and_escapes_embedded_quotes() {
        let paths = vec![PathBuf::from("a.mp4"), PathBuf::from("it's a clip.mp4")];
        let content = concat_list_content(&paths);
        assert_eq!(content, "file 'a.mp4'\nfile 'it'\\''s a clip.mp4'\n");
    }

    #[test]
    fn neutralized_request_after_range_resolution_uses_joined_duration() {
        // Mirrors exactly what run_inner builds once prepare_ranges_source
        // hands back a joined file - the regression this guards: duration_sec
        // silently staying the ORIGINAL (much longer) source's length would
        // make the final pass's progress bar wildly wrong (jump to ~100%
        // almost immediately, or crawl at a tiny fraction of real progress).
        let mut req = base_req();
        req.duration_sec = 5000.0; // the original, long source
        req.cut_ranges = Some(vec![(10.0, 20.0), (50.0, 63.5)]);
        let joined_duration = req.effective_duration();
        let neutralized = ExportRequest {
            input_path: "joined.mp4".into(),
            duration_sec: joined_duration,
            cut_ranges: None,
            ..req.clone()
        };
        assert!((neutralized.effective_duration() - 23.5).abs() < 1e-6);
        assert!(neutralized.ranges().is_none());
    }
}

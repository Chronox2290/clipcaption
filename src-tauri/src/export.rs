use serde::Deserialize;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use tauri::{AppHandle, Manager};

use crate::encoders;
use crate::jobs::{emit_done, emit_error, emit_progress, JobHandle};
use crate::sidecar;

#[derive(Deserialize)]
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

    /// ffmpeg input args. With cut_ranges, trimming happens per-segment in the
    /// filtergraph instead, so this is just a plain input. Otherwise implements
    /// the single trim (-ss before -i, -t after).
    fn input_args(&self) -> Vec<String> {
        let mut args: Vec<String> = vec!["-y".into()];
        if self.ranges().is_some() {
            args.extend(["-i".into(), self.input_path.clone()]);
            return args;
        }
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

    /// Builds the -vf or -filter_complex (+ -map) args for this request.
    /// `vf_simple` is the plain comma-joined filter chain (scale/crop/subtitles).
    /// `include_audio`: false for the audio-less first pass of 2-pass encodes —
    /// avoids mapping an audio pad that -an would then conflict with.
    fn filter_and_map_args(&self, vf_simple: &str, include_audio: bool) -> Vec<String> {
        if let Some(ranges) = self.ranges() {
            let mut fc = String::new();
            for (i, (s, e)) in ranges.iter().enumerate() {
                fc.push_str(&format!(
                    "[0:v]trim=start={s:.3}:end={e:.3},setpts=PTS-STARTPTS[v{i}];\
                     [0:a]atrim=start={s:.3}:end={e:.3},asetpts=PTS-STARTPTS[a{i}];"
                ));
            }
            for i in 0..ranges.len() {
                fc.push_str(&format!("[v{i}][a{i}]"));
            }
            fc.push_str(&format!("concat=n={}:v=1:a=1[vcat][acat]", ranges.len()));
            if !vf_simple.is_empty() {
                fc.push_str(&format!(";[vcat]{vf_simple}[vout]"));
            }
            let video_pad = if vf_simple.is_empty() { "[vcat]" } else { "[vout]" };
            let mut args = vec!["-filter_complex".into(), fc, "-map".into(), video_pad.into()];
            if include_audio {
                args.extend(["-map".into(), "[acat]".into()]);
            }
            return args;
        }
        if vf_simple.is_empty() {
            vec![]
        } else {
            vec!["-vf".into(), vf_simple.into()]
        }
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

fn run_inner(
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

    // Write the .ass subtitle file if captions are being burned
    let ass_path: Option<PathBuf> = if req.ass_content.trim().is_empty() {
        None
    } else {
        let p = cache.join(format!("{job_id}.ass"));
        std::fs::write(&p, &req.ass_content).map_err(|e| e.to_string())?;
        Some(p)
    };

    // Build the video filter chain
    let mut filters: Vec<String> = Vec::new();
    if let (Some(w), Some(h)) = (req.target_w, req.target_h) {
        filters.push(format!(
            "scale={w}:{h}:force_original_aspect_ratio=increase"
        ));
        filters.push(format!("crop={w}:{h}"));
    }
    if let Some(ass) = &ass_path {
        filters.push(format!(
            "subtitles=filename='{}'",
            escape_filter_path(&ass.to_string_lossy())
        ));
    }
    let vf = filters.join(",");

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
            args.extend(req.filter_and_map_args(&vf, true));
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
        args1.extend(req.filter_and_map_args(&vf, false));
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
        args2.extend(req.filter_and_map_args(&vf, true));
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
        args.extend(req.filter_and_map_args(&vf, true));
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
        }
    }

    #[test]
    fn cut_ranges_duration_sums_segments() {
        let mut req = base_req();
        req.cut_ranges = Some(vec![(10.0, 20.0), (50.0, 63.5)]);
        assert!((req.effective_duration() - 23.5).abs() < 1e-6);
    }

    #[test]
    fn cut_ranges_input_args_has_no_seek() {
        let mut req = base_req();
        req.cut_ranges = Some(vec![(10.0, 20.0), (50.0, 63.5)]);
        let args = req.input_args();
        assert_eq!(args, vec!["-y", "-i", "in.mp4"]);
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
    fn cut_ranges_filtergraph_concats_and_maps_both_streams() {
        let mut req = base_req();
        req.cut_ranges = Some(vec![(10.0, 20.0), (50.0, 63.5)]);
        let args = req.filter_and_map_args("", true);
        assert_eq!(args[0], "-filter_complex");
        let fc = &args[1];
        assert!(fc.contains("[0:v]trim=start=10.000:end=20.000"));
        assert!(fc.contains("[0:v]trim=start=50.000:end=63.500"));
        assert!(fc.contains("[v0][a0][v1][a1]concat=n=2:v=1:a=1[vcat][acat]"));
        assert!(!fc.contains("[vout]")); // no vf_simple => output pad is [vcat] directly
        assert_eq!(&args[2..], &["-map", "[vcat]", "-map", "[acat]"]);
    }

    #[test]
    fn cut_ranges_filtergraph_chains_subtitles_after_concat() {
        let mut req = base_req();
        req.cut_ranges = Some(vec![(0.0, 5.0)]);
        let args = req.filter_and_map_args("subtitles=filename='x.ass'", true);
        let fc = &args[1];
        assert!(fc.ends_with(";[vcat]subtitles=filename='x.ass'[vout]"));
        assert_eq!(&args[2..], &["-map", "[vout]", "-map", "[acat]"]);
    }

    #[test]
    fn cut_ranges_video_only_pass_omits_audio_map() {
        let mut req = base_req();
        req.cut_ranges = Some(vec![(0.0, 5.0), (5.0, 9.0)]);
        let args = req.filter_and_map_args("", false);
        assert_eq!(&args[2..], &["-map", "[vcat]"]);
    }

    #[test]
    fn no_cut_ranges_falls_back_to_simple_vf() {
        let req = base_req();
        let args = req.filter_and_map_args("scale=100:100", true);
        assert_eq!(args, vec!["-vf", "scale=100:100"]);
    }

    #[test]
    fn empty_cut_ranges_vec_is_treated_as_absent() {
        let mut req = base_req();
        req.cut_ranges = Some(vec![]);
        assert_eq!(req.input_args(), vec!["-y", "-i", "in.mp4"]);
        assert_eq!(req.filter_and_map_args("", true), Vec::<String>::new());
    }
}

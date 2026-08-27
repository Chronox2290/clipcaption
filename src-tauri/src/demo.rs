//! One-click "before/after" demo export: renders the same clip twice — once
//! raw, once captioned+compressed exactly as a normal export would — and
//! puts them side by side with BEFORE/AFTER labels, so showing off what
//! ClipCaption does is one button instead of screen-recording two separate
//! exports and editing them together by hand.
//!
//! Reuses export::run_inner for both halves (same reasoning as montage.rs:
//! one battle-tested pipeline, not a second one), each rendered to the same
//! width/height so they can be stacked with ffmpeg's hstack filter in a
//! single final pass. The two source renders are identical in every way
//! except one has no ass_content and the other does — the visual contrast
//! between the two halves is the whole "demo", no other framing needed.

use serde::Deserialize;
use std::path::Path;
use std::sync::Arc;
use tauri::{AppHandle, Manager};

use crate::encoders;
use crate::export::{self, ExportRequest};
use crate::jobs::{emit_done, emit_error, emit_progress, JobHandle};
use crate::sidecar;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DemoRequest {
    pub input_path: String,
    pub output_path: String,
    /// The captioned side's burned-in subtitles - the raw side always
    /// renders with none, regardless of what's here.
    pub ass_content: String,
    pub trim_start: Option<f64>,
    pub trim_end: Option<f64>,
    pub duration_sec: f64,
    /// Width of EACH half - the final output is exactly double this. Left
    /// to the frontend to resolve (from the same resolution presets normal
    /// export uses) rather than re-deriving source dimensions here, so both
    /// halves are guaranteed identical and hstack can never mismatch.
    pub half_width: u32,
    pub height: u32,
    pub crf: Option<u32>,
    pub fps: Option<f64>,
    pub audio_kbps: u32,
    pub encoder: Option<String>,
    #[serde(default)]
    pub fit_mode: Option<String>,
}

pub fn run(app: AppHandle, job_id: String, handle: Arc<JobHandle>, req: DemoRequest) {
    let stage = "demo";
    match run_inner(&app, &job_id, &handle, &req) {
        Ok(()) => emit_done(&app, &job_id, stage, Some(req.output_path.clone())),
        Err(e) => {
            if handle.is_cancelled() {
                emit_error(&app, &job_id, stage, "Cancelled".into());
            } else {
                emit_error(&app, &job_id, stage, e);
            }
        }
    }
}

fn run_inner(
    app: &AppHandle,
    job_id: &str,
    handle: &Arc<JobHandle>,
    req: &DemoRequest,
) -> Result<(), String> {
    let stage = "demo";
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("demo");
    std::fs::create_dir_all(&cache).map_err(|e| e.to_string())?;

    let before_path = cache.join(format!("{job_id}_before.mp4"));
    let after_path = cache.join(format!("{job_id}_after.mp4"));
    let cleanup = |paths: &[&Path]| {
        for p in paths {
            let _ = std::fs::remove_file(p);
        }
    };

    let half_request = |ass_content: String, out: &Path| ExportRequest {
        input_path: req.input_path.clone(),
        output_path: out.to_string_lossy().into_owned(),
        ass_content,
        target_w: Some(req.half_width),
        target_h: Some(req.height),
        target_size_mb: None,
        crf: req.crf,
        fps: req.fps,
        audio_kbps: req.audio_kbps,
        duration_sec: req.duration_sec,
        trim_start: req.trim_start,
        trim_end: req.trim_end,
        cut_ranges: None,
        encoder: req.encoder.clone(),
        fit_mode: req.fit_mode.clone(),
        max_height: None,
    };

    emit_progress(app, job_id, stage, 0.0, Some("Rendering the before half".into()));
    let before_req = half_request(String::new(), &before_path);
    if let Err(e) = export::run_inner(app, job_id, handle, &before_req) {
        cleanup(&[&before_path]);
        return Err(format!("Rendering the before half failed: {e}"));
    }
    if handle.is_cancelled() {
        cleanup(&[&before_path]);
        return Err("Cancelled".into());
    }

    emit_progress(app, job_id, stage, 0.45, Some("Rendering the after half".into()));
    let after_req = half_request(req.ass_content.clone(), &after_path);
    if let Err(e) = export::run_inner(app, job_id, handle, &after_req) {
        cleanup(&[&before_path, &after_path]);
        return Err(format!("Rendering the after half failed: {e}"));
    }
    if handle.is_cancelled() {
        cleanup(&[&before_path, &after_path]);
        return Err("Cancelled".into());
    }

    emit_progress(app, job_id, stage, 0.9, Some("Combining side by side".into()));

    // font='Arial' via fontconfig — confirmed against the real bundled
    // ffmpeg build (b10621-era gyan.dev essentials): it logs a harmless
    // "Fontconfig error: Cannot load default config file" to stderr but
    // still resolves and renders the font correctly (checked by rendering
    // a labelled frame and reading the pixels, not just the exit code) -
    // the warning is not treated as failure below.
    let label = "fontsize=28:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=10:x=16:y=16";
    let filter = format!(
        "[0:v]drawtext=text='BEFORE':font='Arial':{label}[v0];\
         [1:v]drawtext=text='AFTER':font='Arial':{label}[v1];\
         [v0][v1]hstack=inputs=2[v]"
    );

    let encoder = encoders::resolve(req.encoder.as_deref());
    let crf = req.crf.unwrap_or(20);

    let mut cmd = sidecar::command("ffmpeg");
    cmd.arg("-y")
        .arg("-i")
        .arg(&before_path)
        .arg("-i")
        .arg(&after_path)
        .args(["-filter_complex", &filter])
        .args(["-map", "[v]", "-map", "1:a?"])
        .args(encoders::quality_args(&encoder, crf))
        .args(["-c:a", "aac", "-b:a", &format!("{}k", req.audio_kbps)])
        .arg(&req.output_path);

    let out = cmd
        .output()
        .map_err(|e| format!("Could not run ffmpeg: {e}"));

    cleanup(&[&before_path, &after_path]);

    let out = out?;
    if !out.status.success() {
        return Err(format!(
            "Combining before/after failed: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(())
}

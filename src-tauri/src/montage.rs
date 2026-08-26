//! Stitches highlight clips from several DIFFERENT source videos into one
//! shareable reel - the actual missing piece that turns "a folder of
//! individually-captioned clips" into a single thing worth posting, as
//! opposed to Auto Reel (highlights.ts/store.ts's buildReel), which only
//! ever picks from one already-open video's own highlights.
//!
//! Deliberately reuses export.rs's entire single-source pipeline unchanged
//! rather than building a second one: each clip is rendered independently
//! (its own trim, its own burned-in captions from its own project, all
//! normalized to the same resolution/fps/encoder settings the caller
//! chooses once for the whole montage) to a temp file via
//! `export::run_inner`, then the temp files are joined with ffmpeg's concat
//! demuxer (`-c copy`, no re-encoding) since they're now guaranteed to share
//! the same codec parameters. Far less risk than teaching the filtergraph
//! builder to juggle several distinct `-i` inputs with per-input scaling.

use serde::Deserialize;
use std::sync::Arc;
use tauri::{AppHandle, Manager};

use crate::export::{self, ExportRequest};
use crate::jobs::{emit_done, emit_error, emit_progress, JobHandle};
use crate::sidecar;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MontageItem {
    pub input_path: String,
    pub ass_content: String,
    pub target_w: Option<u32>,
    pub target_h: Option<u32>,
    pub crf: Option<u32>,
    pub fps: Option<f64>,
    pub audio_kbps: u32,
    pub duration_sec: f64,
    pub trim_start: Option<f64>,
    pub trim_end: Option<f64>,
    pub encoder: Option<String>,
    #[serde(default)]
    pub fit_mode: Option<String>,
    #[serde(default)]
    pub max_height: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MontageRequest {
    pub items: Vec<MontageItem>,
    pub output_path: String,
}

pub fn run(app: AppHandle, job_id: String, handle: Arc<JobHandle>, req: MontageRequest) {
    let stage = "montage";
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
    req: &MontageRequest,
) -> Result<(), String> {
    let stage = "montage";
    if req.items.is_empty() {
        return Err("No clips selected for the montage.".into());
    }

    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("montage");
    std::fs::create_dir_all(&cache).map_err(|e| e.to_string())?;

    let n = req.items.len();
    let mut temp_paths: Vec<std::path::PathBuf> = Vec::with_capacity(n);
    let cleanup = |paths: &[std::path::PathBuf]| {
        for p in paths {
            let _ = std::fs::remove_file(p);
        }
    };

    for (i, item) in req.items.iter().enumerate() {
        if handle.is_cancelled() {
            cleanup(&temp_paths);
            return Err("Cancelled".into());
        }
        // Coarse, per-clip progress - each clip's own encode emits its own
        // finer-grained progress underneath this via export::run_inner, so
        // the bar isn't silent, just not perfectly smooth across clips.
        emit_progress(
            app,
            job_id,
            stage,
            i as f32 / n as f32,
            Some(format!("Rendering clip {}/{}", i + 1, n)),
        );

        let temp_path = cache.join(format!("{job_id}_{i}.mp4"));
        let clip_req = ExportRequest {
            input_path: item.input_path.clone(),
            output_path: temp_path.to_string_lossy().into_owned(),
            ass_content: item.ass_content.clone(),
            target_w: item.target_w,
            target_h: item.target_h,
            // Montage clips are always quality-encoded; a file-size target
            // only makes sense on the FINAL joined output, which this v1
            // doesn't offer yet (see build_montage's frontend caller).
            target_size_mb: None,
            crf: item.crf,
            fps: item.fps,
            audio_kbps: item.audio_kbps,
            duration_sec: item.duration_sec,
            trim_start: item.trim_start,
            trim_end: item.trim_end,
            cut_ranges: None,
            encoder: item.encoder.clone(),
            fit_mode: item.fit_mode.clone(),
            max_height: item.max_height,
        };

        if let Err(e) = export::run_inner(app, job_id, handle, &clip_req) {
            cleanup(&temp_paths);
            return Err(format!("Clip {}/{} failed: {e}", i + 1, n));
        }
        temp_paths.push(temp_path);
    }

    emit_progress(app, job_id, stage, 0.95, Some("Joining clips".into()));

    let list_path = cache.join(format!("{job_id}_list.txt"));
    let mut list_content = String::new();
    for p in &temp_paths {
        // ffmpeg's concat-demuxer list format: single-quoted paths, with an
        // embedded single quote escaped as '\''.
        let escaped = p.to_string_lossy().replace('\'', r"'\''");
        list_content.push_str(&format!("file '{escaped}'\n"));
    }
    std::fs::write(&list_path, list_content).map_err(|e| e.to_string())?;

    let out = sidecar::command("ffmpeg")
        .args(["-y", "-f", "concat", "-safe", "0", "-i"])
        .arg(&list_path)
        .args(["-c", "copy"])
        .arg(&req.output_path)
        .output()
        .map_err(|e| format!("Could not run ffmpeg: {e}"));

    cleanup(&temp_paths);
    let _ = std::fs::remove_file(&list_path);

    let out = out?;
    if !out.status.success() {
        return Err(format!(
            "Joining clips failed: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(())
}

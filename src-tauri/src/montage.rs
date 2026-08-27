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
    /// Optional cap on the FINAL joined file's size, in MB. `None` keeps the
    /// old v1 behavior (each clip quality-encoded, plain -c copy join, no
    /// size targeting at all). When set, the join instead lands in a scratch
    /// temp file and gets one more pass through export.rs's own size-target
    /// machinery (2-pass x264 / VBV) - reused rather than re-implemented,
    /// same reasoning as reusing run_inner per-clip above.
    #[serde(default)]
    pub target_size_mb: Option<f64>,
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
    let mut total_duration = 0.0_f64;
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
        total_duration += item.duration_sec;
        temp_paths.push(temp_path);
    }

    emit_progress(app, job_id, stage, 0.9, Some("Joining clips".into()));

    // With no size target, join straight to the real output - same as
    // before this option existed. With one, the join is just an
    // intermediate: land it in scratch and run it through one more pass of
    // export.rs's own size-target machinery (2-pass x264 / VBV), same as a
    // single clip's "custom size" export already does - not re-implemented
    // here. `-c copy` join first (not fed straight into the size-target
    // pass as N separate -i inputs) because it's what lets all the earlier
    // per-clip renders share one instant, lossless combine step regardless
    // of how many clips there are.
    let join_target = match req.target_size_mb {
        Some(_) => cache.join(format!("{job_id}_joined.mp4")),
        None => std::path::PathBuf::from(&req.output_path),
    };
    let join_result = join_via_concat_demuxer(&temp_paths, &join_target.to_string_lossy(), &cache, job_id);
    cleanup(&temp_paths);
    join_result?;

    if let Some(target_mb) = req.target_size_mb {
        emit_progress(app, job_id, stage, 0.95, Some("Compressing to target size".into()));
        let first = &req.items[0];
        let final_req = ExportRequest {
            input_path: join_target.to_string_lossy().into_owned(),
            output_path: req.output_path.clone(),
            ass_content: String::new(), // already burned into each clip
            target_w: None,             // already cropped/scaled per clip
            target_h: None,
            target_size_mb: Some(target_mb),
            crf: None,
            fps: None, // already applied per clip
            audio_kbps: first.audio_kbps,
            duration_sec: total_duration,
            trim_start: None,
            trim_end: None,
            cut_ranges: None,
            encoder: first.encoder.clone(),
            fit_mode: None,
            max_height: None,
        };
        let result = export::run_inner(app, job_id, handle, &final_req);
        let _ = std::fs::remove_file(&join_target);
        result?;
    }
    Ok(())
}

/// Shared concat-demuxer join, used both by the per-project montage builder
/// above (joining freshly-rendered temp files) and by `concat_existing` (the
/// end-of-batch digest, joining already-exported clips as-is). `-c copy`
/// only works because every input in both callers is guaranteed to already
/// share the same codec parameters - same encoder settings for a montage's
/// temp renders, same export preset for one batch run's outputs.
fn join_via_concat_demuxer(
    paths: &[std::path::PathBuf],
    output_path: &str,
    scratch_dir: &std::path::Path,
    list_name_hint: &str,
) -> Result<(), String> {
    let list_path = scratch_dir.join(format!("{list_name_hint}_list.txt"));
    let mut list_content = String::new();
    for p in paths {
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
        .arg(output_path)
        .output()
        .map_err(|e| format!("Could not run ffmpeg: {e}"));

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

/// Pure branch-decision for `concat_existing`, split out so it's testable
/// without an `AppHandle`: errors on nothing to join, short-circuits a
/// single clip (nothing to concat), otherwise says "proceed with the join."
fn single_path_shortcut(paths: &[String]) -> Result<Option<String>, String> {
    match paths {
        [] => Err("No clips to join.".into()),
        [only] => Ok(Some(only.clone())),
        _ => Ok(None),
    }
}

/// Stitches already-exported clips (e.g. one batch/watch-folder run's
/// outputs) into a single file, no re-render - just the concat-demuxer join.
/// Used for the end-of-batch Discord digest ("N clips processed, M compiled
/// into tonight's reel"). Picks its own output path in the app cache dir
/// since this runs unattended with no save dialog, and returns it so the
/// caller can post it straight to Discord.
pub fn concat_existing(app: &AppHandle, job_id: &str, paths: Vec<String>) -> Result<String, String> {
    if let Some(shortcut) = single_path_shortcut(&paths)? {
        return Ok(shortcut);
    }
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("digest");
    std::fs::create_dir_all(&cache).map_err(|e| e.to_string())?;

    let output_path = cache
        .join(format!("{job_id}_digest.mp4"))
        .to_string_lossy()
        .into_owned();
    let path_bufs: Vec<std::path::PathBuf> = paths.into_iter().map(Into::into).collect();
    join_via_concat_demuxer(&path_bufs, &output_path, &cache, job_id)?;
    Ok(output_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_paths_is_an_error_not_a_silent_no_op() {
        let err = single_path_shortcut(&[]).unwrap_err();
        assert!(err.contains("No clips to join"), "{err}");
    }

    #[test]
    fn a_single_path_short_circuits_without_touching_ffmpeg() {
        let result = single_path_shortcut(&["only.mp4".to_string()]).unwrap();
        assert_eq!(result, Some("only.mp4".to_string()));
    }

    #[test]
    fn two_or_more_paths_proceed_to_the_real_join() {
        let result =
            single_path_shortcut(&["a.mp4".to_string(), "b.mp4".to_string()]).unwrap();
        assert_eq!(result, None);
    }
}

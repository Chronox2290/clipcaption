use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::Manager;

use crate::sidecar;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub path: String,
    pub duration_sec: f64,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub video_codec: String,
    pub audio_codec: Option<String>,
    pub size_bytes: u64,
}

#[derive(Deserialize)]
struct FfprobeOut {
    format: Option<FfFormat>,
    streams: Option<Vec<FfStream>>,
}

#[derive(Deserialize)]
struct FfFormat {
    duration: Option<String>,
    size: Option<String>,
}

#[derive(Deserialize)]
struct FfStream {
    codec_type: Option<String>,
    codec_name: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    avg_frame_rate: Option<String>,
    r_frame_rate: Option<String>,
    channels: Option<u32>,
    tags: Option<FfTags>,
}

#[derive(Deserialize)]
struct FfTags {
    language: Option<String>,
    title: Option<String>,
}

/// One audio stream in a source file - see list_audio_tracks. `index` is
/// the audio stream's OWN position among audio streams only (0, 1, 2...),
/// matching ffmpeg's `-map 0:a:N` selector, not the file's absolute stream
/// index (which also counts video/subtitle streams and would silently pick
/// the wrong track if used with -map 0:a:N).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioTrackInfo {
    pub index: u32,
    pub codec: String,
    pub channels: u32,
    pub language: Option<String>,
    pub title: Option<String>,
}

/// Lists every audio track in a source file - OBS's Advanced output mode
/// can record mic and desktop/game audio onto separate tracks (up to 6),
/// and when it does, picking the voice track directly is a near-free
/// transcription-quality win: no AI separation needed, just ffmpeg stream
/// selection. Returns an empty (not error) list for a normal single-track
/// file - the caller only shows a track picker when there's more than one.
pub fn list_audio_tracks(path: &str) -> Result<Vec<AudioTrackInfo>, String> {
    let out = sidecar::command("ffprobe")
        .args([
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_streams",
            "-select_streams",
            "a",
            path,
        ])
        .output()
        .map_err(|e| format!("Could not run ffprobe: {e}. Run scripts/get-sidecars.ps1 first."))?;

    if !out.status.success() {
        return Err(format!(
            "ffprobe failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }

    let parsed: FfprobeOut =
        serde_json::from_slice(&out.stdout).map_err(|e| format!("ffprobe parse error: {e}"))?;

    Ok(parsed
        .streams
        .unwrap_or_default()
        .into_iter()
        .enumerate()
        .map(|(i, s)| AudioTrackInfo {
            index: i as u32,
            codec: s.codec_name.unwrap_or_default(),
            channels: s.channels.unwrap_or(0),
            language: s.tags.as_ref().and_then(|t| t.language.clone()),
            title: s.tags.and_then(|t| t.title),
        })
        .collect())
}

fn parse_rate(rate: &str) -> f64 {
    let mut parts = rate.split('/');
    let num: f64 = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0.0);
    let den: f64 = parts.next().and_then(|p| p.parse().ok()).unwrap_or(1.0);
    if den == 0.0 {
        0.0
    } else {
        num / den
    }
}

pub fn probe(path: &str) -> Result<MediaInfo, String> {
    let out = sidecar::command("ffprobe")
        .args([
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            path,
        ])
        .output()
        .map_err(|e| format!("Could not run ffprobe: {e}. Run scripts/get-sidecars.ps1 first."))?;

    if !out.status.success() {
        return Err(format!(
            "ffprobe failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }

    let parsed: FfprobeOut =
        serde_json::from_slice(&out.stdout).map_err(|e| format!("ffprobe parse error: {e}"))?;

    let streams = parsed.streams.unwrap_or_default();
    let video = streams
        .iter()
        .find(|s| s.codec_type.as_deref() == Some("video"))
        .ok_or("No video stream found in file")?;
    let audio = streams
        .iter()
        .find(|s| s.codec_type.as_deref() == Some("audio"));

    let fps = video
        .avg_frame_rate
        .as_deref()
        .map(parse_rate)
        .filter(|f| *f > 0.0)
        .or_else(|| video.r_frame_rate.as_deref().map(parse_rate))
        .unwrap_or(30.0);

    let fmt = parsed.format.ok_or("ffprobe: missing format info")?;

    Ok(MediaInfo {
        path: path.to_string(),
        duration_sec: fmt
            .duration
            .as_deref()
            .and_then(|d| d.parse().ok())
            .unwrap_or(0.0),
        width: video.width.unwrap_or(0),
        height: video.height.unwrap_or(0),
        fps,
        video_codec: video.codec_name.clone().unwrap_or_default(),
        audio_codec: audio.and_then(|a| a.codec_name.clone()),
        size_bytes: fmt.size.as_deref().and_then(|s| s.parse().ok()).unwrap_or(0),
    })
}

/// Return a path the WebView can play. mp4/mov/webm play natively; anything
/// else (mkv, flv, ts, avi) gets remuxed — or, if remux fails, re-encoded —
/// into the app cache dir.
pub fn prepare_preview(app: &tauri::AppHandle, path: &str) -> Result<String, String> {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    if matches!(ext.as_str(), "mp4" | "mov" | "webm" | "m4v") {
        return Ok(path.to_string());
    }

    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("previews");
    std::fs::create_dir_all(&cache).map_err(|e| e.to_string())?;

    let stem = Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("clip");
    let hash = simple_hash(path);
    let out: PathBuf = cache.join(format!("{stem}_{hash}.mp4"));
    if out.exists() {
        return Ok(out.to_string_lossy().to_string());
    }

    // Try a fast remux first (no re-encode)
    let remux = sidecar::command("ffmpeg")
        .args([
            "-y",
            "-i",
            path,
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            out.to_string_lossy().as_ref(),
        ])
        .output()
        .map_err(|e| format!("Could not run ffmpeg: {e}"))?;

    if remux.status.success() && out.exists() {
        return Ok(out.to_string_lossy().to_string());
    }

    // Fallback: quick re-encode
    let enc = sidecar::command("ffmpeg")
        .args([
            "-y",
            "-i",
            path,
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "23",
            "-c:a",
            "aac",
            "-movflags",
            "+faststart",
            out.to_string_lossy().as_ref(),
        ])
        .output()
        .map_err(|e| format!("Could not run ffmpeg: {e}"))?;

    if enc.status.success() && out.exists() {
        Ok(out.to_string_lossy().to_string())
    } else {
        Err(format!(
            "Could not prepare preview: {}",
            String::from_utf8_lossy(&enc.stderr)
                .lines()
                .last()
                .unwrap_or("unknown ffmpeg error")
        ))
    }
}

/// Grabs one JPEG frame at `time_sec` - the auto-picked thumbnail for a
/// highlight. "Auto-picked" here means the CALLER already chose a
/// meaningful timestamp (the loudness scan's own peak-excitement moment,
/// see analyze::Highlight.peak) rather than a lazy midpoint guess; this
/// function's only job is turning that timestamp into an actual image.
/// Cached by (path, timestamp) so re-opening a highlight's edit panel
/// doesn't re-run ffmpeg for a frame already grabbed this session.
pub fn extract_thumbnail(
    app: &tauri::AppHandle,
    video_path: &str,
    time_sec: f64,
) -> Result<String, String> {
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("thumbnails");
    std::fs::create_dir_all(&cache).map_err(|e| e.to_string())?;

    let hash = simple_hash(video_path);
    let out: PathBuf = cache.join(format!("{hash}_{:.2}.jpg", time_sec.max(0.0)));
    if out.exists() {
        return Ok(out.to_string_lossy().to_string());
    }

    // -ss before -i: fast input-side seek, exactly the same shape used
    // elsewhere in this app for trimming (see export.rs).
    let out_arg = out.to_string_lossy().to_string();
    let status = sidecar::command("ffmpeg")
        .args([
            "-y",
            "-ss",
            &time_sec.max(0.0).to_string(),
            "-i",
            video_path,
            "-frames:v",
            "1",
            "-q:v",
            "3",
            &out_arg,
        ])
        .status()
        .map_err(|e| format!("Could not run ffmpeg: {e}"))?;

    if status.success() && out.exists() {
        Ok(out_arg)
    } else {
        Err("Could not extract a thumbnail frame at that timestamp".into())
    }
}

fn simple_hash(s: &str) -> String {
    let mut h: u64 = 1469598103934665603;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(1099511628211);
    }
    format!("{h:016x}")
}

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::process::Stdio;
use std::sync::Arc;
use tauri::{AppHandle, Manager};

use crate::jobs::{emit_done, emit_error, emit_progress, JobHandle};
use crate::models;
use crate::sidecar;

#[derive(Serialize)]
pub struct WordSpan {
    pub text: String,
    pub start: f64,
    pub end: f64,
}

#[derive(Serialize)]
pub struct Segment {
    pub id: String,
    pub words: Vec<WordSpan>,
}

#[derive(Deserialize)]
struct WhisperOut {
    transcription: Vec<WSeg>,
}

#[derive(Deserialize)]
struct WSeg {
    text: String,
    offsets: WOff,
    tokens: Option<Vec<WTok>>,
}

#[derive(Deserialize)]
struct WOff {
    from: i64,
    to: i64,
}

#[derive(Deserialize)]
struct WTok {
    text: String,
    offsets: Option<WOff>,
}

pub fn run(
    app: AppHandle,
    job_id: String,
    handle: Arc<JobHandle>,
    path: String,
    model: String,
    start: Option<f64>,
    end: Option<f64>,
) {
    let result = run_inner(&app, &job_id, &handle, &path, &model, start, end);
    match result {
        Ok(json) => emit_done(&app, &job_id, "transcribing", Some(json)),
        Err(e) => {
            if handle.is_cancelled() {
                emit_error(&app, &job_id, "transcribing", "Cancelled".into());
            } else {
                emit_error(&app, &job_id, "transcribing", e);
            }
        }
    }
}

fn run_inner(
    app: &AppHandle,
    job_id: &str,
    handle: &Arc<JobHandle>,
    path: &str,
    model: &str,
    start: Option<f64>,
    end: Option<f64>,
) -> Result<String, String> {
    let model_path = models::model_path(app, model)?;
    if !model_path.exists() {
        return Err(format!(
            "Model '{model}' is not downloaded yet — grab it from the home screen."
        ));
    }

    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("transcribe");
    std::fs::create_dir_all(&cache).map_err(|e| e.to_string())?;

    let wav = cache.join(format!("{job_id}.wav"));
    let out_base = cache.join(format!("{job_id}"));

    // 1. Extract mono 16 kHz audio (optionally only a time range)
    emit_progress(app, job_id, "extracting", -1.0, None);
    let offset = start.unwrap_or(0.0).max(0.0);
    let mut extract_cmd = sidecar::command("ffmpeg");
    extract_cmd.arg("-y");
    if offset > 0.0 {
        extract_cmd.args(["-ss", &format!("{offset:.3}")]);
    }
    extract_cmd.args(["-i", path]);
    if let Some(end) = end {
        let dur = (end - offset).max(0.1);
        extract_cmd.args(["-t", &format!("{dur:.3}")]);
    }
    let extract = extract_cmd
        .args([
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            wav.to_string_lossy().as_ref(),
        ])
        .output()
        .map_err(|e| format!("Could not run ffmpeg: {e}. Run scripts/get-sidecars.ps1 first."))?;
    if !extract.status.success() {
        return Err(format!(
            "Audio extraction failed: {}",
            String::from_utf8_lossy(&extract.stderr)
                .lines()
                .last()
                .unwrap_or("unknown error")
        ));
    }

    // 2. Run whisper.cpp with word-level (token) timestamps + JSON output
    emit_progress(app, job_id, "transcribing", -1.0, None);
    let threads = std::thread::available_parallelism()
        .map(|n| n.get().saturating_sub(1).max(1))
        .unwrap_or(4)
        .to_string();

    let mut child = sidecar::command("whisper-cli")
        .args([
            "-m",
            model_path.to_string_lossy().as_ref(),
            "-f",
            wav.to_string_lossy().as_ref(),
            "-ojf", // output full JSON (with token timestamps)
            "-of",
            out_base.to_string_lossy().as_ref(),
            "-t",
            &threads,
            "-pp", // print progress
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not run whisper-cli: {e}. Run scripts/get-sidecars.ps1 first."))?;

    let stderr = child.stderr.take();
    handle.set_child(child);

    if let Some(stderr) = stderr {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            if let Some(idx) = line.find("progress =") {
                let pct: f32 = line[idx + 10..]
                    .trim()
                    .trim_end_matches('%')
                    .trim()
                    .parse()
                    .unwrap_or(0.0);
                emit_progress(app, job_id, "transcribing", (pct / 100.0).min(0.99), None);
            }
        }
    }

    let status = {
        let mut guard = handle.child.lock().unwrap();
        match guard.as_mut() {
            Some(child) => child.wait().map_err(|e| e.to_string())?,
            None => return Err("Job was cancelled".into()),
        }
    };
    handle.clear_child();

    if handle.is_cancelled() {
        return Err("Cancelled".into());
    }
    if !status.success() {
        return Err("whisper-cli failed — try re-running or a different model".into());
    }

    // 3. Parse JSON output into word-level segments
    let json_path = out_base.with_extension("json");
    let raw = std::fs::read_to_string(&json_path)
        .map_err(|e| format!("Could not read transcript output: {e}"))?;
    let parsed: WhisperOut =
        serde_json::from_str(&raw).map_err(|e| format!("Transcript parse error: {e}"))?;

    let mut segments = build_segments(parsed);
    // shift word times back onto the full-video timeline when a range was used
    if offset > 0.0 {
        for seg in &mut segments {
            for w in &mut seg.words {
                w.start += offset;
                w.end += offset;
            }
        }
    }
    let _ = std::fs::remove_file(&wav);
    let _ = std::fs::remove_file(&json_path);

    serde_json::to_string(&segments).map_err(|e| e.to_string())
}

fn build_segments(out: WhisperOut) -> Vec<Segment> {
    let mut segments = Vec::new();

    for (si, seg) in out.transcription.into_iter().enumerate() {
        let text_trim = seg.text.trim();
        // skip non-speech annotations like [Music], (laughing), [BLANK_AUDIO]
        if text_trim.is_empty()
            || (text_trim.starts_with('[') && text_trim.ends_with(']'))
            || (text_trim.starts_with('(') && text_trim.ends_with(')'))
        {
            continue;
        }

        let mut words: Vec<WordSpan> = Vec::new();

        if let Some(tokens) = seg.tokens {
            for tok in tokens {
                let t = tok.text.as_str();
                // skip special tokens like [_BEG_], [_TT_xx]
                if t.starts_with("[_") || t.trim().is_empty() {
                    continue;
                }
                let (from, to) = match &tok.offsets {
                    Some(o) => (o.from as f64 / 1000.0, o.to as f64 / 1000.0),
                    None => continue,
                };

                let starts_word = t.starts_with(' ') || words.is_empty();
                if starts_word {
                    words.push(WordSpan {
                        text: t.trim().to_string(),
                        start: from,
                        end: to,
                    });
                } else if let Some(last) = words.last_mut() {
                    last.text.push_str(t.trim_end());
                    last.end = to;
                }
            }
        }

        // Fallback: no usable tokens — split the segment text evenly
        if words.is_empty() {
            let seg_start = seg.offsets.from as f64 / 1000.0;
            let seg_end = seg.offsets.to as f64 / 1000.0;
            let parts: Vec<&str> = text_trim.split_whitespace().collect();
            let n = parts.len().max(1) as f64;
            let dur = (seg_end - seg_start).max(0.1);
            for (i, p) in parts.iter().enumerate() {
                words.push(WordSpan {
                    text: (*p).to_string(),
                    start: seg_start + dur * (i as f64) / n,
                    end: seg_start + dur * ((i + 1) as f64) / n,
                });
            }
        }

        // drop empty-text words that can result from stray punctuation tokens
        words.retain(|w| !w.text.trim().is_empty());

        if !words.is_empty() {
            segments.push(Segment {
                id: format!("seg_{si}"),
                words,
            });
        }
    }

    segments
}

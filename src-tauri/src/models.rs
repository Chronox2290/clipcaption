use serde::Serialize;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Manager};

use crate::jobs::{emit_done, emit_error, emit_progress, JobHandle};

pub struct ModelSpec {
    pub name: &'static str,
    pub file_name: &'static str,
    pub size_mb: u32,
    pub recommended: bool,
    pub description: &'static str,
    /// Preset string whisper.cpp's `-dtw` flag expects for this model — not
    /// always the same as `name`. The tiny/base/small/medium English models
    /// happen to already match (whisper.cpp's own convention uses dots), but
    /// the large models take dotted preset names ("large.v3") while their
    /// ggml file names use hyphens ("large-v3") — verified against
    /// whisper.cpp's own `examples/cli/cli.cpp` source, not guessed.
    pub dtw_preset: &'static str,
    /// HF repo the file is hosted in ("owner/name"). Every normal model
    /// lives in ggerganov/whisper.cpp; the tinydiarize model is a separate
    /// community fine-tune hosted in its own repo (confirmed against
    /// whisper.cpp's own download-ggml-model.sh, which special-cases it).
    pub hf_repo: &'static str,
    /// True for a model that exists to unlock a capability (currently: speaker-turn
    /// detection) rather than being a normal accuracy choice — the UI keeps
    /// these out of the main "Speech model" picker.
    pub capability_only: bool,
}

pub const MODELS: &[ModelSpec] = &[
    ModelSpec {
        name: "tiny.en",
        file_name: "ggml-tiny.en.bin",
        size_mb: 75,
        recommended: false,
        description: "Fastest, rough accuracy — quick drafts",
        dtw_preset: "tiny.en",
        hf_repo: "ggerganov/whisper.cpp",
        capability_only: false,
    },
    ModelSpec {
        name: "base.en",
        file_name: "ggml-base.en.bin",
        size_mb: 142,
        recommended: false,
        description: "Fast, decent accuracy",
        dtw_preset: "base.en",
        hf_repo: "ggerganov/whisper.cpp",
        capability_only: false,
    },
    ModelSpec {
        name: "small.en",
        file_name: "ggml-small.en.bin",
        size_mb: 466,
        recommended: false,
        description: "Good speed/accuracy balance for game audio",
        dtw_preset: "small.en",
        hf_repo: "ggerganov/whisper.cpp",
        capability_only: false,
    },
    ModelSpec {
        name: "medium.en",
        file_name: "ggml-medium.en.bin",
        size_mb: 1533,
        recommended: false,
        description: "More accurate than small, noticeably slower",
        dtw_preset: "medium.en",
        hf_repo: "ggerganov/whisper.cpp",
        capability_only: false,
    },
    ModelSpec {
        name: "large-v3-turbo",
        file_name: "ggml-large-v3-turbo.bin",
        size_mb: 1620,
        recommended: true,
        // Turbo drops large-v3's translation-task training data, which mostly
        // costs it on non-English languages and X->English translation, not
        // English transcription — so for this app's use case (English game
        // commentary) it lands close to large-v3's accuracy for a fraction of
        // the compute. Confirmed against OpenAI's own turbo release notes.
        description: "Best accuracy for English, near large-v3 quality at a fraction of the cost — recommended",
        dtw_preset: "large.v3.turbo",
        hf_repo: "ggerganov/whisper.cpp",
        capability_only: false,
    },
    ModelSpec {
        name: "large-v3",
        file_name: "ggml-large-v3.bin",
        size_mb: 3100,
        recommended: false,
        description: "Maximum possible accuracy — largest and slowest, for the hardest audio",
        dtw_preset: "large.v3",
        hf_repo: "ggerganov/whisper.cpp",
        capability_only: false,
    },
    ModelSpec {
        name: "small.en-tdrz",
        file_name: "ggml-small.en-tdrz.bin",
        size_mb: 488,
        recommended: false,
        // Honest framing: this is turn-detection, not voice identification —
        // it marks when the speaker changes, then the app alternates a
        // "Speaker A/B" color across those turns. It can't recognize the
        // same person again after a gap, and it's only reliable for
        // two-person audio (verified against whisper.cpp's tinydiarize docs
        // and source — it emits a single "speaker changed" boolean per
        // segment, no speaker embeddings/clustering).
        description: "Speaker-turn detection for 2-person audio — trades some accuracy for speaker awareness",
        dtw_preset: "small.en", // tinydiarize is a small.en fine-tune; same architecture/alignment heads
        hf_repo: "akashmjn/tinydiarize-whisper.cpp",
        capability_only: true,
    },
];

/// Looks up the `-dtw` preset string for a model name, falling back to the
/// name itself (matches whisper.cpp's own convention for every model except
/// the large ones, which are special-cased above).
pub fn dtw_preset(name: &str) -> &str {
    MODELS
        .iter()
        .find(|m| m.name == name)
        .map(|m| m.dtw_preset)
        .unwrap_or(name)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub name: String,
    pub file_name: String,
    pub size_mb: u32,
    pub downloaded: bool,
    pub recommended: bool,
    pub description: String,
    pub capability_only: bool,
}

pub fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("models");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

pub fn model_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let spec = MODELS
        .iter()
        .find(|m| m.name == name)
        .ok_or_else(|| format!("Unknown model: {name}"))?;
    Ok(models_dir(app)?.join(spec.file_name))
}

pub fn list(app: &AppHandle) -> Result<Vec<ModelInfo>, String> {
    let dir = models_dir(app)?;
    Ok(MODELS
        .iter()
        .map(|m| ModelInfo {
            name: m.name.to_string(),
            file_name: m.file_name.to_string(),
            size_mb: m.size_mb,
            downloaded: dir.join(m.file_name).exists(),
            recommended: m.recommended,
            description: m.description.to_string(),
            capability_only: m.capability_only,
        })
        .collect())
}

pub fn download(app: AppHandle, job_id: String, handle: Arc<JobHandle>, name: String) {
    let stage = "downloading";
    let spec = match MODELS.iter().find(|m| m.name == name) {
        Some(s) => s,
        None => {
            emit_error(&app, &job_id, stage, format!("Unknown model: {name}"));
            return;
        }
    };

    let dir = match models_dir(&app) {
        Ok(d) => d,
        Err(e) => {
            emit_error(&app, &job_id, stage, e);
            return;
        }
    };
    let dest = dir.join(spec.file_name);
    if dest.exists() {
        emit_done(&app, &job_id, stage, None);
        return;
    }

    let url = format!(
        "https://huggingface.co/{}/resolve/main/{}",
        spec.hf_repo, spec.file_name
    );

    let result = (|| -> Result<(), String> {
        let client = reqwest::blocking::Client::builder()
            .timeout(None)
            .build()
            .map_err(|e| e.to_string())?;
        let mut resp = client.get(&url).send().map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("Download failed: HTTP {}", resp.status()));
        }
        let total = resp
            .content_length()
            .unwrap_or((spec.size_mb as u64) * 1024 * 1024);

        let part = dest.with_extension("part");
        let mut file = std::fs::File::create(&part).map_err(|e| e.to_string())?;
        let mut buf = [0u8; 1024 * 256];
        let mut read_total: u64 = 0;
        let mut last_emit = 0u64;

        loop {
            if handle.is_cancelled() {
                drop(file);
                let _ = std::fs::remove_file(&part);
                return Err("Cancelled".into());
            }
            let n = resp.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            read_total += n as u64;
            if read_total - last_emit > 4 * 1024 * 1024 {
                last_emit = read_total;
                emit_progress(
                    &app,
                    &job_id,
                    stage,
                    (read_total as f32 / total as f32).min(0.999),
                    None,
                );
            }
        }
        file.flush().map_err(|e| e.to_string())?;
        drop(file);
        std::fs::rename(&part, &dest).map_err(|e| e.to_string())?;
        Ok(())
    })();

    match result {
        Ok(()) => emit_done(&app, &job_id, stage, None),
        Err(e) => emit_error(&app, &job_id, stage, e),
    }
}

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
}

pub const MODELS: &[ModelSpec] = &[
    ModelSpec {
        name: "tiny.en",
        file_name: "ggml-tiny.en.bin",
        size_mb: 75,
        recommended: false,
        description: "Fastest, rough accuracy — quick drafts",
    },
    ModelSpec {
        name: "base.en",
        file_name: "ggml-base.en.bin",
        size_mb: 142,
        recommended: false,
        description: "Fast, decent accuracy",
    },
    ModelSpec {
        name: "small.en",
        file_name: "ggml-small.en.bin",
        size_mb: 466,
        recommended: true,
        description: "Best speed/accuracy balance for game audio",
    },
    ModelSpec {
        name: "medium.en",
        file_name: "ggml-medium.en.bin",
        size_mb: 1533,
        recommended: false,
        description: "Most accurate, slower — noisy clips",
    },
];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub name: String,
    pub file_name: String,
    pub size_mb: u32,
    pub downloaded: bool,
    pub recommended: bool,
    pub description: String,
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
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/{}",
        spec.file_name
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

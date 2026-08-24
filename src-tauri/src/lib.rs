mod analyze;
mod diarize;
mod encoders;
mod export;
mod jobs;
mod media;
mod models;
mod sidecar;
mod transcribe;

use jobs::Jobs;
use tauri::{AppHandle, Manager, State};

#[tauri::command]
fn probe_video(path: String) -> Result<media::MediaInfo, String> {
    media::probe(&path)
}

#[tauri::command]
fn prepare_preview(app: AppHandle, path: String) -> Result<String, String> {
    media::prepare_preview(&app, &path)
}

#[tauri::command]
fn detect_encoders() -> Vec<String> {
    encoders::available()
}

#[tauri::command]
fn list_videos(dir: String) -> Result<Vec<String>, String> {
    const EXTS: [&str; 8] = ["mp4", "mkv", "mov", "webm", "avi", "flv", "ts", "m4v"];
    let mut out: Vec<String> = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| format!("Could not read folder: {e}"))? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.is_file() {
            if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                if EXTS.contains(&ext.to_lowercase().as_str()) {
                    out.push(path.to_string_lossy().to_string());
                }
            }
        }
    }
    out.sort();
    Ok(out)
}

#[tauri::command]
fn list_models(app: AppHandle) -> Result<Vec<models::ModelInfo>, String> {
    models::list(&app)
}

#[tauri::command]
fn ensure_model(app: AppHandle, jobs: State<Jobs>, name: String) -> Result<String, String> {
    let (id, handle) = jobs.create("model");
    let job_id = id.clone();
    std::thread::spawn(move || {
        models::download(app, job_id, handle, name);
    });
    Ok(id)
}

#[tauri::command]
fn transcribe(
    app: AppHandle,
    jobs: State<Jobs>,
    path: String,
    model: String,
    start: Option<f64>,
    end: Option<f64>,
) -> Result<String, String> {
    let (id, handle) = jobs.create("stt");
    let job_id = id.clone();
    std::thread::spawn(move || {
        transcribe::run(app, job_id, handle, path, model, start, end);
    });
    Ok(id)
}

#[tauri::command]
fn analyze_highlights(
    app: AppHandle,
    jobs: State<Jobs>,
    path: String,
    max_count: Option<usize>,
) -> Result<String, String> {
    let (id, handle) = jobs.create("hl");
    let job_id = id.clone();
    let max = max_count.unwrap_or(12);
    std::thread::spawn(move || {
        analyze::run(app, job_id, handle, path, max);
    });
    Ok(id)
}

#[tauri::command]
fn export_video(
    app: AppHandle,
    jobs: State<Jobs>,
    req: export::ExportRequest,
) -> Result<String, String> {
    let (id, handle) = jobs.create("export");
    let job_id = id.clone();
    std::thread::spawn(move || {
        export::run(app, job_id, handle, req);
    });
    Ok(id)
}

#[tauri::command]
fn cancel_job(jobs: State<Jobs>, id: String) -> Result<(), String> {
    if let Some(handle) = jobs.get(&id) {
        handle.cancel();
        jobs.remove(&id);
    }
    Ok(())
}

// Generic small-file read/write, used for saving/loading a .ccproj project
// file (JSON built entirely on the frontend). Deliberately not a real file
// picker/browser — just enough to persist and restore one JSON document at a
// path the user already chose via the dialog plugin.
#[tauri::command]
fn write_text_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| format!("Could not save to {path}: {e}"))
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("Could not read {path}: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(Jobs::default())
        .setup(|app| {
            // make sure app dirs exist early
            let _ = app.path().app_data_dir().map(|d| std::fs::create_dir_all(d));
            let _ = app.path().app_cache_dir().map(|d| std::fs::create_dir_all(d));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            probe_video,
            prepare_preview,
            analyze_highlights,
            list_videos,
            detect_encoders,
            list_models,
            ensure_model,
            transcribe,
            export_video,
            cancel_job,
            write_text_file,
            read_text_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running ClipCaption");
}

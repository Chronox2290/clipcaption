use serde::Serialize;
use std::collections::HashMap;
use std::process::Child;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub id: String,
    pub stage: String,
    pub progress: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub done: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
}

#[derive(Default)]
pub struct JobHandle {
    pub cancelled: AtomicBool,
    pub child: Mutex<Option<Child>>,
}

impl JobHandle {
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    pub fn set_child(&self, child: Child) {
        *self.child.lock().unwrap() = Some(child);
    }

    pub fn clear_child(&self) {
        *self.child.lock().unwrap() = None;
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        if let Some(child) = self.child.lock().unwrap().as_mut() {
            let _ = child.kill();
        }
    }
}

#[derive(Default)]
pub struct Jobs {
    map: Mutex<HashMap<String, Arc<JobHandle>>>,
    counter: AtomicU64,
}

impl Jobs {
    pub fn create(&self, prefix: &str) -> (String, Arc<JobHandle>) {
        let n = self.counter.fetch_add(1, Ordering::SeqCst);
        let id = format!("{prefix}_{n}");
        let handle = Arc::new(JobHandle::default());
        self.map.lock().unwrap().insert(id.clone(), handle.clone());
        (id, handle)
    }

    pub fn get(&self, id: &str) -> Option<Arc<JobHandle>> {
        self.map.lock().unwrap().get(id).cloned()
    }

    pub fn remove(&self, id: &str) {
        self.map.lock().unwrap().remove(id);
    }
}

pub fn emit_progress(app: &AppHandle, id: &str, stage: &str, progress: f32, message: Option<String>) {
    let _ = app.emit(
        "job-progress",
        Progress {
            id: id.to_string(),
            stage: stage.to_string(),
            progress,
            message,
            done: false,
            error: None,
            result: None,
        },
    );
}

pub fn emit_done(app: &AppHandle, id: &str, stage: &str, result: Option<String>) {
    let _ = app.emit(
        "job-progress",
        Progress {
            id: id.to_string(),
            stage: stage.to_string(),
            progress: 1.0,
            message: None,
            done: true,
            error: None,
            result,
        },
    );
}

pub fn emit_error(app: &AppHandle, id: &str, stage: &str, error: String) {
    let _ = app.emit(
        "job-progress",
        Progress {
            id: id.to_string(),
            stage: stage.to_string(),
            progress: 0.0,
            message: None,
            done: true,
            error: Some(error),
            result: None,
        },
    );
}

//! OBS watch-folder background service: point this at OBS's recording (or
//! replay-buffer) output folder and every NEW file that lands there gets
//! picked up automatically, no manual "add to batch" step - "the app runs
//! and captions new recordings automatically, no manual open" (brief).
//!
//! Deliberately plain polling, not a filesystem-events crate: OBS holds the
//! output file open and growing for the entire recording, so an fs-event
//! fires the instant the file is *created*, long before it's done being
//! written - acting on that would try to transcribe a half-written file.
//! Polling and requiring the file's size to sit unchanged for a few seconds
//! sidesteps that without needing to know anything about OBS's own file
//! lifecycle, and avoids a new dependency for something this app only ever
//! needs to check every few seconds anyway.
//!
//! Only ever reports NEW files, not ones already sitting in the folder when
//! watching starts - those already have a manual path (Batch screen's own
//! "Add folder"), and treating a folder full of old clips as "just
//! arrived" the first time watching turns on would flood the queue with
//! things the user may have already handled by hand.

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

use crate::jobs::JobHandle;

const VIDEO_EXTS: [&str; 8] = ["mp4", "mkv", "mov", "webm", "avi", "flv", "ts", "m4v"];
const POLL_INTERVAL: Duration = Duration::from_secs(3);
/// How long a file's size must sit unchanged before it's treated as done
/// being written.
const STABLE_FOR: Duration = Duration::from_secs(5);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WatchEvent {
    job_id: String,
    path: String,
}

fn is_video(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| VIDEO_EXTS.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false)
}

fn list_videos(folder: &str) -> HashSet<PathBuf> {
    std::fs::read_dir(folder)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| is_video(p))
                .collect()
        })
        .unwrap_or_default()
}

/// Runs until `handle` is cancelled (see cancel_job, reused unchanged - the
/// watcher is a job like any other for start/cancel purposes, it just never
/// calls emit_done on its own). Each newly-stable file fires its own
/// `watch-folder-file` event rather than going through the job-progress
/// channel, since that channel's shape (one result per job) doesn't fit a
/// job that reports many results over an open-ended lifetime.
/// One poll's worth of the stability check, pulled out as a pure function
/// so the countdown/reset logic is unit-testable without real sleeps or a
/// real filesystem. Returns true when `path` has just become stable (size
/// unchanged for STABLE_FOR) and should be reported - mutates `pending` to
/// track/clear its countdown either way.
fn check_stable(
    pending: &mut HashMap<PathBuf, (u64, Instant)>,
    path: &Path,
    size: u64,
    now: Instant,
) -> bool {
    match pending.get(path) {
        Some(&(last_size, first_seen)) if last_size == size => {
            if now.duration_since(first_seen) >= STABLE_FOR {
                pending.remove(path);
                true
            } else {
                false
            }
        }
        _ => {
            // First sighting, or still growing - (re)start the stability
            // countdown from here.
            pending.insert(path.to_path_buf(), (size, now));
            false
        }
    }
}

pub fn run(app: AppHandle, job_id: String, handle: Arc<JobHandle>, folder: String) {
    let mut seen = list_videos(&folder);
    let mut pending: HashMap<PathBuf, (u64, Instant)> = HashMap::new();

    while !handle.is_cancelled() {
        if let Ok(rd) = std::fs::read_dir(&folder) {
            for entry in rd.filter_map(|e| e.ok()) {
                let path = entry.path();
                if !is_video(&path) || seen.contains(&path) {
                    continue;
                }
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                if check_stable(&mut pending, &path, size, Instant::now()) {
                    seen.insert(path.clone());
                    let _ = app.emit(
                        "watch-folder-file",
                        WatchEvent {
                            job_id: job_id.clone(),
                            path: path.to_string_lossy().into_owned(),
                        },
                    );
                }
            }
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_that_keeps_growing_never_fires() {
        let mut pending = HashMap::new();
        let path = PathBuf::from("clip.mp4");
        let t0 = Instant::now();
        assert!(!check_stable(&mut pending, &path, 100, t0));
        assert!(!check_stable(&mut pending, &path, 200, t0 + Duration::from_secs(3)));
        assert!(!check_stable(&mut pending, &path, 300, t0 + Duration::from_secs(6)));
        // Still growing at every check - the countdown keeps resetting, so
        // even well past STABLE_FOR from the first sighting it never fires.
        assert!(!check_stable(&mut pending, &path, 400, t0 + Duration::from_secs(20)));
    }

    #[test]
    fn a_file_that_stops_growing_fires_once_after_the_stable_window() {
        let mut pending = HashMap::new();
        let path = PathBuf::from("clip.mp4");
        let t0 = Instant::now();
        assert!(!check_stable(&mut pending, &path, 500, t0));
        // Same size, but not long enough yet.
        assert!(!check_stable(&mut pending, &path, 500, t0 + Duration::from_secs(3)));
        // Same size, now past STABLE_FOR since first sighting.
        assert!(check_stable(&mut pending, &path, 500, t0 + Duration::from_secs(6)));
        // Fired once - the entry is cleared, so immediately re-checking the
        // same size doesn't fire again (the caller adds it to `seen`
        // instead, but check_stable's own contract is "don't double-report").
        assert!(!check_stable(&mut pending, &path, 500, t0 + Duration::from_secs(7)));
    }

    #[test]
    fn is_video_matches_common_extensions_case_insensitively() {
        assert!(is_video(Path::new("clip.MP4")));
        assert!(is_video(Path::new("clip.mkv")));
        assert!(!is_video(Path::new("clip.txt")));
        assert!(!is_video(Path::new("clip")));
    }
}

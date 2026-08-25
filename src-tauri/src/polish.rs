//! Optional local-LLM transcript cleanup: catches misheard names and words
//! that whisper's own confidence already flagged, and nothing else.
//!
//! This is deliberately narrow. The model never sees or edits the whole
//! transcript at once - tried that first and it fell apart, mixing up word
//! indices and inventing text (see 05-build-log.md). Instead it is shown
//! exactly one flagged word in its sentence, marked in «guillemets», and
//! asked what that one word most likely was. That is a task a 3B model
//! answers reliably; rewriting a paragraph is not.
//!
//! Runs entirely offline via llama-server (bundled the same way whisper-cli
//! and the sherpa-onnx tools are - see scripts/get-sidecars.ps1) with a small
//! instruct model. A run spawns the server once, asks it about every flagged
//! word in the transcript while it is warm (prompt caching makes the 2nd+
//! request about 7x faster than the first - measured, not assumed), then
//! shuts it down. Every proposed change is returned to the frontend for
//! review; this module never edits a transcript itself.

use std::io::{Read, Write};
#[cfg(test)]
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::jobs::{emit_done, emit_error, emit_progress, JobHandle};
use crate::sidecar;

const SUBDIR: &str = "llama";
const MODEL_FILE: &str = "qwen2.5-3b-instruct-q4_k_m.gguf";
const HEALTH_TIMEOUT: Duration = Duration::from_secs(30);
/// ~1.96GB (q4_k_m). Named explicitly rather than computed so a stale
/// partial download from an interrupted run can never be mistaken for a
/// complete one - see download() below.
const MODEL_SIZE_BYTES: u64 = 1_976_000_000;
const MODEL_URL: &str =
    "https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf";

/// Where the (large, optional, user-downloaded) model lives - the same
/// app_data_dir/models folder whisper's own models are downloaded into (see
/// models::models_dir), not next to llama-server.exe in binaries/llama/.
///
/// This split exists because NSIS cannot bundle the model: a real local
/// build with the ~2GB .gguf placed in binaries/llama/ for bundling failed
/// makensis with "Internal compiler error #12345: error mmapping file ...
/// out of range" - a known limitation packaging very large single files.
/// llama-server.exe and its ~17MB of DLLs are small enough to bundle
/// normally and still ship via scripts/get-sidecars.ps1 + externalBin; only
/// the model moved to a runtime download, exactly like whisper's own
/// large-v3 (3.1GB) already works.
fn model_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("models");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn model_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(model_dir(app)?.join(MODEL_FILE))
}

/// One word whisper flagged as uncertain, with enough surrounding text for
/// the model to guess from context.
pub struct Candidate {
    pub seg_id: String,
    pub word_idx: usize,
    /// The sentence this word sits in, with the word itself already wrapped
    /// in guillemets by the caller.
    pub marked_sentence: String,
    pub original: String,
}

#[derive(Serialize, Clone)]
pub struct Suggestion {
    pub seg_id: String,
    pub word_idx: usize,
    pub original: String,
    pub suggested: String,
}

pub struct Server {
    child: Child,
    port: u16,
    client: reqwest::blocking::Client,
}

impl Drop for Server {
    fn drop(&mut self) {
        // Best-effort: if this fails the OS reclaims the process when
        // ClipCaption itself exits, same as every other sidecar here.
        let _ = self.child.kill();
    }
}

/// Starts llama-server if the sidecar and model are both present, and waits
/// for it to report healthy. Returns None - never an error - when either is
/// missing, matching the "enhancement, not a requirement" pattern used for
/// diarization and stereo pan: a machine without the ~2GB model still gets a
/// full transcript, just without the polish pass.
pub fn start(app: &AppHandle) -> Option<Server> {
    let exe = sidecar::resolve_in(SUBDIR, "llama-server");
    let model = model_path(app).ok()?;
    if !exe.exists() || !model.exists() {
        return None;
    }

    let port = free_port()?;
    let threads = std::thread::available_parallelism()
        .map(|n| n.get().saturating_sub(1).max(1))
        .unwrap_or(4)
        .to_string();

    let child = sidecar::command_in(SUBDIR, "llama-server")
        .args([
            "-m",
            &model.to_string_lossy(),
            "--port",
            &port.to_string(),
            "-t",
            &threads,
            // Small context: one sentence plus a handful of few-shot examples
            // never approaches this. Keeping it small keeps memory and the
            // KV cache (which is what makes repeated calls fast) small too.
            "-c",
            "4096",
            "--log-disable",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    let mut server = Server {
        child,
        port,
        client: reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(20))
            .build()
            .ok()?,
    };

    if !server.wait_healthy() {
        return None;
    }
    Some(server)
}

/// Finds a free localhost port by asking the OS for one and releasing it
/// immediately - a real bind/listen, not a guess, so this cannot collide
/// with another program already listening. The gap between releasing it
/// here and llama-server binding it is the same unavoidable race every
/// "find a free port" approach has; not retried at the call site because
/// losing that race just fails start() cleanly, same as the model being
/// absent.
fn free_port() -> Option<u16> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").ok()?;
    listener.local_addr().ok().map(|a| a.port())
}

/// The frontend's own Segment/WordSpan carry timing, speaker, pan and
/// intensity this pass has no use for - these mirror only what it actually
/// needs (id/text/confidence), independently of transcribe.rs's output
/// shape, so review requests deserialize cleanly without coupling the two.
#[derive(Deserialize)]
pub struct ReviewWord {
    pub text: String,
    #[serde(default)]
    pub confidence: f32,
}

#[derive(Deserialize)]
pub struct ReviewSegment {
    pub id: String,
    pub words: Vec<ReviewWord>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRequest {
    pub segments: Vec<ReviewSegment>,
    pub players: Vec<String>,
    /// Words scoring below this are reviewed; matches the frontend's own
    /// UNSURE_BELOW (lib/captions.ts) so what gets underlined in the
    /// transcript is exactly what this pass looks at - passed through
    /// rather than duplicated as a second constant that could drift.
    pub threshold: f32,
}

/// True when the sidecar and model are both present, so the frontend can
/// show or hide the "Clean up transcript" action without launching a job
/// just to find out it will do nothing.
pub fn available(app: &AppHandle) -> bool {
    sidecar::resolve_in(SUBDIR, "llama-server").exists()
        && model_path(app).map(|p| p.exists()).unwrap_or(false)
}

/// Downloads the cleanup model into app_data_dir/models (see model_path) -
/// the same resumable-download shape as models::download for whisper's own
/// models, kept as its own small copy rather than generalizing that
/// function: ModelSpec/MODELS there is whisper-specific (dtw_preset,
/// hf_repo, capability_only), and bending it to also describe a GGUF chat
/// model from a different HuggingFace repo would cost more clarity than the
/// ~40 lines of duplication saves.
pub fn download(app: AppHandle, job_id: String, handle: Arc<JobHandle>) {
    let stage = "downloading";
    let dest = match model_path(&app) {
        Ok(p) => p,
        Err(e) => {
            emit_error(&app, &job_id, stage, e);
            return;
        }
    };
    if dest.exists() {
        emit_done(&app, &job_id, stage, None);
        return;
    }

    let result = (|| -> Result<(), String> {
        let client = reqwest::blocking::Client::builder()
            .timeout(None)
            .build()
            .map_err(|e| e.to_string())?;
        let mut resp = client.get(MODEL_URL).send().map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("Download failed: HTTP {}", resp.status()));
        }
        let total = resp.content_length().unwrap_or(MODEL_SIZE_BYTES);

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

pub fn run(app: AppHandle, job_id: String, handle: Arc<JobHandle>, req: ReviewRequest) {
    let result = run_inner(&app, &job_id, &handle, &req);
    match result {
        Ok(json) => emit_done(&app, &job_id, "polishing", Some(json)),
        Err(e) => {
            if handle.is_cancelled() {
                emit_error(&app, &job_id, "polishing", "Cancelled".into());
            } else {
                emit_error(&app, &job_id, "polishing", e);
            }
        }
    }
}

fn run_inner(
    app: &AppHandle,
    job_id: &str,
    handle: &Arc<JobHandle>,
    req: &ReviewRequest,
) -> Result<String, String> {
    let candidates: Vec<Candidate> = req
        .segments
        .iter()
        .flat_map(|seg| {
            seg.words
                .iter()
                .enumerate()
                .filter(|(_, w)| w.confidence < req.threshold)
                .map(|(idx, w)| Candidate {
                    seg_id: seg.id.clone(),
                    word_idx: idx,
                    marked_sentence: mark_sentence(&seg.words, idx),
                    original: w.text.clone(),
                })
                .collect::<Vec<_>>()
        })
        .collect();

    if candidates.is_empty() {
        return serde_json::to_string(&Vec::<Suggestion>::new()).map_err(|e| e.to_string());
    }

    let server = start(app).ok_or_else(|| {
        "The local cleanup model isn't installed - download it from the Transcript tab first (about 2GB). It's optional; everything else works without it."
            .to_string()
    })?;

    let total = candidates.len();
    let mut out = Vec::with_capacity(total);
    for (i, candidate) in candidates.iter().enumerate() {
        if handle.is_cancelled() {
            return Err("Cancelled".into());
        }
        if let Some(s) = server.correct(candidate, &req.players) {
            out.push(s);
        }
        emit_progress(
            app,
            job_id,
            "polishing",
            (i + 1) as f32 / total as f32,
            None,
        );
    }
    serde_json::to_string(&out).map_err(|e| e.to_string())
}

/// Renders one segment's words as a sentence with the word at `mark_idx`
/// wrapped in guillemets - the exact format the few-shot examples use, so
/// the model sees the same shape it was shown answers for.
fn mark_sentence(words: &[ReviewWord], mark_idx: usize) -> String {
    words
        .iter()
        .enumerate()
        .map(|(i, w)| {
            if i == mark_idx {
                format!("«{}»", w.text)
            } else {
                w.text.clone()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

impl Server {
    fn wait_healthy(&mut self) -> bool {
        let deadline = Instant::now() + HEALTH_TIMEOUT;
        while Instant::now() < deadline {
            if let Ok(resp) = self
                .client
                .get(format!("http://127.0.0.1:{}/health", self.port))
                .send()
            {
                if resp.status().is_success() {
                    return true;
                }
            }
            // If the process has already died, do not burn the rest of the
            // timeout polling a socket nothing will ever answer on.
            if let Ok(Some(_)) = self.child.try_wait() {
                return false;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        false
    }

    /// Asks about one flagged word. Returns Some only when the model
    /// actually proposes something different - never a "correction" back to
    /// the exact text it started with.
    pub fn correct(&self, candidate: &Candidate, players: &[String]) -> Option<Suggestion> {
        let answer = self.ask(&candidate.marked_sentence, players)?;
        if is_no_op(&answer, &candidate.original) {
            return None;
        }
        Some(Suggestion {
            seg_id: candidate.seg_id.clone(),
            word_idx: candidate.word_idx,
            original: candidate.original.clone(),
            suggested: answer,
        })
    }

    fn ask(&self, marked_sentence: &str, players: &[String]) -> Option<String> {
        let player_line = if players.is_empty() {
            String::new()
        } else {
            format!("Players: {}.\n", players.join(", "))
        };
        let body = ChatRequest {
            messages: prompt_messages(&format!("{player_line}Sentence: {marked_sentence}")),
            temperature: 0.0,
            max_tokens: 24,
            cache_prompt: true,
        };
        let resp: ChatResponse = self
            .client
            .post(format!(
                "http://127.0.0.1:{}/v1/chat/completions",
                self.port
            ))
            .json(&body)
            .send()
            .ok()?
            .json()
            .ok()?;
        let text = resp.choices.into_iter().next()?.message.content;
        Some(
            text.trim()
                .trim_matches(['"', '\u{201c}', '\u{201d}'])
                .to_string(),
        )
    }
}

/// True when the model's answer is not actually proposing a change - either
/// the literal "SAME" sentinel, or (measured against the real model: it does
/// not always say the sentinel) text that is the same word once case and
/// surrounding punctuation are ignored.
fn is_no_op(answer: &str, original: &str) -> bool {
    if answer.eq_ignore_ascii_case("same") {
        return true;
    }
    let norm = |s: &str| {
        s.trim()
            .trim_matches(|c: char| !c.is_alphanumeric())
            .to_lowercase()
    };
    norm(answer) == norm(original)
}

const SYSTEM_PROMPT: &str = "You fix speech-to-text mistakes in a transcript of friends playing a co-op game together. You are shown one sentence with the uncertain word or phrase marked in guillemets (« »). Reply with ONLY the corrected text for that marked spot - no quotes, no punctuation explanation, nothing else. If the marked text is probably already correct, reply exactly SAME.";

/// The few-shot examples that turned this from unreliable to accurate in
/// testing (see 05-build-log.md): one worked example of a name fix, one of
/// correctly leaving a real word alone, one of a subtle single-word fix.
/// Removing any of the three measurably hurt either accuracy or
/// output-format compliance in that testing - keep all three.
fn prompt_messages(final_user_turn: &str) -> Vec<ChatMessage> {
    let mut m = vec![ChatMessage::system(SYSTEM_PROMPT)];
    m.push(ChatMessage::user(
        "Players: Murph, Aaron, Luke, Christian.\nSentence: Wait, «Chris and» torch.",
    ));
    m.push(ChatMessage::assistant("Christian"));
    m.push(ChatMessage::user(
        "Players: Murph, Aaron, Luke, Christian.\nSentence: That «Mimic» has got a great ass!",
    ));
    m.push(ChatMessage::assistant("SAME"));
    m.push(ChatMessage::user(
        "Players: Murph, Aaron, Luke, Christian.\nSentence: You have to go «that wat».",
    ));
    m.push(ChatMessage::assistant("that way"));
    m.push(ChatMessage::user(final_user_turn));
    m
}

#[derive(Serialize)]
struct ChatRequest {
    messages: Vec<ChatMessage>,
    temperature: f32,
    max_tokens: u32,
    cache_prompt: bool,
}

#[derive(Serialize, Deserialize, Clone)]
struct ChatMessage {
    role: String,
    content: String,
}

impl ChatMessage {
    fn system(s: &str) -> Self {
        Self {
            role: "system".into(),
            content: s.into(),
        }
    }
    fn user(s: &str) -> Self {
        Self {
            role: "user".into(),
            content: s.into(),
        }
    }
    fn assistant(s: &str) -> Self {
        Self {
            role: "assistant".into(),
            content: s.into(),
        }
    }
}

#[derive(Deserialize)]
struct ChatResponse {
    choices: Vec<ChatChoice>,
}

#[derive(Deserialize)]
struct ChatChoice {
    message: ChatMessage,
}

/// True if something is listening on 127.0.0.1:port - only used by tests,
/// which need to tell "the port is free" from "something is already bound
/// to it" without depending on llama-server actually running.
#[cfg(test)]
fn port_is_taken(port: u16) -> bool {
    TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}").parse().unwrap(),
        Duration::from_millis(200),
    )
    .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_sentinel_is_a_no_op() {
        assert!(is_no_op("SAME", "urethra-"));
        assert!(is_no_op("same", "urethra-"));
    }

    #[test]
    fn echoing_the_original_back_is_a_no_op_even_without_the_sentinel() {
        // Measured against the real model: it does not always emit the
        // sentinel, sometimes it just repeats the word with different
        // trailing punctuation.
        assert!(is_no_op("urethra-", "urethra-\""));
        assert!(is_no_op("Mimic", "Mimic"));
        assert!(is_no_op("great", "Great!"));
    }

    #[test]
    fn a_genuine_correction_is_not_a_no_op() {
        assert!(!is_no_op("Christian", "Chris and"));
        assert!(!is_no_op("that way", "that wat"));
    }

    #[test]
    fn free_port_returns_a_port_nothing_is_listening_on_yet() {
        let port = free_port().expect("OS should hand out a port");
        assert!(!port_is_taken(port));
    }

    // start()/available() need a real AppHandle (for app_data_dir), which
    // only exists inside a running Tauri app - not constructible in a plain
    // #[test]. Their "never panics, returns None/false without the model"
    // contract mirrors diarize::run / spatial::analyze and is exercised by
    // actually running the app without the model downloaded, not by a unit
    // test here.
}

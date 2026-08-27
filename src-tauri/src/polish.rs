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

/// Below this, a proposed fix is confident enough to apply without asking -
/// above every genuinely-correct answer measured, comfortably below every
/// wrong one. Measured against 9 real cases on this exact prompt (see
/// 05-build-log.md): every reasonable answer (a correct name fix, a
/// correct SAME refusal, even an out-of-distribution name the model
/// sensibly left alone) scored 91-100%; every wrong or garbled answer
/// scored 25-35%. The gap between those two clusters is wide enough that
/// the exact threshold isn't sensitive - 80% sits with real margin on both
/// sides rather than splitting the difference.
///
/// A word is only as trustworthy as its LEAST confident token, same
/// reasoning as WordSpan::confidence in transcribe.rs: averaging would let
/// a confident first guess ("Chris") hide a low-confidence, actually-wrong
/// continuation (" and" instead of "tian").
///
/// Not read anywhere in this crate: the actual tiering DECISION and the
/// edit itself both happen in the frontend (src/store.ts's own copy of this
/// same constant, kept in sync by hand and cross-referenced from
/// Suggestion::confidence's doc comment below), since Rust never touches
/// segments directly. Kept here anyway as the canonical, measured value -
/// deleting it would leave that doc comment pointing at nothing.
#[allow(dead_code)]
pub const AUTO_APPLY_CONFIDENCE: f32 = 0.80;

#[derive(Serialize, Clone)]
pub struct Suggestion {
    pub seg_id: String,
    pub word_idx: usize,
    pub original: String,
    pub suggested: String,
    /// The model's own confidence in `suggested`, 0..1 - the minimum
    /// per-token probability across its answer. The frontend applies
    /// anything at or above AUTO_APPLY_CONFIDENCE immediately; everything
    /// else goes to the review list. Rust reports the number; the actual
    /// tiering decision and the edit itself both happen in the store, same
    /// as every other transcript mutation - this module never touches
    /// segments directly.
    pub confidence: f32,
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

// ---------------- title / hook / hashtag generation ----------------
//
// A second, separate use of the same local model - competitors charge for
// cloud metadata generation; this is free and never leaves the machine.
// Deliberately a different shape of task than the word-correction pass
// above: generating a few lines of freeform marketing copy from a whole
// transcript tolerates imperfection in a way that correcting one exact
// word does not, so the "never show it more than one sentence" caution in
// this module's own doc comment doesn't apply here the same way.

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataRequest {
    pub transcript: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipMetadata {
    pub title: String,
    pub hook: String,
    pub hashtags: Vec<String>,
}

pub fn generate_metadata(app: AppHandle, job_id: String, handle: Arc<JobHandle>, req: MetadataRequest) {
    let stage = "metadata";
    let result = generate_metadata_inner(&app, &handle, &req);
    match result {
        Ok(json) => emit_done(&app, &job_id, stage, Some(json)),
        Err(e) => {
            if handle.is_cancelled() {
                emit_error(&app, &job_id, stage, "Cancelled".into());
            } else {
                emit_error(&app, &job_id, stage, e);
            }
        }
    }
}

fn generate_metadata_inner(
    app: &AppHandle,
    handle: &Arc<JobHandle>,
    req: &MetadataRequest,
) -> Result<String, String> {
    if req.transcript.trim().is_empty() {
        return Err("No transcript to work from - caption this clip first.".into());
    }
    let server = start(app).ok_or_else(|| {
        "The local cleanup model isn't installed - download it from the Transcript tab first (about 2GB). It's optional; everything else works without it."
            .to_string()
    })?;
    if handle.is_cancelled() {
        return Err("Cancelled".into());
    }
    let metadata = server
        .suggest_metadata(&req.transcript)
        .ok_or("The model didn't return a usable answer - try again.")?;
    serde_json::to_string(&metadata).map_err(|e| e.to_string())
}

const METADATA_SYSTEM_PROMPT: &str = "You write short, punchy social-media metadata for clips of friends playing co-op games together, based on a transcript of what was said. Reply in EXACTLY this three-line format, nothing else:\nTITLE: <a short, catchy title, under 60 characters>\nHOOK: <one attention-grabbing line for the first second of the video, under 100 characters>\nHASHTAGS: <5 to 8 relevant hashtags separated by spaces, each starting with #, lowercase, no spaces inside a tag>";

impl Server {
    /// Cap how much transcript text gets sent - a long clip's full
    /// transcript could blow the small context window this server is
    /// deliberately run with (see start()'s own comment); the model only
    /// needs enough to get the gist of what happened, not every word.
    fn suggest_metadata(&self, transcript: &str) -> Option<ClipMetadata> {
        const MAX_CHARS: usize = 3000;
        let clipped: String = transcript.chars().take(MAX_CHARS).collect();

        let body = ChatRequest {
            messages: vec![
                ChatMessage::system(METADATA_SYSTEM_PROMPT),
                ChatMessage::user(&format!("Transcript:\n{clipped}")),
            ],
            temperature: 0.7,
            max_tokens: 200,
            cache_prompt: false,
            logprobs: false,
            top_logprobs: None,
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
        parse_metadata(&text)
    }
}

/// Parses the TITLE/HOOK/HASHTAGS format asked for above. Line-prefix
/// matching (not a rigid line-position assumption) so a model that adds a
/// blank line or reorders slightly still parses, rather than a strict
/// three-line-exactly format failing on the first minor deviation.
fn parse_metadata(text: &str) -> Option<ClipMetadata> {
    let mut title = None;
    let mut hook = None;
    let mut hashtags = None;
    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = strip_prefix_ci(line, "TITLE:") {
            title = Some(rest.trim().to_string());
        } else if let Some(rest) = strip_prefix_ci(line, "HOOK:") {
            hook = Some(rest.trim().to_string());
        } else if let Some(rest) = strip_prefix_ci(line, "HASHTAGS:") {
            hashtags = Some(
                rest.split_whitespace()
                    .map(|t| t.trim_start_matches('#').to_lowercase())
                    .filter(|t| !t.is_empty())
                    .map(|t| format!("#{t}"))
                    .collect::<Vec<_>>(),
            );
        }
    }
    let title = title.filter(|t| !t.is_empty())?;
    let hook = hook.filter(|h| !h.is_empty())?;
    let hashtags = hashtags.filter(|h| !h.is_empty())?;
    Some(ClipMetadata { title, hook, hashtags })
}

fn strip_prefix_ci<'a>(line: &'a str, prefix: &str) -> Option<&'a str> {
    if line.len() >= prefix.len() && line[..prefix.len()].eq_ignore_ascii_case(prefix) {
        Some(&line[prefix.len()..])
    } else {
        None
    }
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
        let (answer, confidence) = self.ask(&candidate.marked_sentence, players)?;
        if is_no_op(&answer, &candidate.original) {
            return None;
        }
        Some(Suggestion {
            seg_id: candidate.seg_id.clone(),
            word_idx: candidate.word_idx,
            original: candidate.original.clone(),
            suggested: answer,
            confidence,
        })
    }

    /// Returns the answer text plus how confident the model was in it - the
    /// minimum per-token probability across the answer (not the average;
    /// see AUTO_APPLY_CONFIDENCE for why). The end-of-turn token is dropped
    /// before taking that minimum: it is always near-certain once the model
    /// has decided what to say, so including it would just dilute the
    /// number the answer's own tokens actually carry.
    fn ask(&self, marked_sentence: &str, players: &[String]) -> Option<(String, f32)> {
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
            logprobs: true,
            top_logprobs: Some(1),
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
        let choice = resp.choices.into_iter().next()?;
        let text = choice
            .message
            .content
            .trim()
            .trim_matches(['"', '\u{201c}', '\u{201d}'])
            .to_string();

        // Missing logprobs (an older/different server build, say) default to
        // 0.0 - genuinely uncertain - not 1.0. Defaulting to "certain" would
        // mean every suggestion silently auto-applies the moment this signal
        // isn't available, which is a worse failure mode than just falling
        // back to manual review for everything.
        let confidence = choice
            .logprobs
            .map(|lp| {
                lp.content
                    .iter()
                    .filter(|t| !t.token.is_empty())
                    .map(|t| t.logprob.exp())
                    .fold(f32::INFINITY, f32::min)
            })
            .filter(|c| c.is_finite())
            .unwrap_or(0.0);

        Some((text, confidence))
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
    /// llama-server's OpenAI-compatible endpoint returns per-token
    /// probabilities when asked - confirmed against the real server, not
    /// assumed from the OpenAI spec it mimics. This is the actual signal
    /// AUTO_APPLY_CONFIDENCE is built on.
    logprobs: bool,
    /// Must be omitted (not just falsy) when logprobs is false - confirmed
    /// against the real server, which rejects `top_logprobs` present
    /// alongside `logprobs: false` with a 400 ("top_logprobs requires
    /// logprobs to be set to true") rather than ignoring it.
    #[serde(skip_serializing_if = "Option::is_none")]
    top_logprobs: Option<u32>,
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
    #[serde(default)]
    logprobs: Option<ChatLogprobs>,
}

#[derive(Deserialize)]
struct ChatLogprobs {
    content: Vec<ChatTokenLogprob>,
}

#[derive(Deserialize)]
struct ChatTokenLogprob {
    token: String,
    logprob: f32,
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

    /// A real response captured from llama-server (b10621) with
    /// logprobs+top_logprobs requested, to confirm the wire format assumed
    /// by ChatResponse/ChatChoice/ChatLogprobs is actually what the server
    /// sends - not reasoned from the OpenAI spec it mimics. Trimmed to the
    /// fields that matter; the real response also carries id/bytes/
    /// top_logprobs per token, which the unknown-fields-ignored default
    /// deserialization here correctly drops.
    #[test]
    fn deserializes_a_real_captured_logprobs_response() {
        let raw = r#"{
          "choices": [{
            "finish_reason": "stop",
            "index": 0,
            "message": { "role": "assistant", "content": "Christian" },
            "logprobs": {
              "content": [
                {"id": 30574, "token": "Christ", "bytes": [67,104,114,105,115,116], "logprob": -0.045, "top_logprobs": []},
                {"id": 1103,  "token": "ian",    "bytes": [105,97,110],             "logprob": -0.002, "top_logprobs": []},
                {"id": 151645,"token": "",       "bytes": [],                       "logprob": -0.0005,"top_logprobs": []}
              ]
            }
          }],
          "created": 1787720327,
          "model": "qwen2.5-3b-instruct-q4_k_m.gguf"
        }"#;
        let resp: ChatResponse = serde_json::from_str(raw).expect("should deserialize");
        let choice = resp.choices.into_iter().next().unwrap();
        assert_eq!(choice.message.content, "Christian");
        let lp = choice.logprobs.expect("logprobs should be present");
        assert_eq!(lp.content.len(), 3);
        let min_conf = lp
            .content
            .iter()
            .filter(|t| !t.token.is_empty())
            .map(|t| t.logprob.exp())
            .fold(f32::INFINITY, f32::min);
        // exp(-0.045) ~= 0.956 is the lower of the two real answer tokens;
        // the empty end-of-turn token must be excluded or this would read
        // exp(-0.0005) ~= 0.9995 instead, hiding the real minimum.
        assert!((min_conf - 0.956).abs() < 0.01, "got {min_conf}");
    }

    #[test]
    fn free_port_returns_a_port_nothing_is_listening_on_yet() {
        let port = free_port().expect("OS should hand out a port");
        assert!(!port_is_taken(port));
    }

    #[test]
    fn parses_a_clean_three_line_answer() {
        let text = "TITLE: We Got Wiped by a Mimic\nHOOK: This chest was NOT a chest\nHASHTAGS: #gaming #coop #fail #funny #twitchclips";
        let m = parse_metadata(text).expect("should parse");
        assert_eq!(m.title, "We Got Wiped by a Mimic");
        assert_eq!(m.hook, "This chest was NOT a chest");
        assert_eq!(m.hashtags, vec!["#gaming", "#coop", "#fail", "#funny", "#twitchclips"]);
    }

    #[test]
    fn parses_lowercase_labels_and_blank_lines_and_normalizes_hashtags() {
        // Real models don't always follow a format exactly - tolerate
        // lowercase labels, a stray blank line, and hashtags the model
        // forgot to prefix with # or wrote in mixed case.
        let text = "\ntitle: Clutch 1v3 Ace\n\nhook: Nobody believed this would work\nhashtags: Gaming COOP #ace clutch";
        let m = parse_metadata(text).expect("should parse");
        assert_eq!(m.title, "Clutch 1v3 Ace");
        assert_eq!(m.hashtags, vec!["#gaming", "#coop", "#ace", "#clutch"]);
    }

    #[test]
    fn missing_a_required_section_fails_to_parse() {
        assert!(parse_metadata("TITLE: Only a title\nHOOK: and a hook").is_none());
        assert!(parse_metadata("just some prose with no labels at all").is_none());
    }

    // start()/available() need a real AppHandle (for app_data_dir), which
    // only exists inside a running Tauri app - not constructible in a plain
    // #[test]. Their "never panics, returns None/false without the model"
    // contract mirrors diarize::run / spatial::analyze and is exercised by
    // actually running the app without the model downloaded, not by a unit
    // test here.
}

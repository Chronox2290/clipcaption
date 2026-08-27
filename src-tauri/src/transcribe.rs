use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::process::Stdio;
use std::sync::Arc;
use tauri::{AppHandle, Manager};

use crate::diarize;
use crate::jobs::{emit_done, emit_error, emit_progress, JobHandle};
use crate::models;
use crate::spatial;
use crate::sidecar;

#[derive(Serialize, Debug)]
pub struct WordSpan {
    pub text: String,
    pub start: f64,
    pub end: f64,
    /// Lowest token probability in this word, 0..1. A word is only as
    /// trustworthy as its least certain piece, so this takes the minimum
    /// rather than the average - averaging hides a confident "Christ" glued
    /// to a guessed "ian".
    pub confidence: f32,
}

#[derive(Serialize, Debug)]
pub struct Segment {
    pub id: String,
    pub words: Vec<WordSpan>,
    /// A real speaker index from voice-fingerprint clustering (see
    /// diarize.rs) — unlike the old tinydiarize turn-alternation this
    /// replaced, the same person gets the same index if they speak again
    /// later in the clip, and there can be more than two. Null when the
    /// diarization sidecar/models weren't available (never blocks getting a
    /// transcript) or a segment's audio didn't overlap any detected speaker.
    pub speaker: Option<u32>,
    /// Where this line sits in the stereo field, -1 (hard left) to +1 (hard
    /// right), for captions that follow the voice across the screen. Null for
    /// mono sources, silence, or if the analysis pass failed - the caption
    /// then just sits centred.
    pub pan: Option<f32>,
    /// How loud this line is against the rest of the clip, 0 (the quietest
    /// speech present) to 1 (the loudest) - drives caption size, and the
    /// shake on a scream. Null on the same conditions as `pan`.
    pub intensity: Option<f32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TranscribeResult {
    segments: Vec<Segment>,
    /// RMS amplitude (0..1) per bucket, for drawing a waveform in the word
    /// timing editor — computed from the same 16kHz mono audio already
    /// extracted for Whisper, so it's free (no extra ffmpeg pass).
    waveform: Vec<f32>,
    /// Seconds spanned by each `waveform` bucket.
    waveform_step: f64,
    /// Full-video-timeline seconds that `waveform[0]` corresponds to (i.e.
    /// the same `offset` already added back onto word start/end times when a
    /// range was transcribed). The waveform editor needs this to line the
    /// waveform up with word times when only a highlight (not the whole
    /// clip) was transcribed.
    waveform_offset: f64,
    /// One voice-fingerprint embedding per distinct speaker id diarization
    /// found in this run (keyed by that *local* speaker index — see
    /// diarize::extract_speaker_embeddings). Empty when diarization found no
    /// speakers or the sidecar/model wasn't available; a speaker whose
    /// embedding extraction failed is simply missing its entry. The frontend
    /// uses this to match speakers against the user's saved names — matching
    /// happens there, not here, so the backend stays a stateless pass over
    /// whatever this one clip's audio contains.
    speaker_embeddings: std::collections::HashMap<u32, Vec<f32>>,
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
    /// Cross-attention DTW timestamp for this token, in centiseconds, or -1
    /// when whisper.cpp didn't compute one. This is the accurate timing that
    /// `-dtw` exists to produce; `offsets` is the coarse fallback, which for
    /// a segment whose tokens carry no timestamps of their own collapses to
    /// "every token starts and ends at the segment start".
    #[serde(default = "no_dtw")]
    t_dtw: i64,
    /// Whisper's own probability for this token, 0..1. Kept so the editor can
    /// point at the handful of words that are probably wrong instead of
    /// making you scrub the whole clip - which matters far more to how fast
    /// a clip ships than any decimal place of word error rate.
    #[serde(default = "full_confidence")]
    p: f32,
}

fn full_confidence() -> f32 {
    1.0
}

fn no_dtw() -> i64 {
    -1
}

/// What to transcribe and how. Grouped into a struct rather than passed as
/// eight positional arguments, where `start`/`end`/`prompt` in a row are easy
/// to transpose at a call site and impossible to catch by type.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub path: String,
    pub model: String,
    /// Transcribe only this range of the video, in seconds. None = all of it.
    pub start: Option<f64>,
    pub end: Option<f64>,
    /// Names and jargon to bias whisper toward (see build_prompt).
    pub prompt: Option<String>,
    /// How many people are talking, when the user knows. None lets
    /// diarization guess (see diarize::run for why that is worse).
    pub speaker_count: Option<u32>,
    /// Which audio stream to transcribe from, when the source has more than
    /// one (OBS's Advanced output mode can record mic and desktop/game
    /// audio onto separate tracks) - an index among AUDIO streams only,
    /// matching ffmpeg's `-map 0:a:N` (see media::list_audio_tracks). None
    /// uses ffmpeg's own default stream selection, same as before this
    /// existed. Highlight/death detection's own audio scan (analyze.rs)
    /// deliberately does NOT take this - it wants the full mixed/game
    /// track, not just voice.
    #[serde(default)]
    pub audio_track: Option<u32>,
}

pub fn run(app: AppHandle, job_id: String, handle: Arc<JobHandle>, req: Request) {
    let result = run_inner(&app, &job_id, &handle, &req);
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
    req: &Request,
) -> Result<String, String> {
    let Request { path, model, start, end, prompt, speaker_count, audio_track } = req;
    let (path, model) = (path.as_str(), model.as_str());
    let (start, end) = (*start, *end);
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
    if let Some(track) = audio_track {
        // Selects the Nth AUDIO stream specifically (see
        // media::list_audio_tracks) - lets a source with separate mic/game
        // tracks feed whisper the clean voice track directly, no AI
        // separation needed.
        extract_cmd.args(["-map", &format!("0:a:{track}")]);
    }
    let extract = extract_cmd
        .args([
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            // Game clips bury speech under music/SFX far more than the clean
            // audio Whisper is trained on. A high-pass to cut sub-vocal
            // rumble/bass, plus dynamic normalization to lift quiet speech
            // relative to loud game audio, measurably helps both what
            // Whisper transcribes and how confidently (hence accurately) it
            // times each word — deliberately conservative (no spectral
            // denoiser) so it can't introduce its own artifacts.
            "-af",
            "highpass=f=80,dynaudnorm=f=150:g=15:p=0.9",
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

    // Cross-attention DTW alignment for word timestamps — this is the single
    // biggest lever for accurate word timing. Without it, whisper.cpp buckets
    // words into ~20ms encoder-frame timestamp tokens, which is noticeably
    // imprecise; -dtw instead derives each word's timing from the model's own
    // attention weights. Every model this app offers has a matching built-in
    // alignment-head preset and needs no extra download — just this flag.
    // The preset string isn't always the model name verbatim (the large
    // models take dotted names like "large.v3" while their file names use
    // hyphens), so it's resolved through models::dtw_preset rather than
    // passed through directly.
    let dtw = models::dtw_preset(model);

    // Bind these as owned Strings first — the args Vec below borrows from
    // them, and (unlike the single-chained-expression form this replaced)
    // that borrow now needs to outlive more than one statement.
    let model_path_s = model_path.to_string_lossy().into_owned();
    let wav_s = wav.to_string_lossy().into_owned();
    let out_base_s = out_base.to_string_lossy().into_owned();

    // Whisper's initial prompt: text it treats as though it had just decoded
    // it, which biases spelling and vocabulary for what follows. Worth real
    // accuracy on proper nouns it has never heard (player and game names) and
    // on a strong regional accent, where its guess between two plausible
    // words is exactly what a prompt can tip. Capped because whisper only
    // accepts n_text_ctx/2 tokens and silently drops the excess otherwise.
    const PROMPT_MAX_CHARS: usize = 800;
    let prompt_s = build_prompt(prompt.as_deref(), PROMPT_MAX_CHARS);

    // Deliberately NOT passing --vad here. whisper.cpp's VAD maps each
    // segment's times back onto the real timeline but leaves every token
    // timestamp on the silence-stripped one it decoded, and word timing is
    // what this app lives on. Measured on a 2-minute game clip, scoring word
    // starts against the audio's own speech/silence mask: 80% land in speech
    // without VAD, versus 73% with it even using the best of three
    // reconstructions (per-segment shift 63%, stretch-to-segment 73%,
    // discard-token-times 72%). It also only saved 1.4s of 16s on this
    // speech-dense audio. Revisit only if whisper.cpp starts remapping token
    // timestamps too.
    let mut args: Vec<&str> = vec![
        "-m",
        &model_path_s,
        "-f",
        &wav_s,
        "-ojf", // output full JSON (with token timestamps)
        "-of",
        &out_base_s,
        "-t",
        &threads,
        "-pp", // print progress
        // Flash attention is ON by default in current whisper.cpp builds, and
        // whisper silently drops DTW when it's enabled:
        //   "dtw_token_timestamps is not supported with flash_attn - disabling"
        // It prints that to stderr and carries on, so -dtw below looked like
        // it was working while every token came back t_dtw = -1 and word
        // times fell back to `offsets`. Word timing matters far more here
        // than the modest speed flash attention buys.
        "-nfa",
        // The .en models are English-only anyway, but large-v3-turbo is
        // multilingual and will happily auto-detect a strong regional accent
        // as another language on noisy game audio. Pin it.
        "-l",
        "en",
        "-dtw",
        dtw,
    ];

    if !prompt_s.is_empty() {
        args.extend_from_slice(&["--prompt", &prompt_s]);
    }

    let mut child = sidecar::command("whisper-cli")
        .args(&args)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not run whisper-cli: {e}. Run scripts/get-sidecars.ps1 first."))?;

    let stderr = child.stderr.take();
    handle.set_child(child);

    let mut err_tail: std::collections::VecDeque<String> = std::collections::VecDeque::new();
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
            } else if !line.trim().is_empty() {
                if err_tail.len() >= 12 {
                    err_tail.pop_front();
                }
                err_tail.push_back(line);
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
        let detail: Vec<String> = err_tail.into_iter().collect();
        return Err(format!(
            "whisper-cli failed (exit: {:?}, path: {}): {}",
            status.code(),
            crate::sidecar::resolve("whisper-cli").display(),
            if detail.is_empty() {
                "no output — likely a missing DLL or a crash at startup".to_string()
            } else {
                detail.join(" | ")
            }
        ));
    }

    // 3. Parse JSON output into word-level segments
    let json_path = out_base.with_extension("json");
    let raw = std::fs::read_to_string(&json_path)
        .map_err(|e| format!("Could not read transcript output: {e}"))?;
    let parsed: WhisperOut =
        serde_json::from_str(&raw).map_err(|e| format!("Transcript parse error: {e}"))?;

    let mut segments = build_segments(parsed);

    // Real speaker diarization (see diarize.rs) — a separate pass over the
    // same WAV, run *before* the offset shift below since diarization's
    // timestamps are relative to this (possibly range-limited) clip, same
    // as the word times fresh out of whisper. Automatic, no toggle: quietly
    // does nothing if the sidecar/models aren't present rather than ever
    // blocking the transcript itself on it.
    let mut speaker_embeddings = std::collections::HashMap::new();
    if let Some(diarized) = diarize::run(&wav, *speaker_count) {
        segments = split_by_speaker(segments, &diarized);
        // Extracted from the same still-on-disk WAV, before it's deleted
        // below — one embedding per distinct speaker id, for the frontend to
        // match against the user's named speaker profiles.
        speaker_embeddings = diarize::extract_speaker_embeddings(&wav, &diarized);
    }

    // Stereo pan, on the same (possibly range-limited) timeline as the word
    // times above - so, like diarization, this has to run before the offset
    // shift below. Silently does nothing on mono sources or if ffmpeg fails.
    if let Some(pan_track) = spatial::analyze(path, start, end) {
        for seg in &mut segments {
            let (Some(first), Some(last)) = (seg.words.first(), seg.words.last()) else {
                continue;
            };
            if let Some(audio) = pan_track.span_for(first.start, last.end) {
                seg.pan = Some(audio.pan);
                seg.intensity = Some(audio.intensity);
            }
        }
    }

    // shift word times back onto the full-video timeline when a range was used
    if offset > 0.0 {
        for seg in &mut segments {
            for w in &mut seg.words {
                w.start += offset;
                w.end += offset;
            }
        }
    }

    // Waveform for the timing editor, read from the WAV before we delete it.
    // Cap total buckets so an hours-long whole-clip transcribe doesn't
    // balloon the JSON payload — short clips get fine ~10ms resolution,
    // long ones scale down gracefully.
    let (waveform, waveform_step) = read_wav_peaks(&wav, 20_000).unwrap_or_default();

    let _ = std::fs::remove_file(&wav);
    let _ = std::fs::remove_file(&json_path);

    serde_json::to_string(&TranscribeResult {
        segments,
        waveform,
        waveform_step,
        waveform_offset: offset,
        speaker_embeddings,
    })
    .map_err(|e| e.to_string())
}

/// Reads a mono 16-bit PCM WAV file and computes an RMS amplitude envelope
/// (0..1, mildly gamma-boosted so quiet speech is still visible) bucketed at
/// up to `max_buckets` buckets across the file's duration. Returns
/// (peaks, seconds_per_bucket); (vec![], 0.0) on any parse failure so a
/// waveform read glitch never breaks the transcript itself.
fn read_wav_peaks(path: &std::path::Path, max_buckets: usize) -> Option<(Vec<f32>, f64)> {
    let bytes = std::fs::read(path).ok()?;
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return None;
    }

    let mut pos = 12usize;
    let mut sample_rate: u32 = 16000;
    let mut bits_per_sample: u16 = 16;
    let mut channels: u16 = 1;
    let mut data: Option<&[u8]> = None;

    while pos + 8 <= bytes.len() {
        let chunk_id = &bytes[pos..pos + 4];
        let chunk_size = u32::from_le_bytes(bytes[pos + 4..pos + 8].try_into().ok()?) as usize;
        let body_start = pos + 8;
        let body_end = (body_start + chunk_size).min(bytes.len());
        let body = &bytes[body_start..body_end];

        if chunk_id == b"fmt " && body.len() >= 16 {
            channels = u16::from_le_bytes(body[2..4].try_into().ok()?);
            sample_rate = u32::from_le_bytes(body[4..8].try_into().ok()?);
            bits_per_sample = u16::from_le_bytes(body[14..16].try_into().ok()?);
        } else if chunk_id == b"data" {
            data = Some(body);
        }

        // chunks are word-aligned (padded to an even size)
        pos = body_start + chunk_size + (chunk_size % 2);
    }

    let data = data?;
    if bits_per_sample != 16 || channels == 0 || sample_rate == 0 {
        return None; // matches the format we always ask ffmpeg for
    }

    let samples: Vec<i16> = data
        .chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]))
        .collect();
    let frames = samples.len() / channels as usize;
    if frames == 0 {
        return Some((vec![], 0.0));
    }

    let duration = frames as f64 / sample_rate as f64;
    let step = (duration / max_buckets as f64).max(0.01);
    let frames_per_bucket = ((step * sample_rate as f64).round() as usize).max(1);

    let mut peaks = Vec::with_capacity(frames / frames_per_bucket + 1);
    let mut i = 0usize;
    while i < frames {
        let end = (i + frames_per_bucket).min(frames);
        let mut sum_sq = 0f64;
        let mut n = 0usize;
        for f in i..end {
            // mono-mix all channels for this frame
            let mut v = 0f64;
            for c in 0..channels as usize {
                v += samples[f * channels as usize + c] as f64 / 32768.0;
            }
            v /= channels as f64;
            sum_sq += v * v;
            n += 1;
        }
        let rms = if n > 0 { (sum_sq / n as f64).sqrt() } else { 0.0 };
        peaks.push((rms.sqrt().min(1.0)) as f32); // sqrt: gently lift quiet parts for visibility
        i = end;
    }

    Some((peaks, step))
}

/// Wraps the user's vocabulary list into whisper's initial prompt.
///
/// Whisper copies its prompt's *style* as well as its vocabulary, and a bare
/// comma-separated list is a disastrous style to copy: prompted with one,
/// transcription of a 2-minute clip came back almost entirely lowercase and
/// unpunctuated (2 of 12 segments capitalised, 1 punctuated) versus 41 of 42
/// with no prompt at all. Wrapping the same words in one properly written
/// sentence restores it (14 of 15 capitalised, 13 punctuated) while keeping
/// the vocabulary benefit. Text that already ends in sentence punctuation is
/// assumed to be a deliberately-written prompt and is passed through as-is.
fn build_prompt(raw: Option<&str>, max_chars: usize) -> String {
    let trimmed = raw.unwrap_or_default().trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let wrapped = if trimmed.ends_with(['.', '!', '?']) {
        trimmed.to_string()
    } else {
        format!("Names and terms you may hear: {}.", trimmed.trim_end_matches(&[',', ';'][..]))
    };
    wrapped.chars().take(max_chars).collect()
}

/// Re-cuts segments so each one belongs to a single speaker.
///
/// Whisper draws segment boundaries from pauses in the audio, with no idea
/// who is talking; in a game with proximity chat, two or three people talk
/// over each other constantly and land in one segment. Assigning that segment
/// a single speaker by majority overlap - which is what this replaced - threw
/// away the fact that the line has two authors, so their words rendered as
/// one run-on caption in one person's colour, and the timeline could only
/// show it in one lane.
///
/// Each word is attributed on its own, then consecutive words sharing a
/// speaker become a segment. Splitting per word rather than smoothing first
/// is deliberate: a word is already the smallest unit the rest of the
/// pipeline times and draws, so no new boundary is being invented.
fn split_by_speaker(segments: Vec<Segment>, diarized: &[diarize::SpeakerSegment]) -> Vec<Segment> {
    let mut out: Vec<Segment> = Vec::with_capacity(segments.len());

    for seg in segments {
        // Attribute every word first, so a lone unattributed word inside a
        // run can be absorbed below rather than splitting the line in three.
        let mut speakers: Vec<Option<u32>> = seg
            .words
            .iter()
            .map(|w| diarize::speaker_for_span(diarized, w.start, w.end))
            .collect();

        // A word whose own span didn't overlap any speaker turn (a gap, a
        // breath, a short word straddling a boundary) inherits the run it
        // sits in, rather than becoming a one-word "Unknown" fragment.
        for i in 0..speakers.len() {
            if speakers[i].is_none() {
                let before = speakers[..i].iter().rev().find_map(|s| *s);
                let after = speakers[i + 1..].iter().find_map(|s| *s);
                speakers[i] = match (before, after) {
                    (Some(b), Some(a)) if b == a => Some(b),
                    (Some(b), None) => Some(b),
                    (None, Some(a)) => Some(a),
                    _ => None,
                };
            }
        }

        let mut start = 0usize;
        let mut part = 0usize;
        for i in 1..=seg.words.len() {
            let boundary = i == seg.words.len() || speakers[i] != speakers[start];
            if !boundary {
                continue;
            }
            let words: Vec<WordSpan> = seg.words[start..i]
                .iter()
                .map(|w| WordSpan {
                    text: w.text.clone(),
                    start: w.start,
                    end: w.end,
                    confidence: w.confidence,
                })
                .collect();
            if !words.is_empty() {
                out.push(Segment {
                    // Suffixed only when a segment actually split, so ids stay
                    // stable (and recognisable) for the common single-speaker case.
                    id: if part == 0 && i == seg.words.len() {
                        seg.id.clone()
                    } else {
                        format!("{}_{}", seg.id, part)
                    },
                    words,
                    speaker: speakers[start],
                    pan: seg.pan,
                    intensity: seg.intensity,
                });
                part += 1;
            }
            start = i;
        }
    }

    out.sort_by(|a, b| {
        let (x, y) = (a.words.first().map(|w| w.start), b.words.first().map(|w| w.start));
        x.partial_cmp(&y).unwrap_or(std::cmp::Ordering::Equal)
    });
    out
}

/// Turns whisper's JSON into word-level segments.
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
        let seg_end = seg.offsets.to as f64 / 1000.0;

        if let Some(tokens) = seg.tokens {
            for tok in tokens {
                let t = tok.text.as_str();
                // skip special tokens like [_BEG_], [_TT_xx]
                if t.starts_with("[_") || t.trim().is_empty() {
                    continue;
                }
                // DTW gives one accurate *instant* per token rather than a
                // span; `offsets` is the fallback for builds/runs without it.
                let start = if tok.t_dtw >= 0 {
                    tok.t_dtw as f64 / 100.0 // centiseconds
                } else {
                    match &tok.offsets {
                        Some(o) => o.from as f64 / 1000.0,
                        None => continue,
                    }
                };

                let starts_word = t.starts_with(' ') || words.is_empty();
                if starts_word {
                    words.push(WordSpan {
                        text: t.trim().to_string(),
                        start,
                        end: start, // real end assigned in the pass below
                        confidence: tok.p,
                    });
                } else if let Some(last) = words.last_mut() {
                    // A word is only as trustworthy as its least certain piece.
                    last.confidence = last.confidence.min(tok.p);
                    // Punctuation and sub-word pieces join the word they
                    // belong to and deliberately do NOT move its end: a
                    // trailing "," routinely carries a timestamp that jumps
                    // backwards, and letting it set the end produced words
                    // ending *before* they start.
                    last.text.push_str(t.trim_end());
                }
            }
        }

        // Word timing is derived here rather than taken per-token, because
        // neither timing source gives a usable span on its own:
        //   - DTW yields a single instant per token, no end at all.
        //   - `offsets` collapses to zero-length words whenever whisper
        //     emitted no per-token timestamps for a segment (measured at 35%
        //     of all words on a real 2-minute game clip). A zero-length word
        //     can never satisfy the renderer's `t >= start && t <= end`, so
        //     those words were silently never drawn on screen.
        // A word therefore runs from its own start until the next word
        // starts. MAX_WORD caps that so the last word before a genuine pause
        // doesn't stretch across the whole silence - the caption paginator
        // reads the resulting gaps to decide where to clear the screen.
        const MIN_WORD: f64 = 0.06;
        const MAX_WORD: f64 = 1.5;
        for i in 1..words.len() {
            if words[i].start < words[i - 1].start {
                words[i].start = words[i - 1].start;
            }
        }
        for i in 0..words.len() {
            let next = if i + 1 < words.len() {
                words[i + 1].start
            } else {
                seg_end
            };
            let w = &mut words[i];
            w.end = next.clamp(w.start + MIN_WORD, w.start + MAX_WORD);
        }

        // Fallback: no usable tokens — split the segment text evenly
        if words.is_empty() {
            let seg_start = seg.offsets.from as f64 / 1000.0;
            let parts: Vec<&str> = text_trim.split_whitespace().collect();
            let n = parts.len().max(1) as f64;
            let dur = (seg_end - seg_start).max(0.1);
            for (i, p) in parts.iter().enumerate() {
                words.push(WordSpan {
                    text: (*p).to_string(),
                    start: seg_start + dur * (i as f64) / n,
                    end: seg_start + dur * ((i + 1) as f64) / n,
                    // This path only runs when a segment had no usable tokens
                    // at all, so there is no per-token probability to report.
                    // Unknown, not certain - flagged low so it surfaces for
                    // review rather than passing as trustworthy.
                    confidence: 0.0,
                });
            }
        }

        // drop empty-text words that can result from stray punctuation tokens
        words.retain(|w| !w.text.trim().is_empty());

        if !words.is_empty() {
            segments.push(Segment {
                id: format!("seg_{si}"),
                words,
                // Filled in afterward by a real diarization pass in
                // run_inner (see diarize.rs) — not known at this point.
                speaker: None,
                // Likewise, from the voice-dynamics pass (see spatial.rs).
                pan: None,
                intensity: None,
            });
        }
    }

    segments
}

#[cfg(test)]
mod speaker_split_tests {
    use super::*;
    use crate::diarize::SpeakerSegment;

    fn seg(words: &[(&str, f64, f64)]) -> Segment {
        Segment {
            id: "seg_0".into(),
            words: words
                .iter()
                .map(|(t, s, e)| WordSpan { text: (*t).into(), start: *s, end: *e, confidence: 1.0 })
                .collect(),
            speaker: None,
            pan: None,
            intensity: None,
        }
    }

    fn turns(t: &[(f64, f64, u32)]) -> Vec<SpeakerSegment> {
        t.iter().map(|(s, e, sp)| SpeakerSegment { start: *s, end: *e, speaker: *sp }).collect()
    }

    /// The proximity-chat case: whisper hears one continuous stretch of speech
    /// and makes it one segment, but two people are talking. Attributing the
    /// whole thing to whoever spoke most is what made two voices render as one
    /// run-on caption in one colour.
    #[test]
    fn one_segment_with_two_voices_splits_in_two() {
        let out = split_by_speaker(
            vec![seg(&[("Wait", 1.0, 1.4), ("Christian", 1.4, 2.0), ("no", 3.0, 3.4), ("stop", 3.4, 3.9)])],
            &turns(&[(0.5, 2.5, 0), (2.8, 4.5, 1)]),
        );
        assert_eq!(out.len(), 2, "expected one segment per speaker, got {out:?}");
        assert_eq!(out[0].speaker, Some(0));
        assert_eq!(out[0].words.len(), 2);
        assert_eq!(out[1].speaker, Some(1));
        assert_eq!(out[1].words.len(), 2);
    }

    /// A single speaker's segment must come through untouched - same id, same
    /// words, no gratuitous re-cutting of the common case.
    #[test]
    fn a_single_speaker_segment_is_left_alone() {
        let out = split_by_speaker(
            vec![seg(&[("all", 1.0, 1.3), ("mine", 1.3, 1.8)])],
            &turns(&[(0.0, 5.0, 2)]),
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].id, "seg_0");
        assert_eq!(out[0].speaker, Some(2));
    }

    /// A word landing in a gap between turns shouldn't become its own
    /// one-word "Unknown" fragment when the words either side agree.
    #[test]
    fn an_unattributed_word_between_two_of_the_same_speaker_is_absorbed() {
        let out = split_by_speaker(
            vec![seg(&[("I", 1.0, 1.2), ("uh", 2.6, 2.7), ("guess", 4.0, 4.4)])],
            &turns(&[(0.9, 1.5, 0), (3.8, 4.6, 0)]),
        );
        assert_eq!(out.len(), 1, "should stay one line: {out:?}");
        assert_eq!(out[0].words.len(), 3);
        assert_eq!(out[0].speaker, Some(0));
    }

    /// Split parts stay in chronological order, since pagination and the
    /// timeline both assume segments are sorted by start time.
    #[test]
    fn output_is_sorted_by_time() {
        let out = split_by_speaker(
            vec![
                seg(&[("b", 5.0, 5.3)]),
                Segment { id: "seg_1".into(), ..seg(&[("a", 1.0, 1.3)]) },
            ],
            &turns(&[(0.0, 10.0, 0)]),
        );
        assert_eq!(out[0].words[0].text, "a");
        assert_eq!(out[1].words[0].text, "b");
    }
}

#[cfg(test)]
mod timing_tests {
    use super::*;

    fn parse(json: &str) -> Vec<Segment> {
        build_segments(serde_json::from_str::<WhisperOut>(json).expect("valid whisper json"))
    }

    /// The exact shape whisper.cpp emits when a segment's tokens carry no
    /// timestamps of their own: every token reports the segment's start for
    /// both ends. This used to yield zero-length words, which the renderer
    /// (`t >= start && t <= end`) could never draw.
    #[test]
    fn tokens_without_timestamps_still_get_drawable_durations() {
        let segs = parse(
            r#"{"transcription":[{"text":" Yeah it should be","offsets":{"from":7200,"to":8080},
            "tokens":[
              {"text":" Yeah","offsets":{"from":7200,"to":7200}},
              {"text":" it","offsets":{"from":7200,"to":7200}},
              {"text":" should","offsets":{"from":7200,"to":7200}},
              {"text":" be","offsets":{"from":7200,"to":7200}}]}]}"#,
        );
        assert_eq!(segs.len(), 1);
        for w in &segs[0].words {
            assert!(w.end > w.start, "{} is undrawable: {}-{}", w.text, w.start, w.end);
        }
    }

    /// A trailing punctuation token routinely carries a timestamp that jumps
    /// backwards. Merging it must not drag the word's end before its start -
    /// that produced words (and whole caption pages) that never appeared.
    #[test]
    fn backwards_punctuation_token_cannot_invert_a_word() {
        let segs = parse(
            r#"{"transcription":[{"text":" Oh, Jesus","offsets":{"from":1748000,"to":1750000},
            "tokens":[
              {"text":" Oh","offsets":{"from":1748000,"to":1748100}},
              {"text":",","offsets":{"from":1746520,"to":1746520}},
              {"text":" Jesus","offsets":{"from":1748600,"to":1749000}}]}]}"#,
        );
        let words = &segs[0].words;
        assert_eq!(words[0].text, "Oh,");
        assert!(words[0].end > words[0].start);
        assert!(words[1].start >= words[0].start);
    }

    /// A word takes the LOWEST probability of its pieces. Averaging would let
    /// a confident stem hide a guessed ending - exactly the words worth
    /// checking - and the point of carrying this at all is to find them.
    #[test]
    fn a_word_is_only_as_confident_as_its_weakest_token() {
        let segs = parse(
            r#"{"transcription":[{"text":" Christian","offsets":{"from":0,"to":900},
            "tokens":[
              {"text":" Christ","offsets":{"from":0,"to":400},"t_dtw":10,"p":0.99},
              {"text":"ian","offsets":{"from":400,"to":900},"t_dtw":40,"p":0.31}]}]}"#,
        );
        let w = &segs[0].words[0];
        assert_eq!(w.text, "Christian");
        assert!((w.confidence - 0.31).abs() < 1e-6, "got {}", w.confidence);
    }

    /// Whisper's JSON predates this field in older builds; a missing
    /// probability must not read as "certain".
    #[test]
    fn a_missing_probability_defaults_to_certain_but_no_tokens_does_not() {
        let with_tokens = parse(
            r#"{"transcription":[{"text":" hi","offsets":{"from":0,"to":300},
            "tokens":[{"text":" hi","offsets":{"from":0,"to":300},"t_dtw":5}]}]}"#,
        );
        assert_eq!(with_tokens[0].words[0].confidence, 1.0);

        // No usable tokens at all - the evenly-spread fallback. Nothing is
        // known about these words, so they surface for review.
        let no_tokens = parse(
            r#"{"transcription":[{"text":" hi there","offsets":{"from":0,"to":600},"tokens":[]}]}"#,
        );
        assert_eq!(no_tokens[0].words[0].confidence, 0.0);
    }

    /// `-dtw` timings are centiseconds and win over `offsets` when present.
    #[test]
    fn dtw_timestamps_are_preferred_and_read_as_centiseconds() {
        let segs = parse(
            r#"{"transcription":[{"text":" Oh yeah","offsets":{"from":0,"to":5590},
            "tokens":[
              {"text":" Oh","offsets":{"from":0,"to":430},"t_dtw":404},
              {"text":" yeah","offsets":{"from":430,"to":1290},"t_dtw":420}]}]}"#,
        );
        let words = &segs[0].words;
        assert!((words[0].start - 4.04).abs() < 1e-9, "got {}", words[0].start);
        assert!((words[1].start - 4.20).abs() < 1e-9, "got {}", words[1].start);
    }

    #[test]
    fn a_bare_vocabulary_list_is_wrapped_into_a_sentence() {
        assert_eq!(
            build_prompt(Some("Christian, Luke, Tommy"), 800),
            "Names and terms you may hear: Christian, Luke, Tommy."
        );
        // trailing separator shouldn't produce ",."
        assert_eq!(
            build_prompt(Some("Christian, Luke,"), 800),
            "Names and terms you may hear: Christian, Luke."
        );
    }

    #[test]
    fn an_already_written_prompt_is_left_alone() {
        let written = "The players are Christian and Luke. They play Lethal Company.";
        assert_eq!(build_prompt(Some(written), 800), written);
    }

    #[test]
    fn an_empty_vocabulary_produces_no_prompt() {
        assert!(build_prompt(None, 800).is_empty());
        assert!(build_prompt(Some("   "), 800).is_empty());
    }

    #[test]
    fn an_overlong_prompt_is_truncated() {
        assert_eq!(build_prompt(Some(&"a,".repeat(900)), 40).chars().count(), 40);
    }

    /// The last word before a long silence shouldn't stretch across it - the
    /// paginator needs that gap to know when to clear the screen.
    #[test]
    fn a_word_does_not_stretch_across_a_long_silence() {
        let segs = parse(
            r#"{"transcription":[{"text":" Hi there","offsets":{"from":0,"to":20000},
            "tokens":[
              {"text":" Hi","offsets":{"from":0,"to":100},"t_dtw":10},
              {"text":" there","offsets":{"from":100,"to":200},"t_dtw":20}]}]}"#,
        );
        let last = segs[0].words.last().unwrap();
        assert!(last.end - last.start <= 1.5 + 1e-9, "ran {}s", last.end - last.start);
    }
}

#[cfg(test)]
mod waveform_tests {
    use super::*;

    /// Builds a minimal valid mono 16-bit PCM WAV file in memory from raw
    /// i16 samples, matching exactly what ffmpeg's `-c:a pcm_s16le` produces.
    fn make_wav(sample_rate: u32, samples: &[i16]) -> Vec<u8> {
        let data_bytes: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
        let byte_rate = sample_rate * 2; // mono * 16-bit
        let mut buf = Vec::new();
        buf.extend_from_slice(b"RIFF");
        buf.extend_from_slice(&(36 + data_bytes.len() as u32).to_le_bytes());
        buf.extend_from_slice(b"WAVE");
        buf.extend_from_slice(b"fmt ");
        buf.extend_from_slice(&16u32.to_le_bytes()); // fmt chunk size
        buf.extend_from_slice(&1u16.to_le_bytes()); // PCM
        buf.extend_from_slice(&1u16.to_le_bytes()); // mono
        buf.extend_from_slice(&sample_rate.to_le_bytes());
        buf.extend_from_slice(&byte_rate.to_le_bytes());
        buf.extend_from_slice(&2u16.to_le_bytes()); // block align
        buf.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
        buf.extend_from_slice(b"data");
        buf.extend_from_slice(&(data_bytes.len() as u32).to_le_bytes());
        buf.extend_from_slice(&data_bytes);
        buf
    }

    /// `bytes.as_ptr()`, not `bytes` — `{:p}` on a slice reference formats the
    /// fat pointer as `Pointer { addr: 0x.., metadata: N }`, and those braces,
    /// colons and spaces are illegal in a Windows filename (os error 123). The
    /// thin data pointer formats as a plain `0x..` on every platform.
    fn write_temp(bytes: &[u8], name: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("clipcaption_test_{name}_{:p}.wav", bytes.as_ptr()));
        std::fs::write(&p, bytes).unwrap();
        p
    }

    #[test]
    fn silence_produces_near_zero_peaks() {
        let samples = vec![0i16; 16000]; // 1s of silence at 16kHz
        let path = write_temp(&make_wav(16000, &samples), "silence");
        let (peaks, step) = read_wav_peaks(&path, 100).unwrap();
        let _ = std::fs::remove_file(&path);
        assert!(!peaks.is_empty());
        assert!(peaks.iter().all(|&p| p < 0.001), "silence should read as ~0: {peaks:?}");
        assert!(step > 0.0);
    }

    #[test]
    fn full_scale_tone_produces_peaks_near_one() {
        // alternating +/- full scale is the loudest possible 16-bit signal
        let samples: Vec<i16> = (0..16000).map(|i| if i % 2 == 0 { i16::MAX } else { i16::MIN }).collect();
        let path = write_temp(&make_wav(16000, &samples), "loud");
        let (peaks, _) = read_wav_peaks(&path, 100).unwrap();
        let _ = std::fs::remove_file(&path);
        assert!(peaks.iter().all(|&p| p > 0.9), "full-scale signal should read near 1.0: {peaks:?}");
    }

    #[test]
    fn bucket_count_is_capped_and_step_scales_with_duration() {
        let samples = vec![100i16; 16000 * 10]; // 10s
        let path = write_temp(&make_wav(16000, &samples), "long");
        let (peaks, step) = read_wav_peaks(&path, 50).unwrap();
        let _ = std::fs::remove_file(&path);
        // ~10s / 50 buckets => step ~0.2s, so bucket count should land near 50
        assert!(peaks.len() <= 55 && peaks.len() >= 45, "expected ~50 buckets, got {}", peaks.len());
        assert!((step - 0.2).abs() < 0.02, "expected ~0.2s step, got {step}");
    }

    #[test]
    fn short_clip_gets_fine_resolution_not_forced_to_max_buckets() {
        let samples = vec![100i16; 1600]; // 0.1s
        let path = write_temp(&make_wav(16000, &samples), "short");
        let (_, step) = read_wav_peaks(&path, 20_000).unwrap();
        let _ = std::fs::remove_file(&path);
        // step is clamped to a 10ms floor, not stretched down to fill 20,000 buckets
        assert!((step - 0.01).abs() < 1e-9, "expected the 10ms floor, got {step}");
    }

    #[test]
    fn skips_unknown_chunks_like_ffmpegs_list_chunk() {
        // Real ffmpeg output (verified against the actual binary) inserts a
        // LIST chunk between fmt and data — the parser must skip over
        // unrecognized chunks by their declared size, not assume a fixed
        // fmt-then-data layout.
        let samples = vec![1000i16; 1600];
        let mut wav = make_wav(16000, &samples);
        // splice a fake 10-byte LIST chunk right after the fmt chunk (at byte 36,
        // same position ffmpeg puts its LIST chunk in the real file above)
        let mut list_chunk = b"LIST".to_vec();
        list_chunk.extend_from_slice(&10u32.to_le_bytes());
        list_chunk.extend_from_slice(&[0u8; 10]);
        wav.splice(36..36, list_chunk);
        // fix up the RIFF size to account for the inserted bytes
        let new_riff_size = (wav.len() - 8) as u32;
        wav[4..8].copy_from_slice(&new_riff_size.to_le_bytes());

        let path = write_temp(&wav, "list_chunk");
        let (peaks, _) = read_wav_peaks(&path, 100).unwrap();
        let _ = std::fs::remove_file(&path);
        assert!(!peaks.is_empty());
        assert!(peaks.iter().any(|&p| p > 0.0), "should still find real audio past the LIST chunk");
    }

    #[test]
    fn garbage_input_returns_none_not_a_panic() {
        let path = write_temp(b"not a wav file at all", "garbage");
        let result = read_wav_peaks(&path, 100);
        let _ = std::fs::remove_file(&path);
        assert!(result.is_none());
    }
}

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
    /// 0 or 1 when speaker-turn detection (tinydiarize) was used, alternating
    /// each time whisper.cpp reports a speaker change. This is turn-taking,
    /// not voice identification — it can't tell you the same person spoke
    /// again after a gap, only that the previous speaker vs. this one
    /// differs. Null when diarization wasn't requested for this transcribe.
    pub speaker: Option<u8>,
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
    /// Present (and meaningful) only when whisper-cli was run with -tdrz.
    /// Verified field name against whisper.cpp's own JSON writer in
    /// examples/cli/cli.cpp — true means the *next* segment is a new speaker.
    #[serde(default)]
    speaker_turn_next: bool,
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
    diarize: bool,
) {
    let result = run_inner(&app, &job_id, &handle, &path, &model, start, end, diarize);
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
    diarize: bool,
) -> Result<String, String> {
    // Speaker-turn detection requires whisper.cpp's tinydiarize fine-tune —
    // it's a different, smaller model (small.en-tdrz) than whatever accuracy
    // model the user picked, so diarizing trades some accuracy for speaker
    // awareness rather than layering on top of e.g. large-v3.
    let effective_model = if diarize { "small.en-tdrz" } else { model };
    let model_path = models::model_path(app, effective_model)?;
    if !model_path.exists() {
        let label = if diarize { "Speaker detection" } else { "Model" };
        return Err(format!(
            "{label} model '{effective_model}' is not downloaded yet — grab it from the home screen."
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
    // passed through directly. Resolved against effective_model, not the
    // originally-requested model, since that's the model actually running.
    let dtw = models::dtw_preset(effective_model);

    // Bind these as owned Strings first — the args Vec below borrows from
    // them, and (unlike the single-chained-expression form this replaced)
    // that borrow now needs to outlive more than one statement.
    let model_path_s = model_path.to_string_lossy().into_owned();
    let wav_s = wav.to_string_lossy().into_owned();
    let out_base_s = out_base.to_string_lossy().into_owned();

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
        "-dtw",
        dtw,
    ];
    // Speaker-turn detection — combinable with -dtw (verified no conflict in
    // whisper.cpp's own flag validation), adds a `speaker_turn_next` boolean
    // to each segment in the JSON output parsed below.
    if diarize {
        args.push("-tdrz");
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

    let mut segments = build_segments(parsed, diarize);
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

fn build_segments(out: WhisperOut, diarize: bool) -> Vec<Segment> {
    let mut segments = Vec::new();
    // Alternates 0/1 each time whisper.cpp reports a speaker-turn boundary.
    // Only meaningful (and only assigned to segments) when diarize is on.
    let mut speaker: u8 = 0;

    for (si, seg) in out.transcription.into_iter().enumerate() {
        let turn_next = diarize && seg.speaker_turn_next;
        let text_trim = seg.text.trim();
        // skip non-speech annotations like [Music], (laughing), [BLANK_AUDIO]
        if text_trim.is_empty()
            || (text_trim.starts_with('[') && text_trim.ends_with(']'))
            || (text_trim.starts_with('(') && text_trim.ends_with(')'))
        {
            // Still honor a turn boundary on a skipped annotation segment,
            // so the alternation doesn't fall out of sync with whisper's own
            // turn markers.
            if turn_next {
                speaker = 1 - speaker;
            }
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
                speaker: if diarize { Some(speaker) } else { None },
            });
        }
        if turn_next {
            speaker = 1 - speaker;
        }
    }

    segments
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

    fn write_temp(bytes: &[u8], name: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("clipcaption_test_{name}_{:p}.wav", bytes));
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

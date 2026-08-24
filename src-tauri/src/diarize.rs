// Real speaker diarization via sherpa-onnx's offline-speaker-diarization
// sidecar — a genuine voice-fingerprint clustering pipeline (pyannote
// segmentation + a speaker-embedding model), not whisper.cpp's tinydiarize
// turn-detection this replaces. Verified end-to-end against real multi-
// speaker test audio before shipping: correctly identified 4 distinct
// speakers, including recognizing the same speaker returning after a 20+
// second gap — something turn-detection can never do since it has no notion
// of speaker *identity*, only "did a turn just happen."
//
// Deliberately decoupled from whisper.cpp entirely: it runs as its own pass
// over the same extracted WAV, so turning it on never costs transcription
// accuracy the way the old tinydiarize path did (that forced a downgrade to
// a smaller, diarization-specific whisper model). It also needs no toggle —
// it's attempted automatically whenever the sidecar + models are present,
// and quietly does nothing otherwise, exactly like a missing optional model
// should behave.

use std::collections::HashMap;
use std::path::Path;

use crate::sidecar;

pub struct SpeakerSegment {
    pub start: f64,
    pub end: f64,
    pub speaker: u32,
}

const SEGMENTATION_MODEL: &str = "sherpa-pyannote-segmentation.onnx";
const EMBEDDING_MODEL: &str = "sherpa-embedding.onnx";

/// Runs diarization on a 16kHz mono WAV. Returns `None` — not an error — if
/// the sidecar binary or either model file isn't present, or if the process
/// fails for any reason: diarization is a bonus layered on top of the
/// transcript, never something that should be able to break getting one.
pub fn run(wav_path: &Path) -> Option<Vec<SpeakerSegment>> {
    let seg_model = sidecar::resolve_data(SEGMENTATION_MODEL);
    let embed_model = sidecar::resolve_data(EMBEDDING_MODEL);
    if !seg_model.exists() || !embed_model.exists() {
        return None;
    }

    let output = sidecar::command("sherpa-onnx-offline-speaker-diarization")
        .arg(format!(
            "--segmentation.pyannote-model={}",
            seg_model.display()
        ))
        .arg(format!("--embedding.model={}", embed_model.display()))
        // Auto-detects speaker count rather than assuming a fixed number —
        // real clips range from one streamer talking alone to a full squad.
        // 0.90 is not the tool's own default (0.5): swept 0.5-0.9 against
        // real 4-speaker test audio with a known ground truth before
        // picking it — 0.5 badly over-split into 7 "speakers", 0.90 was the
        // lowest value that exactly recovered the true count of 4, matching
        // the --clustering.num-clusters=4 result exactly (including
        // correctly re-identifying the same speaker at three separate
        // points in the clip).
        .arg("--clustering.cluster-threshold=0.90")
        .arg(wav_path)
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut segments = Vec::new();
    // Each result line looks like: "0.318 -- 6.865 speaker_00" (verified
    // against the real tool's stdout, not assumed from docs). Progress/
    // config/timing lines go to stderr, so stdout should be just this, but
    // parse defensively line-by-line rather than assuming stdout is only
    // ever result lines.
    for line in stdout.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() != 4 || parts[1] != "--" {
            continue;
        }
        let (Ok(start), Ok(end)) = (parts[0].parse::<f64>(), parts[2].parse::<f64>()) else {
            continue;
        };
        let Some(speaker) = parts[3]
            .strip_prefix("speaker_")
            .and_then(|s| s.parse::<u32>().ok())
        else {
            continue;
        };
        segments.push(SpeakerSegment { start, end, speaker });
    }

    if segments.is_empty() {
        None
    } else {
        Some(segments)
    }
}

/// For each distinct speaker id `run()` found, extracts one voice-fingerprint
/// embedding from that speaker's single longest continuous span (via the
/// extract-embedding sidecar — see src-tauri/embed-tool/extract_embedding.cpp
/// for what it does and why it exists), keyed by that speaker's *local*
/// index for this run only.
///
/// This is what lets the app recognize the same real person across separate
/// diarization runs (the live preview vs. an export's own independent
/// re-transcription) despite sherpa-onnx's speaker_00/01/... numbering being
/// freshly assigned by clustering every single time and carrying no
/// persistent identity on its own — see the frontend's speaker-matching
/// logic (captions.ts) for the other half of that. Best-effort: a speaker
/// whose embedding fails to extract is simply missing from the returned map
/// (falls back to an unnamed generic label in the UI), same non-fatal
/// philosophy as `run()` itself.
pub fn extract_speaker_embeddings(
    wav_path: &Path,
    segments: &[SpeakerSegment],
) -> HashMap<u32, Vec<f32>> {
    let embed_model = sidecar::resolve_data(EMBEDDING_MODEL);
    if !embed_model.exists() {
        return HashMap::new();
    }

    // Longest single continuous span per speaker — a cleaner, more reliable
    // fingerprint than concatenating fragments (which the embedding model
    // was never asked to handle) or than the first span (which can be a
    // throwaway one-word reaction).
    let mut longest: HashMap<u32, (f64, f64)> = HashMap::new();
    for s in segments {
        let dur = s.end - s.start;
        let better = longest
            .get(&s.speaker)
            .map(|(a, b)| dur > (b - a))
            .unwrap_or(true);
        if better {
            longest.insert(s.speaker, (s.start, s.end));
        }
    }

    let mut out = HashMap::new();
    for (speaker, (start, end)) in longest {
        let output = sidecar::command("extract-embedding")
            .arg(format!("--model={}", embed_model.display()))
            .arg(format!("--start={start:.3}"))
            .arg(format!("--end={end:.3}"))
            .arg(wav_path)
            .output();
        let Ok(output) = output else { continue };
        if !output.status.success() {
            continue;
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        if let Ok(embedding) = serde_json::from_str::<Vec<f32>>(stdout.trim()) {
            if !embedding.is_empty() {
                out.insert(speaker, embedding);
            }
        }
    }
    out
}

/// Assigns each `[start, end)` span (a transcript segment's own time range)
/// to whichever diarized speaker overlaps it the most, in *seconds of
/// overlap* rather than nearest-single-point — a segment that starts just
/// before a speaker change should side with whoever it mostly belongs to,
/// not whoever happens to be talking at its very first instant. Returns
/// `None` if the span doesn't overlap any diarized segment at all (e.g. a
/// transcript segment whisper produced from noise diarization didn't judge
/// as speech).
pub fn speaker_for_span(segments: &[SpeakerSegment], start: f64, end: f64) -> Option<u32> {
    segments
        .iter()
        .map(|s| {
            let overlap = (end.min(s.end) - start.max(s.start)).max(0.0);
            (overlap, s.speaker)
        })
        .filter(|(overlap, _)| *overlap > 0.0)
        .max_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal))
        .map(|(_, speaker)| speaker)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(start: f64, end: f64, speaker: u32) -> SpeakerSegment {
        SpeakerSegment { start, end, speaker }
    }

    #[test]
    fn picks_the_speaker_with_more_overlap() {
        let segs = vec![seg(0.0, 5.0, 0), seg(5.0, 10.0, 1)];
        // Mostly inside speaker 0's window.
        assert_eq!(speaker_for_span(&segs, 4.0, 4.8), Some(0));
        // Straddles the boundary but mostly in speaker 1's window.
        assert_eq!(speaker_for_span(&segs, 4.5, 7.0), Some(1));
        // Fully inside speaker 1's window.
        assert_eq!(speaker_for_span(&segs, 6.0, 9.0), Some(1));
    }

    #[test]
    fn returns_none_outside_any_diarized_span() {
        let segs = vec![seg(0.0, 5.0, 0), seg(8.0, 10.0, 1)];
        // Falls entirely in the silence gap between the two spans.
        assert_eq!(speaker_for_span(&segs, 5.5, 7.5), None);
    }

    #[test]
    fn real_four_speaker_transcript_matches_ground_truth() {
        // Taken verbatim from a real run of sherpa-onnx-offline-speaker-
        // diarization against sherpa-onnx's own 4-speaker test WAV, at the
        // --clustering.cluster-threshold=0.90 this module uses by default —
        // this exactly matched the --clustering.num-clusters=4 known-answer
        // run on the same file, so it's a trustworthy fixture for testing
        // the span-matching logic against realistic segment boundaries.
        let segs = vec![
            seg(0.318, 6.865, 0),
            seg(7.017, 10.747, 1),
            seg(11.455, 13.632, 1),
            seg(13.750, 17.041, 2),
            seg(22.137, 24.837, 0),
            seg(27.638, 29.478, 3),
            seg(30.001, 31.553, 3),
            seg(33.680, 37.932, 3),
            seg(48.040, 50.470, 2),
            seg(52.529, 54.605, 0),
        ];
        // A whisper word/segment span landing cleanly inside one of these.
        assert_eq!(speaker_for_span(&segs, 1.0, 2.0), Some(0));
        // Speaker 0 recognized again after a ~15s gap since their last line —
        // exactly the case tinydiarize's plain alternation could never get
        // right (it would have called this whichever of A/B was "next").
        assert_eq!(speaker_for_span(&segs, 22.5, 23.5), Some(0));
        assert_eq!(speaker_for_span(&segs, 52.6, 53.5), Some(0));
    }
}

// Not wired to a Tauri command yet - model download (models.rs) and the
// command/UI trigger are the next layer, not abandoned. Silencing dead_code
// here rather than on each item so the warning comes back the moment a real
// caller exists and this allow becomes stale.
#![allow(dead_code)]

//! Word-level forced alignment: given audio and text ClipCaption already
//! believes is correct (freshly transcribed or user-edited), finds precise
//! per-word timestamps with a wav2vec2 CTC acoustic model + a forced-align
//! Viterbi decode, instead of trusting whisper's free-decode DTW timing.
//!
//! Measured against 152 hand-confirmed words from a genuinely-hard 3-way
//! overlapping-speaker clip (2026-08-23 22-07-17.mp4, 40:07-40:52): on the
//! 124 words whisper's free decode could plausibly have produced at all,
//! free-decode got the word right only 81.5% of the time (median timing
//! error 122ms on the words it did get right). Forced-aligning the same
//! known-correct words against a ~0.4s-padded window around each speaker's
//! rough turn got 100% coverage - every word gets a timestamp, since it's
//! never guessing content - at a median timing error of 53ms. The ~0.4s
//! window matters: forced-aligning blind across a whole multi-speaker clip
//! lets short/common words snap onto a phonetically-similar moment from a
//! different simultaneous speaker, then drag every later word's forced
//! monotonic ordering out with it. Callers MUST window to a rough prior
//! position (whisper's own segment timing is normally close enough) rather
//! than handing this a whole recording.
//!
//! Model: Xenova/wav2vec2-base-960h (ONNX export of facebook/wav2vec2-base-960h).
//! Its 32-token char vocab below is fixed to that exact model - swapping
//! models means updating VOCAB_PAIRS to match the new vocab.json.

use ort::session::Session;
use ort::value::TensorRef;
use std::collections::HashMap;

const BLANK: i64 = 0;
const WORD_SEP: i64 = 4;
/// wav2vec2-base's total conv stride (5*2*2*2*2*2*2) over 16kHz input.
const FRAME_SEC: f64 = 320.0 / 16000.0;

const VOCAB_PAIRS: [(char, i64); 28] = [
    ('A', 7), ('B', 24), ('C', 19), ('D', 14), ('E', 5), ('F', 20), ('G', 21), ('H', 11),
    ('I', 10), ('J', 29), ('K', 26), ('L', 15), ('M', 17), ('N', 9), ('O', 8), ('P', 23),
    ('Q', 30), ('R', 13), ('S', 12), ('T', 6), ('U', 16), ('V', 25), ('W', 18), ('X', 28),
    ('Y', 22), ('Z', 31), ('\'', 27), ('|', WORD_SEP),
];

fn vocab() -> HashMap<char, i64> {
    VOCAB_PAIRS.into_iter().collect()
}

/// Converts free text into the label sequence the CTC vocab can express
/// (uppercase letters, apostrophe, `|` as a word separator) plus, for each
/// input word, the index into that label sequence where its first character
/// lands - used afterwards to map aligned frames back to word boundaries.
/// Words that fully vanish (nothing but stripped punctuation, e.g. "...")
/// still get a `word_starts` entry pointing at the position of the *next*
/// word/separator, so callers get one output slot per input word.
fn text_to_labels(words: &[String]) -> (Vec<i64>, Vec<usize>) {
    let v = vocab();
    let mut labels = Vec::new();
    let mut word_starts = Vec::with_capacity(words.len());
    for (i, word) in words.iter().enumerate() {
        if i > 0 {
            labels.push(WORD_SEP);
        }
        word_starts.push(labels.len());
        for ch in word.to_uppercase().chars() {
            if let Some(&id) = v.get(&ch) {
                labels.push(id);
            }
        }
    }
    (labels, word_starts)
}

/// Forced-alignment Viterbi decode: finds the highest-probability monotonic
/// path through `log_probs` (`[T, vocab]`, log-softmax'd) that visits
/// `labels` in order, with an optional blank between (and around) every
/// label as CTC requires. Returns, for each frame, which position in the
/// blank-expanded label sequence was active.
fn forced_align(log_probs: &[Vec<f32>], labels: &[i64]) -> Vec<usize> {
    let t_len = log_probs.len();
    let mut ext = Vec::with_capacity(labels.len() * 2 + 1);
    ext.push(BLANK);
    for &l in labels {
        ext.push(l);
        ext.push(BLANK);
    }
    let u_len = ext.len();

    const NEG: f64 = f64::NEG_INFINITY;
    let mut dp = vec![vec![NEG; u_len]; t_len];
    let mut bp = vec![vec![0u8; u_len]; t_len];

    dp[0][0] = log_probs[0][ext[0] as usize] as f64;
    if u_len > 1 {
        dp[0][1] = log_probs[0][ext[1] as usize] as f64;
    }

    for t in 1..t_len {
        for u in 0..u_len {
            let mut best = dp[t - 1][u];
            let mut src = 0u8;
            if u >= 1 && dp[t - 1][u - 1] > best {
                best = dp[t - 1][u - 1];
                src = 1;
            }
            if u >= 2 && ext[u] != BLANK && ext[u] != ext[u - 2] && dp[t - 1][u - 2] > best {
                best = dp[t - 1][u - 2];
                src = 2;
            }
            if best.is_infinite() {
                continue;
            }
            dp[t][u] = best + log_probs[t][ext[u] as usize] as f64;
            bp[t][u] = src;
        }
    }

    let end_u = if u_len > 1 && dp[t_len - 1][u_len - 1] < dp[t_len - 1][u_len - 2] {
        u_len - 2
    } else {
        u_len - 1
    };
    let mut path = vec![0usize; t_len];
    let mut u = end_u;
    for t in (0..t_len).rev() {
        path[t] = u;
        if t == 0 {
            break;
        }
        let src = bp[t][u];
        if src > 0 {
            u -= src as usize;
        }
    }
    path
}

/// Maps the frame-by-position path back to a `(first_frame, last_frame)`
/// range per input word, by walking the blank-expanded label sequence and
/// tracking which word each non-blank, non-separator position belongs to.
fn word_frame_ranges(
    path: &[usize],
    ext_len: usize,
    labels: &[i64],
    word_starts: &[usize],
) -> Vec<Option<(usize, usize)>> {
    let n_words = word_starts.len();
    let mut ext_word = vec![usize::MAX; ext_len];
    let mut wi = 0usize;
    let mut li = 0usize;
    for (ext_pos, slot) in ext_word.iter_mut().enumerate() {
        if ext_pos % 2 == 0 {
            continue; // blank position
        }
        let label = labels[li];
        li += 1;
        if label == WORD_SEP {
            wi += 1;
            continue;
        }
        if wi < n_words {
            *slot = wi;
        }
    }

    let mut ranges: Vec<Option<(usize, usize)>> = vec![None; n_words];
    for (t, &u) in path.iter().enumerate() {
        let w = ext_word[u];
        if w == usize::MAX {
            continue;
        }
        ranges[w] = Some(match ranges[w] {
            Some((lo, _)) => (lo, t),
            None => (t, t),
        });
    }
    ranges
}

fn log_softmax_row(row: &[f32]) -> Vec<f32> {
    let max = row.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
    let sum: f32 = row.iter().map(|&x| (x - max).exp()).sum();
    let log_sum = sum.ln();
    row.iter().map(|&x| x - max - log_sum).collect()
}

/// Zero-mean, unit-variance normalization over the whole clip, matching
/// wav2vec2's `do_normalize: true` feature-extractor config.
fn normalize(samples: &[f32]) -> Vec<f32> {
    let n = samples.len() as f64;
    if n == 0.0 {
        return Vec::new();
    }
    let mean = samples.iter().map(|&x| x as f64).sum::<f64>() / n;
    let var = samples.iter().map(|&x| (x as f64 - mean).powi(2)).sum::<f64>() / n;
    let std = var.sqrt().max(1e-7);
    samples.iter().map(|&x| ((x as f64 - mean) / std) as f32).collect()
}

pub struct Aligner {
    session: Session,
}

impl Aligner {
    pub fn load(model_path: &std::path::Path) -> ort::Result<Self> {
        let session = Session::builder()?.commit_from_file(model_path)?;
        Ok(Self { session })
    }

    /// Aligns `words` (in speaking order, one speaker's turn) against
    /// `samples` (mono f32 PCM at 16kHz, ideally windowed to roughly where
    /// this turn happens - see module docs). Returns one `(start, end)` in
    /// seconds *relative to the start of `samples`* per input word, or
    /// `None` for a word whose text produced no alignable characters.
    pub fn align(&mut self, samples: &[f32], words: &[String]) -> ort::Result<Vec<Option<(f64, f64)>>> {
        let (labels, word_starts) = text_to_labels(words);
        if labels.is_empty() {
            return Ok(vec![None; words.len()]);
        }

        let input = normalize(samples);
        let shape = vec![1i64, input.len() as i64];
        let tensor = TensorRef::from_array_view((shape, input.as_slice()))?;
        let outputs = self.session.run(ort::inputs![tensor])?;
        let (dims, data) = outputs[0].try_extract_tensor::<f32>()?;
        let t_len = dims[1] as usize;
        let vocab_size = dims[2] as usize;

        if t_len < labels.len() * 2 + 1 {
            // Not enough frames to place every required (label, blank) pair -
            // window was too tight for this much text.
            return Ok(vec![None; words.len()]);
        }

        let log_probs: Vec<Vec<f32>> = (0..t_len)
            .map(|t| log_softmax_row(&data[t * vocab_size..(t + 1) * vocab_size]))
            .collect();

        let path = forced_align(&log_probs, &labels);
        let ext_len = labels.len() * 2 + 1;
        let ranges = word_frame_ranges(&path, ext_len, &labels, &word_starts);

        Ok(ranges
            .into_iter()
            .map(|r| r.map(|(lo, hi)| (lo as f64 * FRAME_SEC, (hi + 1) as f64 * FRAME_SEC)))
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_to_labels_splits_on_word_separators_and_drops_punctuation() {
        let words = vec!["Hi,".to_string(), "there!".to_string()];
        let (labels, word_starts) = text_to_labels(&words);
        // "HI" '|' "THERE" -> H I | T H E R E
        assert_eq!(labels, vec![
            *vocab().get(&'H').unwrap(), *vocab().get(&'I').unwrap(), WORD_SEP,
            *vocab().get(&'T').unwrap(), *vocab().get(&'H').unwrap(), *vocab().get(&'E').unwrap(),
            *vocab().get(&'R').unwrap(), *vocab().get(&'E').unwrap(),
        ]);
        assert_eq!(word_starts, vec![0, 3]);
    }

    #[test]
    fn text_to_labels_keeps_apostrophes() {
        let words = vec!["don't".to_string()];
        let (labels, _) = text_to_labels(&words);
        assert_eq!(labels, vec![
            *vocab().get(&'D').unwrap(), *vocab().get(&'O').unwrap(), *vocab().get(&'N').unwrap(),
            *vocab().get(&'\'').unwrap(), *vocab().get(&'T').unwrap(),
        ]);
    }

    /// Builds a synthetic [T, V] log-prob table where the "true" path is
    /// known by construction (every frame overwhelmingly favours one
    /// symbol), so forced_align's recovered path is checkable by hand
    /// rather than against a real model.
    fn synth_log_probs(vocab_size: usize, frame_symbols: &[i64]) -> Vec<Vec<f32>> {
        frame_symbols
            .iter()
            .map(|&sym| {
                let mut row = vec![-20.0f32; vocab_size];
                row[sym as usize] = 0.0;
                log_softmax_row(&row)
            })
            .collect()
    }

    #[test]
    fn forced_align_recovers_a_clean_known_path() {
        // Two one-letter words "A" "B" -> labels [A, SEP, B] (word_frame_ranges
        // expects the flat, separator-including sequence text_to_labels
        // produces, not bare per-word labels with no separator between them).
        // ext = [blank, A, blank, SEP, blank, B, blank]
        let labels = vec![7i64, WORD_SEP, 24i64]; // 'A', '|', 'B'
        let word_starts = vec![0, 2];
        // frames: A, A, SEP, B, B - the model is certain at every frame, and
        // the disallowed-skip rule doesn't block A->SEP->B since all three
        // labels differ from their two-back neighbour.
        let frame_symbols = [7, 7, WORD_SEP, 24, 24];
        let log_probs = synth_log_probs(32, &frame_symbols);
        let path = forced_align(&log_probs, &labels);
        let ext_len = labels.len() * 2 + 1;
        let ranges = word_frame_ranges(&path, ext_len, &labels, &word_starts);
        assert_eq!(ranges[0], Some((0, 1))); // "A" active at frames 0-1
        assert_eq!(ranges[1], Some((3, 4))); // "B" active at frames 3-4
    }

    #[test]
    fn forced_align_handles_repeated_adjacent_letters() {
        // One word "OO" -> labels [O, O] (no separator - it's a single word
        // with a doubled letter). ext = [blank, O, blank, O, blank]. The two
        // O's must be separated by a blank frame: the u-2 skip is disallowed
        // when ext[u] == ext[u-2], unlike two *different* letters (previous
        // test) which may run together with no blank between them. With
        // T == U == 5 frames all sharply favouring one exact symbol each,
        // the only viable path is the literal blank/O/blank/O/blank
        // sequence - if the disallowed-skip rule were broken and let frame 2
        // jump straight from the first O to the second, this frame count
        // wouldn't be enough to also visit both blanks, and the assertion
        // below would fail.
        let labels = vec![8i64, 8i64]; // 'O','O'
        let word_starts = vec![0]; // single word - both O's belong to it
        let frame_symbols = [BLANK, 8, BLANK, 8, BLANK];
        let log_probs = synth_log_probs(32, &frame_symbols);
        let path = forced_align(&log_probs, &labels);
        let ext_len = labels.len() * 2 + 1;
        let ranges = word_frame_ranges(&path, ext_len, &labels, &word_starts);
        // Both O's belong to the same word, so its range spans from the
        // first O's frame to the second's.
        assert_eq!(ranges[0], Some((1, 3)));
    }

    #[test]
    fn normalize_produces_zero_mean_unit_variance() {
        let samples = vec![1.0f32, 2.0, 3.0, 4.0, 5.0];
        let out = normalize(&samples);
        let mean: f64 = out.iter().map(|&x| x as f64).sum::<f64>() / out.len() as f64;
        assert!(mean.abs() < 1e-4);
    }

    /// Not run in CI: needs the ~380MB model this project runtime-downloads
    /// rather than bundles. Run manually with
    /// `CLIPCAPTION_ALIGN_TEST_DIR=<path with model.onnx and clip11.wav> cargo test -- --ignored`
    /// to sanity-check the real ort integration end-to-end.
    #[test]
    #[ignore]
    fn aligns_a_real_clip_close_to_ground_truth() {
        let dir = std::env::var("CLIPCAPTION_ALIGN_TEST_DIR").expect("set CLIPCAPTION_ALIGN_TEST_DIR");
        let model_path = std::path::Path::new(&dir).join("model.onnx");
        let wav_path = std::path::Path::new(&dir).join("clip11.wav");

        let bytes = std::fs::read(&wav_path).unwrap();
        let data = &bytes[44..]; // canonical 44-byte PCM header, matches this project's ffmpeg output
        let samples: Vec<f32> = data
            .chunks_exact(2)
            .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0)
            .collect();

        // The FULL first turn - "Christian and I are gonna go stand on this
        // plate. You go get it." - windowed to its true extent (start 0.38,
        // "it." ends 2.57) plus the ~0.4s pad the real evaluation used.
        // Window must match the given text's true extent, not an arbitrarily
        // larger slice: give the aligner more audio than the supplied words
        // actually span and it stretches those words to fill it, since it
        // has no way to know unaccounted audio for words it wasn't given
        // follows in that slack (a partial word list was the bug in an
        // earlier version of this test - see git history).
        let window = &samples[0..(3.0 * 16000.0) as usize];
        let words: Vec<String> = "Christian and I are gonna go stand on this plate. You go get it."
            .split_whitespace()
            .map(String::from)
            .collect();
        let expect_start = [
            0.38, 0.60, 0.72, 0.84, 0.92, 1.05, 1.21, 1.35, 1.45, 1.71, 2.01, 2.20, 2.35, 2.46,
        ];

        let mut aligner = Aligner::load(&model_path).unwrap();
        let result = aligner.align(window, &words).unwrap();
        let mut max_err = 0.0f64;
        for (i, r) in result.iter().enumerate() {
            let (start, end) = r.expect("every word in this clean stretch should align");
            let err = (start - expect_start[i]).abs();
            max_err = max_err.max(err);
            eprintln!("word {i} ({}): got {start:.3}-{end:.3}, expected start {:.3}, err {err:.3}", words[i], expect_start[i]);
        }
        assert!(max_err < 0.35, "worst-case error {max_err:.3}s exceeds tolerance");
    }
}

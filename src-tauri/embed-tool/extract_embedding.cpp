// extract-embedding: a small standalone tool built specifically for
// ClipCaption's custom speaker-names feature.
//
// sherpa-onnx-offline-speaker-diarization (the sidecar diarize.rs already
// uses) only ever prints a numeric label per detected speaker (speaker_00,
// speaker_01, ...) - that numbering is assigned fresh by unsupervised
// clustering on every single run, with no guarantee "speaker 0" means the
// same real person across two separate runs (e.g. the live preview's
// transcription vs. a highlight clip's own independent re-transcription
// during export). To let a user permanently name a voice, ClipCaption needs
// an actual voice fingerprint it can compare across runs - that's what this
// tool produces.
//
// sherpa-onnx doesn't ship a CLI for this (its own bin/ only has interactive
// microphone-based speaker-identification tools), but it does expose the
// building blocks via its public C API (SpeakerEmbeddingExtractor) that the
// diarization tool itself is built on, using the exact same embedding model
// ClipCaption already bundles (sherpa-embedding.onnx / NeMo titanet). This
// tool is a thin wrapper around that API: read a WAV (optionally just a
// [start, end) time slice of it), run it through the embedding model, print
// the resulting vector as a JSON array on stdout.
//
// The embedding-vs-real-speaker-identity claim this whole feature rests on
// was verified empirically before building this: extracting embeddings
// independently for the same real person's voice in different audio files
// scored 0.63-0.75 cosine similarity to each other, while different
// people's embeddings scored 0.06-0.30 - a clean, wide separation. See
// src-tauri/src/diarize.rs's module doc and the project build log for the
// same discipline applied to the diarization threshold itself.
//
// Deliberately minimal: no third-party WAV library, no argument-parsing
// library - this only ever needs to read the one WAV shape the rest of the
// app already produces (mono, 16-bit PCM, via ffmpeg's `-ac 1 -c:a
// pcm_s16le` in transcribe.rs), so a ~40-line hand-rolled reader that fails
// loudly on anything else is more trustworthy than a generic parser this
// project would otherwise never exercise.

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

#include "sherpa-onnx/c-api/c-api.h"

namespace {

struct Args {
  std::string model;
  std::string wav;
  double start = -1;
  double end = -1;
};

bool StartsWith(const std::string &s, const char *prefix) {
  size_t n = std::strlen(prefix);
  return s.size() >= n && s.compare(0, n, prefix) == 0;
}

bool ParseArgs(int argc, char **argv, Args *out) {
  for (int i = 1; i < argc; ++i) {
    std::string a = argv[i];
    if (StartsWith(a, "--model=")) {
      out->model = a.substr(8);
    } else if (StartsWith(a, "--start=")) {
      out->start = std::atof(a.substr(8).c_str());
    } else if (StartsWith(a, "--end=")) {
      out->end = std::atof(a.substr(6).c_str());
    } else if (!StartsWith(a, "--")) {
      out->wav = a;
    }
  }
  return !out->model.empty() && !out->wav.empty();
}

// Reads exactly the WAV shape transcribe.rs produces: mono, 16-bit signed
// PCM, RIFF/WAVE container. Walks chunks properly (rather than assuming a
// fixed header size) so a LIST/INFO chunk some encoders add before "data"
// doesn't break it, but refuses (returns false) anything that isn't
// mono 16-bit PCM rather than guessing.
bool ReadWav16Mono(const std::string &path, std::vector<int16_t> *samples,
                    int32_t *sample_rate) {
  std::ifstream f(path, std::ios::binary);
  if (!f) return false;

  char riff[4];
  f.read(riff, 4);
  if (f.gcount() != 4 || std::memcmp(riff, "RIFF", 4) != 0) return false;
  f.seekg(4, std::ios::cur);  // overall chunk size, unused
  char wave[4];
  f.read(wave, 4);
  if (f.gcount() != 4 || std::memcmp(wave, "WAVE", 4) != 0) return false;

  int16_t num_channels = 0;
  int16_t bits_per_sample = 0;
  int32_t rate = 0;
  bool got_fmt = false;

  while (f.good()) {
    char id[4];
    f.read(id, 4);
    if (f.gcount() != 4) break;
    uint32_t size = 0;
    f.read(reinterpret_cast<char *>(&size), 4);
    if (f.gcount() != 4) break;

    if (std::memcmp(id, "fmt ", 4) == 0 && size >= 16) {
      int16_t audio_format = 0;
      f.read(reinterpret_cast<char *>(&audio_format), 2);
      f.read(reinterpret_cast<char *>(&num_channels), 2);
      f.read(reinterpret_cast<char *>(&rate), 4);
      f.seekg(6, std::ios::cur);  // byte rate (4) + block align (2)
      f.read(reinterpret_cast<char *>(&bits_per_sample), 2);
      uint32_t consumed = 16;
      if (size > consumed) f.seekg(size - consumed, std::ios::cur);
      got_fmt = true;
    } else if (std::memcmp(id, "data", 4) == 0) {
      if (!got_fmt || num_channels != 1 || bits_per_sample != 16) return false;
      samples->resize(size / 2);
      f.read(reinterpret_cast<char *>(samples->data()), size);
      if (static_cast<uint32_t>(f.gcount()) != size) return false;
      *sample_rate = rate;
      return true;  // stop at the first data chunk - that's all we need
    } else {
      f.seekg(size, std::ios::cur);
    }
    if (size % 2 == 1) f.seekg(1, std::ios::cur);  // chunks are word-aligned
  }
  return false;
}

}  // namespace

int main(int argc, char **argv) {
  Args args;
  if (!ParseArgs(argc, argv, &args)) {
    fprintf(stderr,
            "usage: extract-embedding --model=PATH [--start=SEC] "
            "[--end=SEC] WAV_PATH\n");
    return 1;
  }

  std::vector<int16_t> pcm;
  int32_t sample_rate = 0;
  if (!ReadWav16Mono(args.wav, &pcm, &sample_rate)) {
    fprintf(stderr, "Could not read '%s' as mono 16-bit PCM WAV\n",
            args.wav.c_str());
    return 1;
  }

  int64_t total = static_cast<int64_t>(pcm.size());
  int64_t first = args.start >= 0
                       ? static_cast<int64_t>(args.start * sample_rate)
                       : 0;
  int64_t last = args.end >= 0 ? static_cast<int64_t>(args.end * sample_rate)
                                : total;
  first = std::max<int64_t>(0, std::min<int64_t>(first, total));
  last = std::max<int64_t>(first, std::min<int64_t>(last, total));
  if (last <= first) {
    fprintf(stderr,
            "Requested [--start, --end) range is empty after clamping to "
            "the WAV's actual length\n");
    return 1;
  }

  std::vector<float> floats(static_cast<size_t>(last - first));
  for (int64_t i = first; i < last; ++i) {
    floats[static_cast<size_t>(i - first)] = pcm[static_cast<size_t>(i)] / 32768.0f;
  }

  SherpaOnnxSpeakerEmbeddingExtractorConfig config;
  std::memset(&config, 0, sizeof(config));
  config.model = args.model.c_str();
  config.num_threads = 1;
  config.debug = 0;
  config.provider = "cpu";

  const SherpaOnnxSpeakerEmbeddingExtractor *extractor =
      SherpaOnnxCreateSpeakerEmbeddingExtractor(&config);
  if (!extractor) {
    fprintf(stderr, "Failed to load embedding model '%s'\n",
            args.model.c_str());
    return 1;
  }

  const SherpaOnnxOnlineStream *stream =
      SherpaOnnxSpeakerEmbeddingExtractorCreateStream(extractor);
  SherpaOnnxOnlineStreamAcceptWaveform(stream, sample_rate, floats.data(),
                                        static_cast<int32_t>(floats.size()));
  SherpaOnnxOnlineStreamInputFinished(stream);

  if (!SherpaOnnxSpeakerEmbeddingExtractorIsReady(extractor, stream)) {
    fprintf(stderr,
            "Audio segment too short to compute a speaker embedding\n");
    SherpaOnnxDestroyOnlineStream(stream);
    SherpaOnnxDestroySpeakerEmbeddingExtractor(extractor);
    return 1;
  }

  const float *embedding =
      SherpaOnnxSpeakerEmbeddingExtractorComputeEmbedding(extractor, stream);
  int32_t dim = SherpaOnnxSpeakerEmbeddingExtractorDim(extractor);
  if (!embedding || dim <= 0) {
    fprintf(stderr, "Embedding computation returned nothing\n");
    SherpaOnnxDestroyOnlineStream(stream);
    SherpaOnnxDestroySpeakerEmbeddingExtractor(extractor);
    return 1;
  }

  std::string out;
  out.reserve(static_cast<size_t>(dim) * 10 + 2);
  out.push_back('[');
  char buf[32];
  for (int32_t i = 0; i < dim; ++i) {
    int n = std::snprintf(buf, sizeof(buf), i == 0 ? "%.6g" : ",%.6g",
                           static_cast<double>(embedding[i]));
    out.append(buf, static_cast<size_t>(n));
  }
  out.push_back(']');
  out.push_back('\n');
  std::fwrite(out.data(), 1, out.size(), stdout);

  SherpaOnnxSpeakerEmbeddingExtractorDestroyEmbedding(embedding);
  SherpaOnnxDestroyOnlineStream(stream);
  SherpaOnnxDestroySpeakerEmbeddingExtractor(extractor);
  return 0;
}

# Qwen2.5 cleanup model migration — 2026-09-17

Runtime download now uses the official [Qwen2.5-1.5B-Instruct-GGUF](https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF), whose model card lists Apache-2.0, in Q4_K_M format. The sidecar setup only downloads llama.cpp; model weights remain an optional runtime download. Existing 3B weights are left on disk but no longer selected.

Verified artifact size: 1,117,320,736 bytes. SHA256:
`6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e`.

## Reproduction

Run from the repository root with the existing local `scratch_align` fixture (`clip11_fresh.json`, `score_lib.py`, `gt_data.py`) and bundled llama-server. No Python packages are required. The private fixture remains ignored; measured outputs are saved in `cleanup-model-results.json` next to this report.

```powershell
python scripts/eval-cleanup.py --model src-tauri/target/debug/binaries/llama/qwen2.5-3b-instruct-q4_k_m.gguf --output scratch_align/cleanup-3b.json
python scripts/eval-cleanup.py --model scratch_align/qwen2.5-1.5b-instruct-q4_k_m.gguf --output scratch_align/cleanup-1.5b.json
```

Server: bundled llama.cpp build 10621, commit c1d0e7a00; CPU, four threads, 4096 context. Both runs use the same production prompt/few-shot examples, temperature 0, 24 output tokens, minimum token probability, players Christian/Aaron/Luke/Murph, and Whisper candidate cutoff 0.55. No learned dictionary is applied. Candidate sentences remain immutable, matching Rust's precomputed candidates (the old scratch harness modified context after auto-applies).

Scoring preserves the existing harness's SequenceMatcher normalized word matches, **not WER or suggestion precision**. Multiword replacements remain one word slot, as in that harness. A zero individual match delta does not imply a correct suggestion. All 27 requests succeeded for each model.

## Results and threshold decision

Raw transcript: 137 emitted words, 152 ground-truth words, 104 matches (68.4%).

| Model / threshold | Suggestions | Auto-applied | Matches | Accuracy |
| --- | ---: | ---: | ---: | ---: |
| 3B / original 0.80 | 8 | 0 | 104/152 | 68.4% |
| 1.5B / 0.50 | 19 | 5 | 102/152 | 67.1% |
| 1.5B / 0.60 | 19 | 4 | 103/152 | 67.8% |
| 1.5B / 0.70 | 19 | 2 | 104/152 | 68.4% |
| 1.5B / 0.80 | 19 | 0 | 104/152 | 68.4% |
| 1.5B / selected 0.90 | 19 | 0 | 104/152 | 68.4% |
| 1.5B / apply all | 19 | 19 | 96/152 | 63.2% |

Selected **0.90** in Rust and TypeScript as a conservative gate with margin above the highest observed 1.5B proposal (0.77998). This is a safety margin chosen after inspecting the sweep, not an empirically optimal threshold or calibrated 90% correctness probability. The two proposals admitted at 0.70 replace `I` with `I love you.` / `I love you, bro.`: unchanged aggregate accuracy hides invalid scope expansion. Lowering the gate to obtain more automatic edits is not justified.

Automatic output does not regress on this fixture (68.4% → 68.4%), but **equivalent cleanup quality is not established**. The smaller model produces substantially more over-expanded review suggestions, and this clip supplies no accepted automatic corrections with which to estimate precision. Review-queue quality is worse. More labeled clips and prompt/output-format work are needed before claiming general cleanup quality is acceptable. Metadata generation and translation share this model and were not evaluated by the cleanup fixture.

"""Compare local GGUF cleanup models using the existing scratch_align clip11 fixture.

No third-party Python dependencies. Run from the repo root:
python scripts/eval-cleanup.py --model PATH --output PATH
Uses the original harness's word reconstruction and SequenceMatcher metric,
but keeps candidate context immutable, as the app does, and sweeps thresholds.
"""
import argparse
import difflib
import json
import math
from pathlib import Path
import re
import socket
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--fixture-dir', type=Path, default=ROOT / 'scratch_align')
    args = parser.parse_args()
    sys.path.insert(0, str(args.fixture_dir.resolve()))
    from score_lib import load_gt, norm

    # Read the production prompt instead of maintaining a second copy.
    rust = (ROOT / 'src-tauri/src/polish.rs').read_text(encoding='utf-8')
    system = json.loads(re.search(r'const SYSTEM_PROMPT: &str = (".*");', rust)[1])
    examples = rust.split('fn prompt_messages(')[1].split('m.push(ChatMessage::user(final_user_turn))')[0]
    messages = [{'role': 'system', 'content': system}]
    for role, literal in re.findall(r'ChatMessage::(user|assistant)\(\s*("(?:[^"\\]|\\.)*")', examples):
        messages.append({'role': role, 'content': json.loads(literal)})
    segments = []
    data = json.loads((args.fixture_dir / 'clip11_fresh.json').read_text(encoding='utf-8'))
    for seg in data['transcription']:
        text = seg['text'].strip()
        if not text or (text.startswith('[') and text.endswith(']')):
            continue
        words = []
        for tok in seg.get('tokens', []):
            t = tok['text']
            if t.startswith('[_') or not t.strip():
                continue
            if t.startswith(' ') or not words:
                words.append({'text': t.strip(), 'conf': tok['p']})
            else:
                words[-1]['text'] += t.rstrip()
                words[-1]['conf'] = min(words[-1]['conf'], tok['p'])
        if words:
            segments.append(words)
    raw = [w['text'] for seg in segments for w in seg]
    gt = [norm(w['text']) for w in load_gt()]

    def score(words):
        return sum(b.size for b in difflib.SequenceMatcher(None, gt, [norm(w) for w in words], autojunk=False).get_matching_blocks())

    baseline = score(raw)
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    url = f'http://127.0.0.1:{port}'
    exe = ROOT / 'src-tauri/binaries/llama/llama-server-x86_64-pc-windows-msvc.exe'
    process = subprocess.Popen([str(exe), '-m', str(args.model.resolve()), '--port', str(port), '-t', '4', '-c', '4096', '--log-disable'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW)
    results = []
    try:
        deadline = time.monotonic() + 60
        while True:
            try:
                with urllib.request.urlopen(url + '/health', timeout=1):
                    break
            except Exception:
                if process.poll() is not None or time.monotonic() > deadline:
                    raise RuntimeError('llama-server did not become healthy')
                time.sleep(.2)
        index = 0
        for seg in segments:
            for wi, w in enumerate(seg):
                if w['conf'] < .55:
                    marked = ' '.join('«' + v['text'] + '»' if j == wi else v['text'] for j, v in enumerate(seg))
                    body = dict(messages=messages + [{'role': 'user', 'content': 'Players: Christian, Aaron, Luke, Murph.\nSentence: ' + marked}], temperature=0.0, max_tokens=24, cache_prompt=True, logprobs=True, top_logprobs=1)
                    req = urllib.request.Request(url + '/v1/chat/completions', data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
                    with urllib.request.urlopen(req, timeout=30) as response:
                        choice = json.load(response)['choices'][0]
                    answer = choice['message']['content'].strip().strip('"“”')
                    probs = [math.exp(t['logprob']) for t in (choice.get('logprobs') or {}).get('content', []) if t['token']]
                    confidence = min(probs, default=0.0)
                    normalized = lambda s: re.sub(r'^\W+|\W+$', '', s.strip()).lower()
                    noop = answer.lower() == 'same' or normalized(answer) == normalized(w['text'])
                    changed = raw.copy()
                    changed[index] = answer
                    row = dict(index=index, original=w['text'], answer=answer, confidence=confidence, noop=noop, match_delta=0 if noop else score(changed)-baseline)
                    results.append(row)
                    print(json.dumps(row), flush=True)
                index += 1
    finally:
        process.terminate()
        process.wait(timeout=10)
    sweep = []
    for threshold in [0, .5, .6, .7, .8, .85, .9, .95, .99, 1.0]:
        changed = raw.copy()
        applied = [r for r in results if not r['noop'] and r['confidence'] >= threshold]
        for row in applied:
            changed[row['index']] = row['answer']
        sweep.append(dict(threshold=threshold, applied=len(applied), matched=score(changed), accuracy=100*score(changed)/len(gt), individually_harmful=sum(r['match_delta'] < 0 for r in applied)))
    output = dict(model=str(args.model), ground_truth_words=len(gt), raw_words=len(raw), baseline_matched=baseline, candidates=len(results), results=results, sweep=sweep)
    args.output.write_text(json.dumps(output, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(sweep, indent=2))


if __name__ == '__main__':
    main()

"""Render a Sotto fixture script to audio.

Reads ``fixtures/scripts/<name>.json`` and writes

* ``fixtures/audio/<name>.wav``          mono, 16-bit PCM, 24 kHz
* ``fixtures/audio/<name>.timing.json``  startMs / endMs of every line

Speaker A is spoken with the cloned ``maddie`` voice, speaker B with
Chatterbox's built-in voice. Lines are joined with their ``pauseAfterMs``.

Usage:
    ~/Developer/Chatterbox/venv/bin/python fixtures/make_fixture.py fixtures/scripts/<name>.json

Must run with the Chatterbox virtualenv's Python; ``chatterbox-tts`` is not a
dependency of this repo.
"""

import argparse
import json
import os
import sys
import time
import wave
from pathlib import Path

import numpy as np
import torch
from chatterbox.tts import ChatterboxTTS, Conditionals

SAMPLE_RATE = 24_000
CHATTERBOX_HOME = Path(os.environ.get("CHATTERBOX_HOME", Path.home() / "Developer/Chatterbox"))
SPEAKER_A_VOICE = CHATTERBOX_HOME / "voices/maddie.pt"
EXAGGERATION = 0.5
# Chatterbox pads each utterance with a little silence; trimming it keeps the
# scripted pauses honest, which the pause detector downstream depends on.
TRIM_THRESHOLD = 0.02
TRIM_PADDING_MS = 60


def pick_device(requested: str) -> str:
    if requested != "auto":
        return requested
    return "mps" if torch.backends.mps.is_available() else "cpu"


def load_script(path: Path) -> dict:
    script = json.loads(path.read_text())
    lines = script.get("lines")
    if not isinstance(lines, list) or not lines:
        sys.exit(f"{path}: 'lines' must be a non-empty array")
    for i, line in enumerate(lines):
        if line.get("speaker") not in ("A", "B"):
            sys.exit(f"{path}: line {i} has speaker {line.get('speaker')!r}, expected 'A' or 'B'")
        if not str(line.get("text", "")).strip():
            sys.exit(f"{path}: line {i} has no text")
        if not isinstance(line.get("pauseAfterMs"), int) or line["pauseAfterMs"] < 0:
            sys.exit(f"{path}: line {i} needs an integer pauseAfterMs >= 0")
    return script


def trim_silence(samples: np.ndarray) -> np.ndarray:
    """Drop near-silent head and tail, keeping a short natural padding."""
    peak = float(np.max(np.abs(samples))) if samples.size else 0.0
    if peak == 0.0:
        return samples
    loud = np.flatnonzero(np.abs(samples) > TRIM_THRESHOLD * peak)
    if loud.size == 0:
        return samples
    padding = int(SAMPLE_RATE * TRIM_PADDING_MS / 1000)
    start = max(0, int(loud[0]) - padding)
    end = min(samples.size, int(loud[-1]) + padding)
    return samples[start:end]


def to_pcm16(samples: np.ndarray) -> np.ndarray:
    return (np.clip(samples, -1.0, 1.0) * 32767.0).astype(np.int16)


def write_wav(path: Path, samples: np.ndarray) -> None:
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)
        wav.writeframes(to_pcm16(samples).tobytes())


def render(script_path: Path, device: str, seed: int) -> None:
    script = load_script(script_path)
    name = script_path.stem
    audio_dir = script_path.parent.parent / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)
    wav_path = audio_dir / f"{name}.wav"
    timing_path = audio_dir / f"{name}.timing.json"

    if not SPEAKER_A_VOICE.exists():
        sys.exit(f"Speaker A voice not found: {SPEAKER_A_VOICE}")

    print(f"Loading Chatterbox on {device}...", flush=True)
    load_start = time.time()
    model = ChatterboxTTS.from_pretrained(device=device)
    if model.sr != SAMPLE_RATE:
        sys.exit(f"Chatterbox sample rate is {model.sr}, expected {SAMPLE_RATE}")
    voices = {
        "A": Conditionals.load(SPEAKER_A_VOICE, map_location="cpu").to(model.device),
        "B": model.conds,
    }
    if voices["B"] is None:
        sys.exit("Chatterbox has no built-in voice conditionals for speaker B")
    print(f"  loaded in {time.time() - load_start:.1f}s", flush=True)

    torch.manual_seed(seed)
    chunks: list[np.ndarray] = []
    timings: list[dict] = []
    cursor = 0  # samples written so far
    lines = script["lines"]
    gen_start = time.time()

    for i, line in enumerate(lines):
        model.conds = voices[line["speaker"]]
        wav = model.generate(line["text"], exaggeration=EXAGGERATION)
        samples = trim_silence(wav.squeeze(0).detach().cpu().numpy().astype(np.float32))

        start_ms = round(cursor * 1000 / SAMPLE_RATE)
        chunks.append(samples)
        cursor += samples.size
        end_ms = round(cursor * 1000 / SAMPLE_RATE)
        timings.append(
            {"index": i, "speaker": line["speaker"], "startMs": start_ms, "endMs": end_ms}
        )

        pause = int(SAMPLE_RATE * line["pauseAfterMs"] / 1000)
        if pause:
            chunks.append(np.zeros(pause, dtype=np.float32))
            cursor += pause

        print(
            f"  [{i + 1}/{len(lines)}] {line['speaker']}: {line['text'][:48]!r}"
            f" -> {(end_ms - start_ms) / 1000:.1f}s",
            flush=True,
        )

    audio = np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)
    duration_ms = round(audio.size * 1000 / SAMPLE_RATE)
    write_wav(wav_path, audio)
    timing_path.write_text(
        json.dumps(
            {
                "name": name,
                "sampleRate": SAMPLE_RATE,
                "durationMs": duration_ms,
                "lines": timings,
            },
            indent=2,
        )
        + "\n"
    )

    elapsed = time.time() - gen_start
    print(
        f"Wrote {wav_path} ({duration_ms / 1000:.1f}s audio) and {timing_path}"
        f" in {elapsed:.0f}s ({elapsed / max(duration_ms / 1000, 0.001):.2f}x real time)"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("script", type=Path, help="path to fixtures/scripts/<name>.json")
    parser.add_argument(
        "--device",
        default=os.environ.get("SOTTO_TTS_DEVICE", "auto"),
        choices=["auto", "cpu", "mps", "cuda"],
        help="torch device (default: auto, prefers mps on Apple silicon)",
    )
    parser.add_argument("--seed", type=int, default=1234, help="sampling seed")
    args = parser.parse_args()

    if not args.script.exists():
        sys.exit(f"Script not found: {args.script}")
    render(args.script, pick_device(args.device), args.seed)


if __name__ == "__main__":
    main()

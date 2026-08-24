"""
Turns audio into words with timings.

Reads a WAV on stdin and writes JSON on stdout. Nothing about a video project
appears here: the editor decodes the audio itself, with WebCodecs, and hands
over plain PCM - so this stays a tool that transcribes a sound file, and the
"no ffmpeg anywhere" rule the renderer lives under is not bent to reach it.

It also means the audio never leaves the machine. The model runs locally; there
is no key and no request.

Usage:
    python scripts/transcribe.py < audio.wav
    python scripts/transcribe.py --model small < audio.wav

Output:
    {
      "language": "en",
      "duration": 60.37,
      "text": "the whole thing as one string",
      "segments": [
        {"start": 0.0, "end": 3.2, "text": "...",
         "words": [{"start": 0.0, "end": 0.3, "word": "the", "probability": 0.98}]}
      ]
    }
"""

from __future__ import annotations

import argparse
import io
import json
import os
import sys
import wave


def read_wav(raw: bytes) -> tuple[list[float], int]:
    """
    Decodes a PCM WAV into mono float samples.

    Only what the editor actually sends is handled - 16-bit or 32-bit float PCM -
    because the alternative is a general audio decoder, which is the thing this
    is deliberately not.
    """
    with wave.open(io.BytesIO(raw), "rb") as handle:
        channels = handle.getnchannels()
        width = handle.getsampwidth()
        rate = handle.getframerate()
        frames = handle.readframes(handle.getnframes())

    if width == 2:
        import array

        counts = array.array("h")
        counts.frombytes(frames)
        samples = [value / 32768.0 for value in counts]
    elif width == 4:
        import array

        floats = array.array("f")
        floats.frombytes(frames)
        samples = list(floats)
    else:
        raise SystemExit(f"unsupported sample width: {width} bytes")

    if channels > 1:
        # Whisper wants mono. Averaging is right for speech: the words are in
        # both channels, and taking one would throw half the signal away.
        mixed = []
        for index in range(0, len(samples) - channels + 1, channels):
            mixed.append(sum(samples[index : index + channels]) / channels)
        samples = mixed

    return samples, rate


def enable_cuda_libraries() -> None:
    """
    Lets Windows find CUDA's DLLs inside the nvidia pip packages.

    On Linux the loader follows the RPATH baked into ctranslate2 and this is not
    needed. On Windows nothing looks inside site-packages for a DLL, so cuBLAS
    and cuDNN sit there installed and invisible, and the only symptom is
    "cublas64_12.dll is not found" at the first inference - long after the model
    claimed to have loaded on the GPU.

    PATH is what actually fixes it, and `os.add_dll_directory` alone does NOT:
    that only covers loads made with the newer search flags, and ctranslate2
    reaches for cuBLAS the old way. Both are set, because the second costs
    nothing and covers whatever it does reach.
    """
    if os.name != "nt":
        return

    try:
        import nvidia
    except ImportError:
        return

    import pathlib

    # A NAMESPACE package: the nvidia distributions each drop one subdirectory
    # into it and none of them ships an __init__.py, so there is no __file__ to
    # take a parent of - only __path__, and it can hold more than one root.
    found: list[str] = []
    for root in getattr(nvidia, "__path__", []):
        for package in pathlib.Path(root).iterdir():
            for folder in ("bin", "lib"):
                path = package / folder
                if path.is_dir():
                    found.append(str(path))

    if not found:
        return

    os.environ["PATH"] = os.pathsep.join([*found, os.environ.get("PATH", "")])
    for path in found:
        try:
            os.add_dll_directory(path)
        except OSError:
            pass


def default_compute_type(device: str) -> str:
    return "int8_float16" if device == "cuda" else "int8"


def devices_to_try(asked: str) -> list[str]:
    """
    Which devices to attempt, in order.

    A GPU can fail at either of two moments - loading the model, or the first
    inference, when a missing library is finally dereferenced - so the caller has
    to be able to fall back after the model appeared to load fine.
    """
    if asked == "cpu":
        return ["cpu"]
    if asked == "cuda":
        return ["cuda"]
    return ["cuda", "cpu"]


def main() -> int:
    parser = argparse.ArgumentParser()
    # `medium` is the sensible default for English. For anything else - Tamil,
    # Hindi, Japanese - `large-v3` is a different class of accurate, and the
    # slowness is the price. Set WHISPER_MODEL in .env to change it.
    parser.add_argument("--model", default="medium")
    # `auto` means try the GPU and quietly fall back. A laptop GPU turns a
    # transcription from minutes into seconds, and the failure modes are all
    # about missing libraries rather than anything the user did - so a machine
    # without them has to still get its words, just slower.
    parser.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    # Left unset so it can follow the device: int8 is right on a CPU, where
    # float32 is several times slower for no audible difference, and
    # int8_float16 is right on a GPU - it is what fits large-v3 into the 4GB a
    # laptop card has.
    parser.add_argument("--compute-type", default=None)
    parser.add_argument("--language", default=None)
    # Speech that switches - Tamil with English words in it, a bilingual
    # interview - is read wrong by both of the alternatives: pinning one language
    # mangles half the words, and detecting once at the top commits the whole
    # file to whatever the opening happened to be in. This detects per segment.
    parser.add_argument("--multilingual", action="store_true")
    args = parser.parse_args()

    raw = sys.stdin.buffer.read()
    if not raw:
        print(json.dumps({"error": "no audio on stdin"}))
        return 1

    try:
        samples, rate = read_wav(raw)
    except Exception as error:  # noqa: BLE001 - the message is the whole point
        print(json.dumps({"error": f"could not read the audio: {error}"}))
        return 1

    if rate != 16_000:
        print(
            json.dumps(
                {
                    "error": (
                        f"expected 16000 Hz audio, got {rate}. The editor is"
                        " supposed to resample before sending."
                    )
                }
            )
        )
        return 1

    # Before the import, not after it: ctranslate2 resolves CUDA at load time,
    # and a PATH set afterwards is a PATH set too late.
    enable_cuda_libraries()

    try:
        import numpy as np
        from faster_whisper import WhisperModel
    except ImportError as error:
        print(
            json.dumps(
                {
                    "error": (
                        f"the transcriber is not installed ({error}). Run:"
                        " uv pip install --python .venv faster-whisper"
                    )
                }
            )
        )
        return 1

    # Physical cores rather than ctranslate2's default of four. The CPU path is
    # the slow one and this is free.
    threads = max(1, (os.cpu_count() or 4) // 2)

    attempts: list[str] = []
    for device in devices_to_try(args.device):
        try:
            segments, info, used = run(args, device, samples, np, WhisperModel, threads)
        except Exception as error:  # noqa: BLE001 - the reason is what gets reported
            attempts.append(f"{device}: {error}")
            continue

        emit(segments, info, used, attempts)
        return 0

    print(
        json.dumps(
            {
                "error": "could not transcribe. " + "; ".join(attempts),
            }
        )
    )
    return 1


def run(args, device, samples, np, WhisperModel, threads):
    """
    One attempt on one device.

    The segments are materialised HERE rather than returned lazily, because
    faster-whisper decodes as they are consumed - a missing CUDA library surfaces
    on the first one, and a generator handed back to the caller would raise
    outside the try that is supposed to catch it and fall back.
    """
    compute_type = args.compute_type or default_compute_type(device)
    model = WhisperModel(
        args.model,
        device=device,
        compute_type=compute_type,
        cpu_threads=threads,
    )

    segments, info = model.transcribe(
        np.asarray(samples, dtype="float32"),
        # Pinning a language and detecting per line are mutually exclusive: one
        # says what every window is, the other says to work it out each time.
        language=None if args.multilingual else args.language,
        multilingual=args.multilingual,
        # The whole point: without these there are no word timings, and without
        # word timings a transcript cannot be cut against.
        word_timestamps=True,
        # Whisper will otherwise narrate silence, inventing a sentence where
        # there is only room tone.
        vad_filter=True,
        # A pause long enough to be a hallucination factory. Word timings are on,
        # so segments whose words sit inside silence this long are thrown away.
        hallucination_silence_threshold=2.0,
        # THE REPETITION LOOP, and the four lines below are all about it.
        #
        # Whisper decodes one 30-second window at a time and, by default, feeds
        # its own previous output back in as context. That is what makes it
        # fluent across a sentence boundary - and it is also a feedback loop: say
        # a phrase twice and the most likely next thing becomes the phrase again,
        # forever. It is the single most common way a transcript comes back as
        # one word repeated three hundred times, and it is worst on languages the
        # model knows least well, because a weak posterior is easiest to talk
        # into a rut.
        #
        # Turning the carry-over off costs a little continuity across windows and
        # removes the loop entirely.
        condition_on_previous_text=False,
        # A belt to that brace, INSIDE a window: no three-word sequence may be
        # emitted twice by the beam search. Three consecutive identical words is
        # not a thing anybody says.
        no_repeat_ngram_size=3,
        repetition_penalty=1.15,
        # The escape hatch that already existed and could not fire: a window is
        # re-decoded at a higher temperature when its text compresses too well,
        # which is exactly what repeated text does. It needs a LIST of
        # temperatures to fall back through, and it is being named here so that
        # nobody later "simplifies" it to a single 0.0 and puts the loop back.
        temperature=[0.0, 0.2, 0.4, 0.6, 0.8, 1.0],
        compression_ratio_threshold=2.4,
    )

    return list(segments), info, f"{device} ({compute_type})"


def emit(segments, info, used: str, attempts: list[str]) -> None:
    out = []
    whole = []
    for segment in segments:
        words = [
            {
                "start": round(word.start, 3),
                "end": round(word.end, 3),
                "word": word.word,
                "probability": round(word.probability, 3),
            }
            for word in (segment.words or [])
        ]
        text = segment.text.strip()
        whole.append(text)
        out.append(
            {
                "start": round(segment.start, 3),
                "end": round(segment.end, 3),
                "text": text,
                "words": words,
            }
        )

    print(
        json.dumps(
            {
                "language": info.language,
                "duration": round(info.duration, 3),
                "text": " ".join(whole),
                "segments": out,
                # What it actually ran on, and why not the faster thing. Without
                # this a transcription that took twenty minutes looks the same
                # as one that took twenty seconds until it is over.
                "device": used,
                **({"note": "; ".join(attempts)} if attempts else {}),
            }
        )
    )


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""
KITT whisper sidecar
====================
Runs as a child process of the Node agent.
- Captures mic at the device's NATIVE sample rate (usually 48 kHz on macOS USB/display mics)
- Resamples to 16 kHz in Python before feeding Whisper (PortAudio's auto-resample
  was corrupting the audio buffer, producing nonsense transcripts)
- Detects voice activity via RMS energy
- Transcribes utterances with faster-whisper
- Watches for the hotword (matches multiple phonetic variants since Whisper
  small.en transcribes "kitt" inconsistently — accepts kitt|kitty|kit|kid)
- Emits JSON events to stdout, one per line:

  {"type": "ready"}
  {"type": "vad",   "speaking": true}
  {"type": "final", "text": "..."}
  {"type": "hotword", "text": "..."}
  {"type": "info",  "message": "..."}
  {"type": "error", "message": "..."}
  {"type": "debug", "kind": "...", ...}

Reads JSON commands from stdin, one per line:

  {"cmd": "arm"}      -> next utterance is a real command, full transcribe
  {"cmd": "disarm"}   -> back to hotword listening only
  {"cmd": "quit"}
"""

import sys, json, os, threading, queue, time, re, warnings
import numpy as np
import sounddevice as sd
from faster_whisper import WhisperModel

TARGET_SR     = 16000   # what Whisper wants
CHUNK_MS      = 100
SILENCE_MS    = int(os.environ.get("SILENCE_MS", "900"))
MAX_UTT_MS    = int(os.environ.get("MAX_UTT_MS", "15000"))
RMS_THRESHOLD = float(os.environ.get("RMS_THRESHOLD", "0.012"))
DEBUG_AUDIO   = os.environ.get("STT_DEBUG_AUDIO", "1") != "0"

MODEL_SIZE = os.environ.get("WHISPER_MODEL", "small.en")
DEVICE     = os.environ.get("WHISPER_DEVICE", "auto")
INPUT_DEVICE = os.environ.get("AUDIO_INPUT_DEVICE")

# Always include common phonetic variants; primary phrase comes from env.
DEFAULT_VARIANTS = ["hey kitt", "hey kitty", "hey kit", "hey kid", "talk to me kitt"]
_primary = os.environ.get("HOTWORD_PHRASE", "hey kitt").strip().lower()
_extra = os.environ.get("HOTWORD_PHRASES", "")
HOTWORDS = list(dict.fromkeys(
    [_primary]
    + DEFAULT_VARIANTS
    + [s.strip().lower() for s in _extra.split(",") if s.strip()]
))


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def rms(buf):
    if len(buf) == 0:
        return 0.0
    return float(np.sqrt(np.mean(np.square(buf), dtype=np.float64)))


def audio_stats(buf):
    if len(buf) == 0:
        return {"samples": 0, "min": 0.0, "max": 0.0, "mean": 0.0, "rms": 0.0}
    return {
        "samples": len(buf),
        "min": float(np.min(buf)),
        "max": float(np.max(buf)),
        "mean": float(np.mean(buf)),
        "rms": rms(buf),
    }


def normalize_text(text):
    """Lowercase, strip punctuation, collapse whitespace, canonicalize kitt variants."""
    text = text.lower()
    text = re.sub(r"[^\w\s]", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    for variant in ("kitty", "kit", "kid"):
        text = re.sub(rf"\b{variant}\b", "kitt", text)
    return text


def detect_native_rate(input_device):
    """Query the input device for its native sample rate."""
    try:
        if input_device is not None:
            d = sd.query_devices(input_device)
        else:
            d = sd.query_devices(kind="input")
        return int(d["default_samplerate"])
    except Exception:
        return TARGET_SR


def resolve_input_device():
    """Return device index/name for sd.InputStream, or None for system default."""
    if not INPUT_DEVICE:
        return None
    if INPUT_DEVICE.isdigit():
        return int(INPUT_DEVICE)
    return INPUT_DEVICE


def log_input_device(input_device):
    try:
        idx = input_device if input_device is not None else sd.default.device[0]
        dev = sd.query_devices(idx)
        emit({
            "type": "info",
            "message": (
                f"input device [{idx}]: {dev['name']} "
                f"channels={dev['max_input_channels']} sr={dev['default_samplerate']}"
            ),
        })
    except Exception as e:
        emit({"type": "error", "message": f"input device query failed: {e}"})


def make_downsampler(native_sr):
    """Return a function that downsamples native-rate audio → TARGET_SR."""
    if native_sr == TARGET_SR:
        return lambda a: a
    if native_sr % TARGET_SR == 0:
        n = native_sr // TARGET_SR
        kernel = np.ones(n, dtype=np.float32) / n
        def ds(audio):
            smooth = np.convolve(audio, kernel, mode="same")
            return smooth[::n].astype(np.float32)
        return ds
    def ds_lin(audio):
        n_out = int(round(len(audio) * TARGET_SR / native_sr))
        x_in = np.linspace(0, 1, num=len(audio), endpoint=False, dtype=np.float64)
        x_out = np.linspace(0, 1, num=n_out, endpoint=False, dtype=np.float64)
        return np.interp(x_out, x_in, audio).astype(np.float32)
    return ds_lin


def prepare_for_whisper(audio16):
    """Peak-normalize and validate audio before Whisper. Returns None if unusable."""
    if len(audio16) < TARGET_SR // 4:
        return None
    peak = float(np.max(np.abs(audio16)))
    if peak < 1e-6:
        return None
    audio16 = np.clip(audio16 / peak, -1.0, 1.0).astype(np.float32)
    if rms(audio16) < RMS_THRESHOLD * 0.5:
        return None
    return audio16


def find_hotword(text):
    """Return the first matching hotword variant (longest first), or None."""
    norm = normalize_text(text)
    for hw in sorted(HOTWORDS, key=len, reverse=True):
        if normalize_text(hw) in norm:
            return hw
    return None


def hotword_remainder(text, matched_hw):
    """Text after the matched hotword, normalized for downstream command parsing."""
    norm = normalize_text(text)
    hw_norm = normalize_text(matched_hw)
    idx = norm.find(hw_norm)
    if idx < 0:
        return ""
    return norm[idx + len(hw_norm):].strip()


class Sidecar:
    def __init__(self):
        self.input_device = resolve_input_device()
        log_input_device(self.input_device)
        self.native_sr = detect_native_rate(self.input_device)
        self.chunk_samples = int(self.native_sr * CHUNK_MS / 1000)
        self.downsample = make_downsampler(self.native_sr)
        emit({"type": "info", "message": f"native_sr={self.native_sr}Hz target={TARGET_SR}Hz hotwords={HOTWORDS}"})
        emit({"type": "info", "message": f"loading whisper {MODEL_SIZE}"})
        self.model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type="auto")
        self.armed = False
        self.audio_q = queue.Queue()
        self.cmd_q   = queue.Queue()
        self.running = True

    def audio_cb(self, indata, frames, time_info, status):
        if status:
            emit({"type": "debug", "kind": "portaudio", "status": str(status)})
        self.audio_q.put(indata[:, 0].copy())

    def cmd_reader(self):
        for line in sys.stdin:
            line = line.strip()
            if not line: continue
            try:
                self.cmd_q.put(json.loads(line))
            except Exception:
                pass

    def transcribe(self, audio_native):
        audio16 = self.downsample(audio_native)
        prepared = prepare_for_whisper(audio16)
        if prepared is None:
            emit({"type": "debug", "kind": "skip", "reason": "audio too quiet or too short", **audio_stats(audio16)})
            return ""
        with warnings.catch_warnings():
            warnings.filterwarnings("ignore", category=RuntimeWarning)
            segments, _ = self.model.transcribe(
                prepared, language="en", beam_size=1, vad_filter=False,
                condition_on_previous_text=False,
            )
        return " ".join(s.text.strip() for s in segments).strip()

    def run(self):
        threading.Thread(target=self.cmd_reader, daemon=True).start()

        emit({"type": "ready"})

        with sd.InputStream(
            device=self.input_device,
            samplerate=self.native_sr, channels=1, dtype="float32",
            blocksize=self.chunk_samples, callback=self.audio_cb,
        ):
            utterance = []
            in_speech = False
            last_voice_ms = 0
            utt_start_ms = 0

            while self.running:
                try:
                    while True:
                        cmd = self.cmd_q.get_nowait()
                        if cmd.get("cmd") == "arm":     self.armed = True
                        if cmd.get("cmd") == "disarm":  self.armed = False
                        if cmd.get("cmd") == "quit":    self.running = False
                except queue.Empty:
                    pass

                try:
                    chunk = self.audio_q.get(timeout=0.2)
                except queue.Empty:
                    continue

                now_ms = int(time.time() * 1000)
                level = rms(chunk)

                if DEBUG_AUDIO:
                    emit({"type": "debug", "kind": "chunk", **audio_stats(chunk)})

                if level > RMS_THRESHOLD:
                    if not in_speech:
                        in_speech = True
                        utt_start_ms = now_ms
                        emit({"type": "vad", "speaking": True})
                    utterance.append(chunk)
                    last_voice_ms = now_ms
                else:
                    if in_speech:
                        utterance.append(chunk)
                        if now_ms - last_voice_ms > SILENCE_MS or now_ms - utt_start_ms > MAX_UTT_MS:
                            audio = np.concatenate(utterance)
                            utterance = []
                            in_speech = False
                            emit({"type": "vad", "speaking": False})

                            native_stats = audio_stats(audio)
                            emit({"type": "debug", "kind": "utterance_native", **native_stats})

                            try:
                                text = self.transcribe(audio)
                            except Exception as e:
                                emit({"type": "error", "message": str(e)})
                                continue

                            emit({
                                "type": "debug",
                                "kind": "transcript",
                                "raw": text,
                                "normalized": normalize_text(text) if text else "",
                                "armed": self.armed,
                            })

                            if not text:
                                continue

                            if self.armed:
                                emit({"type": "final", "text": text})
                            else:
                                matched = find_hotword(text)
                                emit({
                                    "type": "debug",
                                    "kind": "hotword_check",
                                    "matched": matched,
                                    "normalized": normalize_text(text),
                                })
                                if matched:
                                    trimmed = hotword_remainder(text, matched)
                                    emit({"type": "hotword", "text": trimmed or ""})


if __name__ == "__main__":
    try:
        Sidecar().run()
    except KeyboardInterrupt:
        pass
    except Exception as e:
        emit({"type": "error", "message": f"fatal: {e}"})
        sys.exit(1)

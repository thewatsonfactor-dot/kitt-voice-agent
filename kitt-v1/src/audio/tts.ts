import { spawn, ChildProcess } from "node:child_process";
import { log } from "../lib/log.js";

const DEFAULT_VOICE = process.env.TTS_VOICE ?? "Daniel";
const RATE  = parseInt(process.env.TTS_RATE ?? "185");

type SpeakItem = { text: string; voice?: string; onStart?: () => void; onEnd?: () => void };

class SpeechQueue {
  private q: SpeakItem[] = [];
  private active: ChildProcess | null = null;

  enqueue(item: SpeakItem) {
    this.q.push(item);
    if (!this.active) this.next();
  }

  private next() {
    const item = this.q.shift();
    if (!item) return;
    const text = sanitize(item.text);
    if (!text) { this.next(); return; }

    const voice = item.voice ?? DEFAULT_VOICE;
    log("info", "tts", `say[${voice}]: "${text.slice(0, 80)}${text.length > 80 ? "…" : ""}"`);
    const proc = spawn("say", ["-v", voice, "-r", String(RATE), text], { stdio: "ignore" });
    this.active = proc;
    item.onStart?.();

    proc.on("close", () => {
      this.active = null;
      item.onEnd?.();
      this.next();
    });
    proc.on("error", (e) => {
      log("error", "tts", e.message);
      this.active = null;
      item.onEnd?.();
      this.next();
    });
  }

  cancel() {
    this.q = [];
    if (this.active) {
      try { this.active.kill("SIGTERM"); } catch {}
      this.active = null;
      log("info", "tts", "cancelled");
    }
  }

  busy() { return Boolean(this.active) || this.q.length > 0; }
}

// `say` interprets some characters literally. Strip what we don't want spoken.
function sanitize(s: string): string {
  return s
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\bhttps?:\/\/\S+/g, "link")
    .replace(/[*_~#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export const tts = new SpeechQueue();

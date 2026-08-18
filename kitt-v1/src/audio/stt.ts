// STT bridge to the Python whisper sidecar.
// As of 2026-05-16 the sidecar captures at the device's native sample rate
// (typically 48 kHz) and resamples to 16 kHz in Python — see python/whisper_sidecar.py.
import { spawn, ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { log } from "../lib/log.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SIDECAR = join(__dirname, "..", "..", "python", "whisper_sidecar.py");

export type SttEvent =
  | { type: "ready" }
  | { type: "vad"; speaking: boolean }
  | { type: "partial"; text: string }
  | { type: "final"; text: string }
  | { type: "hotword"; text: string }
  | { type: "info"; message: string }
  | { type: "error"; message: string }
  | { type: "debug"; kind: string; [key: string]: unknown };

function formatDebug(evt: Extract<SttEvent, { type: "debug" }>): string {
  const { type: _t, kind, ...rest } = evt;
  const parts = Object.entries(rest).map(([k, v]) => `${k}=${typeof v === "number" ? v.toFixed(6) : v}`);
  return `${kind}${parts.length ? " · " + parts.join(" · ") : ""}`;
}

class STT extends EventEmitter {
  private proc: ChildProcess | null = null;

  start() {
    if (this.proc) return;
    if (!existsSync(SIDECAR)) {
      log("error", "stt", `sidecar not found at ${SIDECAR}`);
      return;
    }

    const venvPy = join(__dirname, "..", "..", "python", ".venv", "bin", "python3");
    const pyBin = existsSync(venvPy) ? venvPy : "python3";

    log("info", "stt", `spawning ${pyBin} ${SIDECAR}`);
    this.proc = spawn(pyBin, [SIDECAR], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    const out = createInterface({ input: this.proc.stdout! });
    out.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const evt = JSON.parse(line) as SttEvent;
        if (evt.type === "debug") log("info", "stt", `[debug] ${formatDebug(evt)}`);
        this.emit("event", evt);
      } catch {
        log("warn", "stt", `unparseable: ${line.slice(0, 120)}`);
      }
    });

    const err = createInterface({ input: this.proc.stderr! });
    err.on("line", (line) => log("warn", "stt", line.slice(0, 200)));

    this.proc.on("close", (code) => {
      log("warn", "stt", `sidecar exited code=${code}`);
      this.proc = null;
    });
  }

  send(cmd: { cmd: "arm" | "disarm" | "quit" }) {
    if (!this.proc?.stdin) return;
    this.proc.stdin.write(JSON.stringify(cmd) + "\n");
  }

  arm()    { this.send({ cmd: "arm" }); }
  disarm() { this.send({ cmd: "disarm" }); }
  stop()   { this.send({ cmd: "quit" }); this.proc = null; }
}

export const stt = new STT();

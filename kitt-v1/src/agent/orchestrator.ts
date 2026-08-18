import { EventEmitter } from "node:events";
import { stt, type SttEvent } from "../audio/stt.js";
import { tts } from "../audio/tts.js";
import { classifyIntent, localAnswer, ollamaHealth } from "./ollama.js";
import { cloudReason } from "./claude.js";
import { loadMemory, storeMemory, memorySize } from "./memory.js";
import { MODES, BASE_SYSTEM_PROMPT, type ModeName } from "../modes/index.js";
import { browserOpen, inferUrl } from "../tools/browser.js";
import { log } from "../lib/log.js";
import { selectPersona, identifySpeaker, type Persona } from "../personas/select.js";
import { endAlfredSession } from "../journal/session-end.js";

export type AgentState = "idle" | "listening" | "thinking" | "speaking";

export interface AgentSnapshot {
  state: AgentState;
  mode: ModeName;
  transcript: string;
  reply: string;
  ollamaUp: boolean;
}

class Agent extends EventEmitter {
  state: AgentState = "idle";
  mode: ModeName = "operator";
  transcript = "";
  reply = "";
  ollamaUp = false;
  private history: { role: "user" | "assistant"; content: string }[] = [];
  private interrupted = false;
  private currentSpeaker: string = process.env.DEFAULT_SPEAKER ?? "jeffery";
  private currentPersona: Persona = "kitt";
  private currentStudentId: string | undefined = undefined;
  private currentVoice: string =
    process.env.TTS_VOICE_KITT ?? process.env.TTS_VOICE ?? "Alex";
  private sessionTranscript: string[] = [];
  private alfredUnreadIds: string[] = [];

  async start() {
    this.ollamaUp = await ollamaHealth();
    log(this.ollamaUp ? "ok" : "warn", "ollama", this.ollamaUp ? "reachable" : "offline — cloud-only");

    stt.on("event", (evt: SttEvent) => this.onStt(evt));
    stt.start();
  }

  setState(s: AgentState) {
    if (s === this.state) return;
    log("info", "agent", `${this.state} → ${s}`);
    this.state = s;
    this.emit("state", s);
    this.emit("snapshot", this.snapshot());
  }

  async setMode(m: ModeName) {
    if (m === this.mode) return;
    this.mode = m;
    this.history = [];
    const size = await memorySize(m);
    log("info", "agent", `mode = ${m} · memory=${size.count}/${size.bytes}b`);
    this.emit("mode", m);
    this.emit("memory_size", size);
    this.emit("snapshot", this.snapshot());
  }

  snapshot(): AgentSnapshot {
    return {
      state: this.state, mode: this.mode,
      transcript: this.transcript, reply: this.reply,
      ollamaUp: this.ollamaUp,
    };
  }

  /** Manual text input (keyboard). Same path as voice. */
  async type(text: string) {
    this.handleUtterance(text.trim());
  }

  interrupt() {
    log("warn", "agent", "interrupt");
    this.interrupted = true;
    tts.cancel();
    stt.disarm();
    this.transcript = "";
    this.reply = "";
    this.setState("idle");
  }

  private onStt(evt: SttEvent) {
    // Audio ducking: while we're speaking, the mic may pick up our own TTS
    // output and the sidecar will transcribe it. Drop hotword/final events
    // that fire during playback to break that feedback loop.
    if (this.state === "speaking" && (evt.type === "hotword" || evt.type === "final")) {
      log("info", "stt", `${evt.type} suppressed during TTS playback`);
      return;
    }
    switch (evt.type) {
      case "ready":
        log("ok", "stt", "ready"); break;
      case "vad":
        if (evt.speaking && this.state === "idle") this.setState("listening");
        break;
      case "hotword":
        log("ok", "stt", `hotword · "${evt.text}"`);
        this.setState("listening");
        stt.arm();
        if (evt.text) this.handleUtterance(evt.text);
        else this.speak("I'm listening.");
        break;
      case "final":
        stt.disarm();
        this.handleUtterance(evt.text);
        break;
      case "info":  log("info", "stt", evt.message); break;
      case "error": log("error", "stt", evt.message); break;
    }
  }

  private async handleUtterance(utterance: string) {
    if (!utterance) return;
    this.interrupted = false;
    this.transcript = utterance;
    this.emit("transcript", utterance);

    // "cancel" / "stop" interrupts any active speech and resets.
    if (/^(cancel|stop|never mind|nevermind|shut up)\.?$/i.test(utterance)) {
      this.interrupt();
      this.speak("Standing down.");
      return;
    }

    this.setState("thinking");

    // Speaker identification (sticky across turns). Resolves persona before
    // any LLM path so the system prompt and TTS voice match who's actually
    // speaking. Kid speakers route to Alfred and bypass the mode router.
    const { speaker: newSpeaker, viaHandoff } = identifySpeaker(utterance, this.currentSpeaker);
    const persona = await selectPersona(newSpeaker);
    if (newSpeaker !== this.currentSpeaker) {
      // Close out any prior Alfred session before switching context.
      if (
        this.currentPersona === "alfred" &&
        this.currentStudentId &&
        this.sessionTranscript.length > 0
      ) {
        const sid = this.currentStudentId;
        const transcript = this.sessionTranscript.slice();
        const unread = this.alfredUnreadIds.slice();
        endAlfredSession(sid, transcript, unread).catch((e: unknown) =>
          log("error", "journal", e instanceof Error ? e.message : String(e)),
        );
      }
      this.currentSpeaker = newSpeaker;
      this.currentPersona = persona.persona;
      this.currentStudentId = persona.studentId;
      this.currentVoice = persona.voice;
      this.sessionTranscript = [];
      this.alfredUnreadIds = persona.unreadMessageIds;
      this.history = [];
      log("info", "persona", `speaker=${newSpeaker} persona=${persona.persona} voice=${persona.voice}${viaHandoff ? " (via handoff)" : ""}`);
    }

    // Daniel-initiated handoff: skip the LLM, have Alfred greet the kid
    // directly. Otherwise Alfred would receive Daniel's literal command
    // ("get alfred to talk to river") as if it came from the kid.
    if (viaHandoff && persona.persona === "alfred" && persona.studentId) {
      const childName = persona.studentId.charAt(0).toUpperCase() + persona.studentId.slice(1);
      this.speak(`Hello, ${childName}. I'm here. What's on your mind?`);
      return;
    }

    // Mode switch shortcut — handle without burning a router call.
    const switchTarget = parseModeSwitch(utterance);
    if (switchTarget) {
      await this.setMode(switchTarget);
      this.speak(`${MODES[switchTarget].label.toLowerCase()} mode.`);
      return;
    }

    // Open-a-thing shortcut.
    const url = inferUrl(utterance);
    if (/\b(open|launch|go to|pull up)\b/i.test(utterance) && url) {
      const r = await browserOpen({ url }, this.mode);
      this.speak(r.ok ? `Opened ${prettyHost(url)}.` : `Couldn't open that.`);
      return;
    }

    // Route via local model.
    let decision: "local" | "cloud" = "cloud";
    let routerMs = 0;
    if (this.ollamaUp) {
      const r = await classifyIntent(utterance);
      routerMs = r.latencyMs;
      this.emit("latency", { kind: "local", ms: routerMs });
      if (r.decision === "local")   decision = "local";
      if (r.decision === "tool")    decision = "cloud";
    }
    log("info", "router", `decision=${decision} routerMs=${routerMs}`);

    // Local one-shot.
    if (decision === "local" && this.ollamaUp) {
      const sys =
        persona.persona === "alfred" && persona.systemPrompt
          ? persona.systemPrompt + "\n\nReply in ONE sentence."
          : BASE_SYSTEM_PROMPT +
            "\n\n" +
            MODES[this.mode].systemFragment +
            "\n\nReply in ONE sentence." +
            persona.busContextAppendix;
      const r = await localAnswer(utterance, sys);
      this.emit("latency", { kind: "local", ms: r.latencyMs });
      this.sessionTranscript.push(`${this.currentSpeaker}: ${utterance}`, `${persona.persona}: ${r.text}`);
      this.speak(r.text);
      return;
    }

    // Cloud reasoning.
    const memory = await loadMemory(this.mode);
    const sys =
      persona.persona === "alfred" && persona.systemPrompt
        ? persona.systemPrompt
        : BASE_SYSTEM_PROMPT +
          "\n\n" +
          MODES[this.mode].systemFragment +
          (memory ? `\n\nMODE MEMORY:\n${memory}` : "") +
          persona.busContextAppendix;

    const r = await cloudReason(utterance, sys, this.history);
    this.emit("latency", { kind: "cloud", ms: r.latencyMs });
    this.emit("cost", { usd: r.usd, inputTokens: r.inputTokens, outputTokens: r.outputTokens });

    if (!r.ok) {
      // Graceful fallback to local when cloud fails.
      if (this.ollamaUp) {
        log("warn", "agent", "cloud failed — falling back to local");
        const sys2 = BASE_SYSTEM_PROMPT + "\n\n" + MODES[this.mode].systemFragment + "\n\nReply in ONE short sentence.";
        const f = await localAnswer(utterance, sys2);
        this.speak("Cloud response delayed. Using local systems. " + f.text);
      } else {
        this.speak("Cloud unavailable, and I'm running without local backup.");
      }
      return;
    }

    this.history.push({ role: "user", content: utterance }, { role: "assistant", content: r.text });
    if (this.history.length > 12) this.history = this.history.slice(-12);

    this.sessionTranscript.push(`${this.currentSpeaker}: ${utterance}`, `${persona.persona}: ${r.text}`);
    this.speak(r.text);

    // Lightweight memory: persist the user's utterance as scratch.
    // (Mode-scoped memory; the kid notebook journal is the durable Alfred memory.)
    if (persona.persona !== "alfred") {
      storeMemory(this.mode, "transcript", utterance).catch(() => {});
    }
  }

  private speak(text: string) {
    if (this.interrupted) return;
    this.reply = text;
    this.emit("reply", text);
    this.setState("speaking");
    tts.enqueue({
      text,
      voice: this.currentVoice,
      onEnd: () => {
        if (this.state === "speaking") this.setState("idle");
      },
    });
  }
}

function parseModeSwitch(utterance: string): ModeName | null {
  const m = utterance.toLowerCase().match(/\b(?:switch to|go to|enter|use)\s+(operator|novara|home\s?repair|kaischa|builder)\s*(?:mode)?\b/);
  if (!m) return null;
  const raw = m[1].replace(/\s+/g, "");
  if (raw === "homerepair") return "homerepair";
  return raw as ModeName;
}

function prettyHost(url: string): string {
  try { return new URL(url).host.replace(/^www\./, ""); }
  catch { return url; }
}

export const agent = new Agent();

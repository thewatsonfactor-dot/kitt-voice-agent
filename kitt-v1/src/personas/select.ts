import { loadNotebook, listStudents } from "../students/notebook.js";
import { readBus } from "../household/bus.js";
import { buildDashboardContext } from "../household/dashboard-context.js";
import { buildAlfredPrompt } from "./build-alfred-prompt.js";

export type Persona = "kitt" | "alfred";

export interface PersonaResult {
  persona: Persona;
  /** Full system prompt for Alfred. Undefined for Kitt — orchestrator composes its own. */
  systemPrompt?: string;
  /** Bus context to append to Kitt's composed system prompt. Empty for Alfred. */
  busContextAppendix: string;
  voice: string;
  studentId?: string;
  /** Unread message IDs delivered to this persona — orchestrator marks them read at session end. */
  unreadMessageIds: string[];
}

export interface SpeakerId {
  speaker: string;
  /** True when Daniel explicitly handed off to Alfred for a specific child. */
  viaHandoff: boolean;
}

/**
 * Sticky speaker identification.
 *
 * Recognizes three speaker-change phrasings:
 *   1. Handback ("i'm done", "back to kitt") → DEFAULT_SPEAKER
 *   2. Daniel-initiated handoff ("let alfred talk to river", "get alford for kinsley")
 *      → the named kid, marked viaHandoff=true so the orchestrator can greet
 *      rather than pass Daniel's command to Alfred
 *   3. Kid self-identification ("hey kitt this is river", "i'm river") → the kid
 *
 * Accepts both "alfred" and the common misspelling/mishearing "alford".
 * Otherwise returns currentSpeaker unchanged so the persona doesn't flicker.
 */
export function identifySpeaker(text: string, currentSpeaker: string): SpeakerId {
  const lower = text.toLowerCase();
  if (
    /\b(switch back to (kitt|daniel|dad)|that'?s all|i'?m done|kids? done|back to (kitt|dad|daniel))\b/.test(
      lower,
    )
  ) {
    return { speaker: process.env.DEFAULT_SPEAKER || "jeffery", viaHandoff: false };
  }
  // Daniel-initiated handoff: "let/get/have/bring/ask alfred [to] talk/speak/help/etc to <kid>"
  const handoff1 = lower.match(
    /\b(?:let|have|get|bring|fetch|tell|ask|put)\s+al(?:fre|for)d\s+(?:to\s+)?(?:talk|speak|chat|help|tend|see|come|in)(?:\s+(?:to|with|for))?\s+([a-zA-Z]+)\b/,
  );
  if (handoff1) return { speaker: handoff1[1], viaHandoff: true };
  // "alfred, talk to river" / "alford please help kinsley"
  const handoff2 = lower.match(
    /\bal(?:fre|for)d[, ]+(?:please\s+)?(?:talk|speak|help|tend|see|come)\s+(?:to|with|for)?\s*([a-zA-Z]+)\b/,
  );
  if (handoff2) return { speaker: handoff2[1], viaHandoff: true };
  // Self-identification
  const m = text.match(
    /(?:this is|it'?s|hey kitt[, ]+i'?m|hey alfred[, ]+it'?s|i'?m)\s+([a-zA-Z]+)/i,
  );
  if (m) return { speaker: m[1].toLowerCase(), viaHandoff: false };
  return { speaker: currentSpeaker, viaHandoff: false };
}

export async function selectPersona(speaker: string): Promise<PersonaResult> {
  const speakerLower = speaker.toLowerCase().trim();
  const students = await listStudents();
  const bus = await readBus();

  // Kid speaker → Alfred, bypasses the 5-mode router.
  if (students.includes(speakerLower)) {
    const notebook = await loadNotebook(speakerLower);
    if (notebook) {
      const systemPrompt = await buildAlfredPrompt(notebook, bus);
      const unread = bus.messages.filter(
        (m) => !m.read && (m.to === "alfred" || m.to === "both"),
      );
      return {
        persona: "alfred",
        systemPrompt,
        busContextAppendix: "",
        voice: process.env.TTS_VOICE_ALFRED || "Daniel",
        studentId: speakerLower,
        unreadMessageIds: unread.map((m) => m.id),
      };
    }
  }

  // Adult speaker → Kitt. Orchestrator composes BASE + mode + memory; we
  // contribute the bus appendix and message list for Kitt's awareness.
  const unreadFromAlfred = bus.messages.filter(
    (m) => !m.read && m.from === "alfred" && (m.to === "kitt" || m.to === "both"),
  );
  const unreadOther = bus.messages.filter(
    (m) =>
      !m.read &&
      m.from !== "alfred" &&
      (m.to === "kitt" || m.to === "both"),
  );

  const todayBlock = bus.today
    ? JSON.stringify(bus.today, null, 2)
    : "(no plan posted yet today)";
  const activeFlags = bus.flags.filter((f) => !f.resolved);
  const flagsBlock = activeFlags.length
    ? activeFlags
        .map(
          (f) =>
            `[${f.severity}] ${f.text}${f.about ? ` (about ${f.about})` : ""}`,
        )
        .join("\n")
    : "(none)";
  const alfredMsgs = unreadFromAlfred.length
    ? unreadFromAlfred
        .map((m) => `- ${m.about ? `[about ${m.about}] ` : ""}${m.text}`)
        .join("\n")
    : "(none)";

  const dashboardContext = await buildDashboardContext();

  const busContextAppendix = [
    "",
    "FAMILY BUS — today:",
    todayBlock,
    "",
    "FAMILY BUS — active flags:",
    flagsBlock,
    "",
    "FAMILY BUS — unread messages from Alfred:",
    alfredMsgs,
    dashboardContext,
  ].join("\n");

  return {
    persona: "kitt",
    systemPrompt: undefined,
    busContextAppendix,
    voice:
      process.env.TTS_VOICE_KITT ||
      process.env.TTS_VOICE ||
      "Alex",
    unreadMessageIds: [...unreadFromAlfred, ...unreadOther].map((m) => m.id),
  };
}

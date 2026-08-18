import type { Persona } from "../personas/select.js";

export function selectVoice(persona: Persona): string {
  if (persona === "alfred") {
    return process.env.TTS_VOICE_ALFRED || "Daniel";
  }
  return process.env.TTS_VOICE_KITT || process.env.TTS_VOICE || "Alex";
}

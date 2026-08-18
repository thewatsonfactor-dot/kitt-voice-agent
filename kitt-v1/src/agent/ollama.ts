import { log } from "../lib/log.js";

const URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const ROUTER_MODEL = process.env.OLLAMA_ROUTER_MODEL ?? "qwen2.5:7b";
const FALLBACK_MODEL = process.env.OLLAMA_FALLBACK_MODEL ?? "qwen2.5:7b";
const ROUTER_TIMEOUT = parseInt(process.env.OLLAMA_ROUTER_TIMEOUT_MS ?? "600");

interface OllamaResponse {
  response?: string;
  eval_count?: number;
  prompt_eval_count?: number;
  total_duration?: number;
}

async function generate(
  model: string,
  prompt: string,
  system: string,
  timeoutMs: number,
  opts: { temperature?: number; numPredict?: number } = {},
): Promise<{ text: string; ok: boolean; latencyMs: number }> {
  const t0 = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${URL}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model, prompt, system,
        stream: false,
        options: {
          temperature: opts.temperature ?? 0.2,
          num_predict: opts.numPredict ?? 256,
        },
      }),
      signal: ctl.signal,
    });
    if (!r.ok) {
      log("warn", "ollama", `${model} returned ${r.status}`);
      return { text: "", ok: false, latencyMs: Date.now() - t0 };
    }
    const data = (await r.json()) as OllamaResponse;
    return { text: (data.response ?? "").trim(), ok: true, latencyMs: Date.now() - t0 };
  } catch (e: any) {
    if (e.name === "AbortError") {
      log("warn", "ollama", `${model} timeout @ ${timeoutMs}ms`);
    } else {
      log("error", "ollama", e.message ?? String(e));
    }
    return { text: "", ok: false, latencyMs: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

/** Classify intent. Returns one of: local | cloud | mode_switch | tool. */
export async function classifyIntent(utterance: string): Promise<{
  decision: "local" | "cloud" | "mode_switch" | "tool";
  target?: string;
  latencyMs: number;
}> {
  const system =
    `You are a router. Classify the user's utterance into one decision. ` +
    `Reply with ONE WORD only from this set: local, cloud, mode_switch, tool. ` +
    `Rules:\n` +
    `- "switch to X mode" or "go to X" -> mode_switch\n` +
    `- "open <site>" or "launch <app>" -> tool\n` +
    `- short factual or chitchat ("what time is it", "thanks") -> local\n` +
    `- anything requiring reasoning, drafting, summarizing, planning -> cloud`;
  const r = await generate(ROUTER_MODEL, utterance, system, ROUTER_TIMEOUT, { numPredict: 8, temperature: 0 });
  const word = r.text.toLowerCase().split(/\s+/)[0] ?? "cloud";
  let decision: "local" | "cloud" | "mode_switch" | "tool" = "cloud";
  if (word.startsWith("local"))        decision = "local";
  else if (word.startsWith("mode"))    decision = "mode_switch";
  else if (word.startsWith("tool"))    decision = "tool";
  return { decision, latencyMs: r.latencyMs };
}

/** Cheap one-shot local answer when intent is "local". */
export async function localAnswer(utterance: string, systemPrompt: string): Promise<{ text: string; latencyMs: number; tokens: number }> {
  const r = await generate(FALLBACK_MODEL, utterance, systemPrompt, 4000, { temperature: 0.5, numPredict: 96 });
  return { text: r.text || "I'm not sure.", latencyMs: r.latencyMs, tokens: 96 };
}

/** Health check. */
export async function ollamaHealth(): Promise<boolean> {
  try {
    const r = await fetch(`${URL}/api/tags`, { signal: AbortSignal.timeout(800) });
    return r.ok;
  } catch { return false; }
}

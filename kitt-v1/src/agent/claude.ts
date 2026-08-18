import Anthropic from "@anthropic-ai/sdk";
import { log, recordCost, isUnderCap } from "../lib/log.js";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";
const MAX_TOKENS = parseInt(process.env.ANTHROPIC_MAX_TOKENS ?? "1024");
const TIMEOUT_MS = parseInt(process.env.ANTHROPIC_TIMEOUT_MS ?? "8000");

export interface CloudResult {
  text: string;
  ok: boolean;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  reason?: string;
}

export async function cloudReason(
  utterance: string,
  systemPrompt: string,
  history: { role: "user" | "assistant"; content: string }[] = [],
): Promise<CloudResult> {
  const cap = await isUnderCap();
  if (!cap.under) {
    log("warn", "anthropic", `daily cap reached ($${cap.spent.toFixed(2)}/$${cap.cap.toFixed(2)}) — skipping cloud`);
    return {
      text: "", ok: false, latencyMs: 0, inputTokens: 0, outputTokens: 0, usd: 0,
      reason: "daily_cap_reached",
    };
  }

  const t0 = Date.now();
  try {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages: [...history, { role: "user", content: utterance }],
    }, { timeout: TIMEOUT_MS });

    const latencyMs = Date.now() - t0;
    const text = resp.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("")
      .trim();

    const inputTokens  = resp.usage?.input_tokens  ?? 0;
    const outputTokens = resp.usage?.output_tokens ?? 0;
    const usd = await recordCost(MODEL, inputTokens, outputTokens);

    log("ok", "anthropic", `${latencyMs}ms · ${inputTokens}+${outputTokens}t · $${usd.toFixed(4)}`);
    return { text, ok: true, latencyMs, inputTokens, outputTokens, usd };
  } catch (e: any) {
    const latencyMs = Date.now() - t0;
    log("error", "anthropic", `${e.message ?? e} (${latencyMs}ms)`);
    return {
      text: "", ok: false, latencyMs, inputTokens: 0, outputTokens: 0, usd: 0,
      reason: e.message ?? "unknown",
    };
  }
}

export async function anthropicHealth(): Promise<boolean> {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

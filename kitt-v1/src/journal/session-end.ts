import Anthropic from "@anthropic-ai/sdk";
import { loadNotebook, appendEntry } from "../students/notebook.js";
import { raiseFlag, postMessage, markMessageRead } from "../household/bus.js";
import { log, isUnderCap, recordCost } from "../lib/log.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";

interface JournalOutput {
  summary: string;
  learned: string | null;
  flag: {
    severity: "note" | "attention" | "priority";
    text: string;
  } | null;
  messageToKitt: string | null;
}

/**
 * Summarize an Alfred ↔ kid session into a notebook entry, then post any
 * relevant coordination signals to the family bus. Fire-and-forget — failures
 * log but don't break the agent.
 */
export async function endAlfredSession(
  studentId: string,
  transcript: string[],
  unreadMessageIds: string[] = [],
): Promise<void> {
  if (transcript.length === 0) return;

  const notebook = await loadNotebook(studentId);
  if (!notebook) {
    log("error", "journal", `notebook not found for ${studentId}`);
    return;
  }

  const cap = await isUnderCap();
  if (!cap.under) {
    log(
      "warn",
      "journal",
      `daily cap reached — skipping journal for ${studentId}`,
    );
    return;
  }

  const prompt = `You are Alfred Pennyworth Watson, reviewing your conversation with ${notebook.name} (age ${notebook.age ?? "unknown"}, tier ${notebook.tier}).

What you already know about them:
- Who they are: ${notebook.whoTheyAre}
- How they learn: ${notebook.howTheyLearn}
- Currently working on: ${notebook.currentWork}

Today's transcript:
${transcript.map((line, i) => `[${i}] ${line}`).join("\n")}

Write a single concise journal entry. Return JSON ONLY, no preamble or markdown fences:
{
  "summary": "2-3 sentences on what happened in this session",
  "learned": "one specific thing you learned about ${notebook.name}, or null if nothing new",
  "flag": { "severity": "note" | "attention" | "priority", "text": "..." } or null,
  "messageToKitt": "a one-sentence note for Kitt if something the parents should know in their next conversation, or null"
}

Rules:
- Do NOT include anything ${notebook.name} told you in confidence unless safety requires it.
- Flag severity "priority" ONLY for safety concerns (abuse, self-harm, danger).
- Flag severity "attention" for emotional or pattern concerns worth a parent's eyes.
- Flag severity "note" for ordinary household coordination.
- messageToKitt should describe coordination info (interests, project ideas, scheduling), NEVER private content.`;

  let output: JournalOutput;
  try {
    const t0 = Date.now();
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 800,
      messages: [{ role: "user", content: prompt }],
    });
    const latencyMs = Date.now() - t0;

    const inputTokens = response.usage?.input_tokens ?? 0;
    const outputTokens = response.usage?.output_tokens ?? 0;
    await recordCost(MODEL, inputTokens, outputTokens);

    const text = response.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("")
      .replace(/```json|```/g, "")
      .trim();

    log("info", "journal", `${latencyMs}ms · ${notebook.name} · ${inputTokens}+${outputTokens}t`);

    try {
      output = JSON.parse(text);
    } catch {
      log("error", "journal", `failed to parse model output: ${text.slice(0, 200)}`);
      return;
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    log("error", "journal", `anthropic call failed: ${msg}`);
    return;
  }

  await appendEntry(studentId, {
    timestamp: new Date().toISOString(),
    summary: output.summary,
    learned: output.learned ?? undefined,
    flag: output.flag?.text,
  });

  if (output.flag) {
    await raiseFlag({
      raisedBy: "alfred",
      about: notebook.name,
      severity: output.flag.severity,
      text: output.flag.text,
    });
  }

  if (output.messageToKitt) {
    await postMessage({
      from: "alfred",
      to: "kitt",
      about: notebook.name,
      text: output.messageToKitt,
    });
  }

  for (const id of unreadMessageIds) {
    await markMessageRead(id);
  }
}

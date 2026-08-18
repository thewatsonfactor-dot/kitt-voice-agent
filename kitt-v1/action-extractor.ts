import Anthropic from "@anthropic-ai/sdk";
import { addTodo } from "../household/comms-bus.js";
import { log } from "../lib/log.js";

const client = new Anthropic();

export async function extractActions(
  commText: string,
  entity: string,
  source: "email" | "imessage" | "voice" = "email",
) {
  if (!process.env.ANTHROPIC_API_KEY) return [];

  try {
    const resp = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 500,
      system: `Extract action items from this communication for Daniel Watson.
Return ONLY valid JSON like: { "actions": [{ "title": "...", "notes": "...", "dueHint": "...", "priority": "high|medium|low" }] }
If no actions, return: { "actions": [] }`,
      messages: [{ role: "user", content: commText }],
    });

    const text = resp.content[0].type === "text" ? resp.content[0].text : "";
    const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());

    for (const action of parsed.actions ?? []) {
      await addTodo({
        title:     action.title,
        notes:     action.notes,
        dueHint:   action.dueHint,
        priority:  action.priority ?? "medium",
        entity,
        source,
        done:      false,
        createdAt: new Date().toISOString(),
      });
      log("info", "actions", `todo: [${action.priority}] ${action.title}`);
    }

    return parsed.actions ?? [];
  } catch (e) {
    log("error", "actions", e instanceof Error ? e.message : String(e));
    return [];
  }
}
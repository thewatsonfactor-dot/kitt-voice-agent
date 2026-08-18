# First Prompt for Claude Code

Paste the section below into Claude Code after running `claude` inside the project directory. The PRD (`PRD.md`) should already be in the repo root so Claude Code can read it.

---

## PROMPT (copy from here ↓)

You are scaffolding **Watson JARVIS**, a voice-first personal agent. Read `PRD.md` in this directory before doing anything — it defines scope, modes, tools, and guardrails. Your job is to ship **only the MVP defined in §11 of the PRD**: hotword → STT → Claude → TTS → speakers, plus a single `browser.open` tool. Do not implement other tools, other modes, the web UI, or memory. Those are later phases.

### Constraints

- **Runtime:** Node.js 22 LTS, TypeScript 5, ESM modules, `pnpm` as the package manager
- **Platform:** macOS (this runs on my Mac Mini, 38GB unified memory) — Linux/Windows support not required for MVP
- **Repo layout:** match §14 of the PRD exactly, but only create the files needed for MVP. Stub the rest as empty directories with a `.gitkeep`.
- **No build step for v1:** use `tsx` to run TypeScript directly. We'll add `tsc` later.
- **Secrets:** every key reads from `process.env` via `dotenv`. Never hardcode. `.env.example` lives in the repo; `.env` is gitignored.

### Required dependencies

Pick the latest stable versions. Lock with `pnpm install` and commit `pnpm-lock.yaml`.

| Package | Purpose |
|---|---|
| `@anthropic-ai/sdk` | Claude API client |
| `@picovoice/porcupine-node` | Hotword detection ("Watson") |
| `@picovoice/pvrecorder-node` | Mic capture compatible with Porcupine |
| `nodejs-whisper` | Local STT via whisper.cpp (no Python sidecar) |
| `elevenlabs` | Streaming TTS |
| `speaker` | PCM audio output to system speakers |
| `express` | Local server on :7878 (stub for now, single `/health` route) |
| `dotenv` | Env loading |
| `tsx` | Run TS without a build step |
| `typescript`, `@types/node`, `@types/express` | Types |

If `nodejs-whisper` proves flaky on Apple Silicon, fall back to spawning a Python subprocess running `faster-whisper` — flag this in `README.md` if you make that switch.

### Models

- **Reasoning model:** `claude-sonnet-4-6` (string: `claude-sonnet-4-6`)
- **Router/classification model (later phase, not MVP):** `claude-haiku-4-5-20251001`

For the MVP, every utterance goes straight to Sonnet 4.6 with the Operator-mode system prompt fragment loaded inline.

### Wake word

Use the built-in "Computer" wake word from Porcupine for the very first commit so I can test without going to the Picovoice console. Then add a TODO to swap in a custom "Watson" wake word file (`watson.ppn`) once I generate one at console.picovoice.ai. Keep the path configurable via `PORCUPINE_KEYWORD_PATH` env var.

### Audio loop

1. Porcupine listens continuously
2. On wake detected: beep (use a short embedded WAV — generate one with a 200ms 880Hz sine), stop the hotword listener, start recording from the mic
3. Stop recording on 1.0s of silence (RMS threshold) **or** at 15s hard cap
4. Run whisper on the captured PCM
5. Send transcript to Claude with tool schema for `browser.open`
6. If Claude returns text → stream to ElevenLabs → play through `speaker`
7. If Claude returns a `browser.open` tool call → exec it, then speak a 1-sentence confirmation
8. Return to step 1

Use the Node `EventEmitter` pattern. The loop must be cancellable with `Ctrl-C` and resume cleanly.

### The single tool

```ts
// src/tools/browser.ts
export const browserOpenSchema = {
  name: "browser_open",
  description: "Open a URL in the user's default browser (Chrome on macOS).",
  input_schema: {
    type: "object",
    properties: {
      url: { type: "string", description: "Full URL including https://" }
    },
    required: ["url"]
  }
};

export async function browserOpen(input: { url: string }) {
  // shell out to `open -a "Google Chrome" <url>`
  // sanitize: must start with http:// or https://, no shell metachars
  // return { ok: true, opened: url } or { ok: false, error: "..." }
}
```

### System prompt (MVP)

```
You are Watson, Jeffery's butler. You speak in 1–3 sentences. You never narrate
tool calls aloud — you just call them and then speak the result. You never call
Jeffery "sir" more than once per session. You are dry, precise, and reserved.
You assume good faith on Jeffery's part and do not ask clarifying questions
for things you can reasonably infer.

If Jeffery asks you to open something on the web, use the browser_open tool.
Otherwise, just answer.
```

### Acceptance criteria (the sanity test)

After `pnpm install && pnpm dev`, the console prints:

```
[watson] hotword armed, listening for "computer"…
```

Then I run this end-to-end test, and **all five steps must work in one continuous session without restarting**:

1. Say *"Computer"* → I hear a short beep
2. Say *"What's two plus two?"* → Watson speaks "Four." within ~3 seconds
3. Say *"Computer"* → beep again
4. Say *"Open Google for me"* → Chrome opens to https://google.com **and** Watson speaks a one-sentence confirmation
5. Press `Ctrl-C` → clean shutdown, no orphan processes, no audio device left open

If any of these fails, fix it before declaring done.

### What NOT to do

- Do **not** implement Gmail, Calendar, Drive, Shell, Notes, Memory, or Mode tools
- Do **not** build the Next.js UI
- Do **not** add Postgres, Prisma, or Docker
- Do **not** add a routing layer or multi-mode logic — single hardcoded prompt only
- Do **not** add a "send email" or anything that mutates external state besides opening a browser
- Do **not** auto-pick versions older than 2025 — use current stable

### Deliverables

When done, commit everything to a single branch (`mvp/v0.1`) and produce:
1. Working code per the acceptance criteria
2. `README.md` with: prereqs (Homebrew installs needed), env vars to fill, `pnpm dev` instructions, and the exact 5-step test above
3. A `KNOWN_ISSUES.md` if anything you ran into would bite the next phase

If you hit a blocker that requires a decision from me (e.g., whisper.cpp won't compile on my Mac, ElevenLabs voice ID needed), stop and ask — don't guess on anything that touches API keys, audio devices, or shell execution.

Begin.

## PROMPT (copy to here ↑)

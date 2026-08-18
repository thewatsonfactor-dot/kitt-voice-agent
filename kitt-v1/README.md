# KITT

Voice-first AI co-pilot. Local-first. Low-cost. Inspired by Knight Industries Two Thousand.

Stack: **Node.js 22 + TypeScript** (agent + Express/WS server), **Python 3** (faster-whisper sidecar), **Ollama** (Qwen 2.5 7B for routing + local fallback), **Anthropic Claude** (Sonnet 4.6 for reasoning, capped daily spend), **Prisma + SQLite** (memory + cost ledger), **macOS `say`** (TTS).

## Prerequisites (macOS)

```bash
brew install node@22 pnpm python@3.12
xcode-select --install     # if you haven't
```

Ollama should already be running with `qwen2.5:7b` pulled. Verify:

```bash
ollama list                # confirms qwen2.5:7b is there
curl -s http://localhost:11434/api/tags | head
```

## API keys

Two keys total:

1. **Anthropic** — https://console.anthropic.com/settings/keys (create a NEW key dedicated to KITT so you can revoke it without touching Claude Code or your existing Watson Agent)

That's it. No ElevenLabs, no Picovoice, no paid services for V1.

## Setup

```bash
cd kitt
cp .env.example .env
# edit .env — paste your Anthropic key

pnpm install
pnpm db:push                # creates kitt.db from schema
pnpm whisper:setup          # creates python/.venv, installs faster-whisper
```

The first run will compile faster-whisper and download `small.en` (~500 MB).

Grant the terminal microphone access when macOS prompts: **System Settings → Privacy & Security → Microphone → Terminal**.

## Run

```bash
pnpm dev
```

Opens HTTP + WebSocket on **http://localhost:7878**. Open that URL in your browser. The dashboard connects via WS automatically.

## How to use it

Three ways to talk to KITT:

1. **Voice (hotword):** say *"Hey KITT, what time is it"* — the phrase "hey kitt" triggers arming, the next utterance is transcribed and processed.
2. **Voice (post-wake):** after the hotword fires, you have ~15 seconds to speak your command.
3. **Keyboard:** type into the bar at the bottom and hit Enter. Same code path as voice.

Cancel anytime by saying *"cancel"*, pressing the **Cancel** button, or pressing **Esc**.

## How the brain routes a turn

```
utterance → mode-switch shortcut? → handled locally, no LLM call
         → "open <thing>" shortcut? → browser_open tool, no LLM call
         → Ollama router (qwen2.5:7b, ~50-150ms)
              ├── decision = "local"  → Ollama answers (free, fast)
              └── decision = "cloud"  → Claude Sonnet 4.6 (paid, smart)
                         ↓ on failure
                     fallback to Ollama with "cloud delayed" preamble
```

Daily spend cap (`DAILY_COST_CAP_USD`, default $2.00) hard-blocks cloud calls past the limit — KITT degrades to local-only instead of running up the bill.

## Modes

Five contexts, each with its own memory namespace, system prompt fragment, and accent color:

| Mode       | Color  | Memory namespace |
|------------|--------|------------------|
| Operator   | white  | cross-cutting    |
| Novara     | amber  | construction     |
| HomeRepair | cyan   | SaaS             |
| Kaischa    | violet | creative         |
| Builder    | crimson| dev work         |

Switch via voice (*"switch to Novara"*) or click the mode buttons.

## Why SQLite (and when to switch)

KITT uses SQLite for memory and the cost ledger. This is a deliberate choice, not a placeholder.

**The mental model.** Postgres is a *server* you connect to. SQLite is a *file* you open. The "database" is literally `prisma/kitt.db` sitting in the repo. When Node boots, Prisma opens that file the same way any program opens any file. There is no daemon, no port, no `brew services start`, nothing to be "down."

**Startup sequence:**

```
pnpm dev
  → Node starts
  → Prisma client loads
  → opens prisma/kitt.db    (if missing, error — fix with `pnpm db:push`)
  → server listens on :7878
```

The only one-time setup is `pnpm db:push`, which reads `schema.prisma` and creates the file. After that, it just sits there. Reboot your Mac — file is still there. Restart Node a hundred times — it reopens each time. **There is no "is the service up" failure mode** because there is no service.

**What you lose vs Postgres:**

- Concurrent writers — SQLite serializes writes (one at a time). Fine for KITT: single user, single agent process, single writer.
- Network access — no remote machine can query the DB. Fine: KITT is local-by-design.
- Heavy concurrent reads at scale — doesn't apply at single-user scale.

**What you gain:**

- Backups are `cp prisma/kitt.db ~/Dropbox/`. Done.
- No port conflicts, no auth setup, no Docker, no `pg_dump`.
- Works on a plane.
- One less thing that can crash at 11pm.

**When to switch to Postgres:**

- You want to run KITT on a remote server and connect from multiple devices
- You want a second app (a mobile UI, an analytics dashboard) reading the same DB
- The memory namespace grows past ~100k rows per mode (SQLite handles this fine, but Postgres has better full-text search)

**How to switch** (two lines, when the time comes):

```diff
  datasource db {
-   provider = "sqlite"
-   url      = "file:./kitt.db"
+   provider = "postgresql"
+   url      = env("DATABASE_URL")
  }
```

Add `DATABASE_URL=postgresql://...` to `.env`, run `pnpm db:push` against the new instance, migrate any existing data with `sqlite3 kitt.db .dump | pg_restore`. The agent code does not change at all — Prisma abstracts the dialect.

## What's NOT in V1 (intentionally)

- ElevenLabs / paid TTS — using macOS `say` instead
- Porcupine hotword — using rolling-whisper detection instead
- Gmail / Calendar / Drive tools — only `browser_open` for now
- Tailscale-exposed mobile UI
- Two-step confirms for destructive actions
- Postgres — using SQLite (swap when you outgrow it)

## Voice tuning

Default voice is **Daniel** (British male). Other good defaults:

```bash
say -v Alex "Hello"        # American male, classic, closest to William Daniels
say -v Daniel "Hello"      # British male, sleek
say -v Fred "Hello"        # slightly robotic, almost too on-the-nose
say -v "?"                 # list all available voices
```

Change `TTS_VOICE` in `.env` to swap.

## Troubleshooting

- **`pnpm whisper:setup` fails on PyTorch wheel:** ensure Python is 3.12 (`python3.12 -m venv ...`). `pip install faster-whisper` shouldn't need PyTorch directly; it uses CTranslate2.
- **Mic permission denied:** System Settings → Privacy & Security → Microphone, enable for your terminal app.
- **Ollama not reachable:** `ollama serve` in another terminal, or check that the Ollama desktop app is running.
- **"daily cap reached":** raise `DAILY_COST_CAP_USD` in `.env` or wait until tomorrow.
- **Hotword false-triggers from background TV:** raise `RMS_THRESHOLD` in `python/whisper_sidecar.py` from `0.012` to `0.02`.

## Files

```
kitt/
├── package.json
├── tsconfig.json
├── .env.example
├── prisma/schema.prisma
├── python/whisper_sidecar.py        # mic + STT + hotword detection
├── public/index.html                # the cinematic frontend, wired to WS
└── src/
    ├── server.ts                    # Express + WS, entry point
    ├── lib/log.ts                   # logger + cost tracker
    ├── modes/index.ts               # 5 mode definitions
    ├── tools/browser.ts             # browser_open tool
    ├── audio/
    │   ├── tts.ts                   # `say` queue, interrupt
    │   └── stt.ts                   # Python sidecar bridge
    ├── agent/
    │   ├── ollama.ts                # local router + fallback
    │   ├── claude.ts                # cloud reasoning with cap
    │   ├── memory.ts                # per-mode SQLite
    │   └── orchestrator.ts          # the state machine
    └── ws/events.ts                 # typed WS contract
```

## Next phases

- **V1.1** — Porcupine hotword for lower CPU; Gmail + Calendar tools
- **V1.5** — Privacy Mode (lock to local-only); Tailscale-exposed mobile UI
- **V2** — Sheets/Replit tools; WhatsApp bridge; smart home

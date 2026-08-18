# Watson JARVIS

Voice-first personal agent for Jeffery Watson. Listens via mic, executes via Claude, speaks via ElevenLabs.

See `PRD.md` for the full spec. This README covers MVP setup only.

## Prerequisites (macOS)

```bash
# Node 22 LTS and pnpm
brew install node@22 pnpm

# whisper.cpp's build dependencies (nodejs-whisper compiles whisper.cpp on first run)
brew install cmake

# sox is used by some Node audio packages; speaker bindings need it on some setups
brew install sox

# For the `speaker` package native build
xcode-select --install   # one-time, if you haven't already
```

## API keys you need before running

1. **Anthropic** — https://console.anthropic.com/settings/keys (create a NEW key, dedicated to JARVIS)
2. **Picovoice** — https://console.picovoice.ai (free tier is fine for personal use)
3. **ElevenLabs** — https://elevenlabs.io/app/settings/api-keys

## Bootstrap

```bash
git init
git checkout -b mvp/v0.1
cp .env.example .env
# fill in .env with your three keys
pnpm install
```

The first `pnpm install` will compile whisper.cpp and download the `small.en` model (~500MB). Give it 2–5 minutes.

## Hand off to Claude Code

From the project root:

```bash
claude
```

Then paste the entire **PROMPT** block from `CLAUDE_CODE_PROMPT.md`. Claude Code will scaffold the rest.

## The 5-step sanity test

After Claude Code reports "done":

```bash
pnpm dev
```

You should see:
```
[watson] hotword armed, listening for "computer"…
```

Then, in one continuous session (no restarts):

1. Say **"Computer"** → hear a short beep
2. Say **"What's two plus two?"** → Watson answers "Four." aloud within ~3 seconds
3. Say **"Computer"** → beep again
4. Say **"Open Google for me"** → Chrome opens to https://google.com + Watson confirms aloud
5. `Ctrl-C` → clean shutdown

If any step fails, fix before moving on to Phase V1.

## What's NOT in MVP

- Gmail, Calendar, Drive, Shell, Notes, Memory, Mode tools
- The Next.js web UI
- Postgres / pgvector / Docker
- The five-mode router
- Mobile / Tailscale access

All of the above are tracked in `PRD.md` §11 under V1, V1.5, and V2.

## File layout

```
.
├── PRD.md                  ← the spec
├── CLAUDE_CODE_PROMPT.md   ← what you paste into Claude Code
├── README.md               ← this file
├── package.json
├── tsconfig.json
├── .env.example
├── .gitignore
└── src/                    ← Claude Code creates this
```

## Troubleshooting

- **`speaker` build fails on Apple Silicon:** try `pnpm rebuild speaker` after `xcode-select --install`. If still failing, fall back to piping PCM to `afplay` via a child process — note this in `KNOWN_ISSUES.md`.
- **whisper.cpp won't compile:** swap `nodejs-whisper` for spawning a Python `faster-whisper` subprocess. Same I/O contract.
- **Porcupine says "invalid access key":** make sure you're not pasting the *project* key from Picovoice console — you want the **AccessKey** under your profile.
- **Mic permission denied:** System Settings → Privacy & Security → Microphone → enable Terminal (or your terminal app).

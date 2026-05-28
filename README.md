# Floot — Voice Assistant

Record your voice in the browser, get a transcript powered by [OpenAI Whisper](https://github.com/openai/whisper) running locally, and chat with configurable LLM backends. Responses are spoken back via macOS text-to-speech.

## Prerequisites

**macOS** is required for TTS (`say`). Whisper also needs **Python 3.8+** and **ffmpeg**.

```bash
# macOS
brew install ffmpeg
pip install openai-whisper
```

Verify Whisper:

```bash
whisper --help
```

Optional, depending on which models you configure:

- **Ollama** — local models (`ollama pull llama3.1`)
- **Claude Code CLI** — install and authenticate the `claude` CLI
- **Anthropic API** — an API key referenced from `.env`

## Getting started

```bash
cp models.yml.example models.yml
cp .env.example .env
npm install
npm run dev
```

`models.yml` is gitignored — copy the example and edit your local copy. Add `ANTHROPIC_API_KEY` to `.env` only if you use an Anthropic API profile.

Open [http://localhost:3000](http://localhost:3000), pick a model when creating a session, then speak or type. The selected session's model is shown in the header.

## Configuration

### Runtime (`.env`)

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Server port |
| `WHISPER_MODEL` | `base` | Whisper model size (`tiny`, `base`, `small`, `medium`, `large`) |
| `TTS_VOICE` | `Fiona (Enhanced)` | macOS `say` voice |
| `ANTHROPIC_API_KEY` | — | Used by Anthropic profiles in `models.yml` via `${ANTHROPIC_API_KEY}` |
| `FLOOT_CONFIG` | `./models.yml` | Optional path to a models config file |

### Models (`models.yml`)

LLM backends are defined in `models.yml`. Each session picks a model at creation and keeps it for its lifetime.

The **first model listed** in `models.yml` is the default in the new-session picker.

```yaml
system_prompt: |
  You are a helpful voice assistant named "Floot"...

models:
  llama-local:
    label: Llama 3.1 (local)
    provider: ollama
    model: llama3.1
    host: http://localhost:11434
    options:
      num_ctx: 32768

  claude-code:
    label: Claude Sonnet (CLI)
    provider: claude-cli
    model: claude-sonnet-4-6
    binary: claude
    max_turns: 10
    permission_mode: bypassPermissions

  claude-sonnet:
    label: Claude Sonnet
    provider: anthropic
    model: claude-sonnet-4-6
    host: https://api.anthropic.com
    auth_token: ${ANTHROPIC_API_KEY}
    max_tokens: 64000
```

See [`models.yml.example`](models.yml.example) for the full template.

### Providers

| Provider | Description |
|---|---|
| `anthropic` | Claude via API; Floot runs `eval_js` / `run_shell` tools |
| `ollama` | Local models via Ollama `/api/chat` streaming; tools are always enabled |
| `claude-cli` | Claude Code CLI (`claude -p --output-format stream-json`); uses your logged-in CLI account, not `ANTHROPIC_API_KEY` |

Secrets in YAML use `${ENV_VAR}` syntax and are resolved from `.env` at startup.

**Ollama note:** Floot always sends `eval_js` and `run_shell` tools to Ollama. Smaller models like `llama3.1` tend to call tools aggressively — reorder models, switch to a more selective model (e.g. `qwen2.5`), or adjust the system prompt if you want mostly conversational replies.

**Claude CLI note:** Floot strips `ANTHROPIC_API_KEY` from the subprocess environment so the CLI uses its authenticated account rather than your API key.

## Example

```bash
WHISPER_MODEL=small PORT=4000 npm run dev
```

Larger Whisper models are more accurate but slower and require more RAM/VRAM.

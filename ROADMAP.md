# Roadmap

Improvements identified but not yet implemented. Ordered roughly by impact.

## Safety & sandboxing

### Lock down `eval_js` (`src/server.ts:executeTool`)
The VM context exposes `process`, `require`, `__dirname`, and the real `Buffer`/timers. A model can read `.env`, write anywhere, or call `process.exit()`. Move execution into a worker thread or subprocess with a scoped `require`, an `fs` allowlist, and no `process` access.

### Policy layer for `run_shell`
Commands run with no allowlist/denylist and no confirmation hook for destructive ops (`rm -rf`, `git push --force`, `git reset --hard`). Add a policy check before `spawn`.

### Sweep stale shell logs
Truncated runs leave files under `os.tmpdir()/floot-shell-logs/` indefinitely. Add a startup sweep and/or a TTL.

## Interactivity

### Cancellation
No way to abort an in-flight turn. Add a `message/cancel` WS command that aborts the LLM stream and kills any running tool subprocesses.

### Parallel tool calls
`runAssistantTurn` (`src/server.ts`) executes tool_use blocks sequentially. The Anthropic API can emit multiple tool calls in one turn — run them concurrently.

## Tool surface

Two tools (`eval_js`, `run_shell`) is thin. Add:

- `read_file`, `write_file`, `edit_file` — avoid shelling out to `cat`/`sed`
- `glob`, `grep` — precise lookup without spawning shell pipelines
- `web_fetch`, `web_search` — grounding

Also: stream long tool output back to the UI incrementally rather than as a single final blob.

## Reliability

### Session persistence
`SessionStore` is in-memory only — server restart loses everything. Persist to SQLite or JSON on disk.

### Retry on transient errors
Anthropic/Ollama 429s and 5xxs surface as hard failures. Add exponential backoff in each provider.

### Token & cost accounting
Anthropic streams `message_delta.usage`. Surface per-session totals in the UI.

## Dev ergonomics

### Structured logging
Replace `console.log` with pino. Useful once tool calls multiply and we want to grep traces.

### Dry-run model
A provider that echoes the prompt back without calling an LLM, for testing UI changes without burning tokens.

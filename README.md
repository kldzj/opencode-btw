# opencode-btw

Hint injection plugin for [OpenCode](https://opencode.ai) — nudge the model mid-task without interrupting its flow.

When the model is stuck in a loop or heading in the wrong direction, `/btw` lets you inject a hint into its context without sending a new message. The hint is picked up on the next LLM call, including during tool loops.

## Install

Add to your `opencode.json`:

```json
{
  "plugin": ["opencode-btw@latest"]
}
```

Restart OpenCode after adding the plugin.

## Usage

```
/btw use the Edit tool instead of sed       # transient hint (auto-clears)
/btw pin always use pnpm, not npm           # persistent hint (manual clear)
/btw clear                                  # remove the current hint
/btw                                        # show current hint + status
```

A confirmation message appears in the chat after each command. The model does not see this confirmation — only the hint itself (via the system prompt).

### Transient vs. pinned hints

- **`/btw <hint>`** — auto-clears after the model finishes its current turn (including all tool calls). Use for one-off corrections and nudges.
- **`/btw pin <hint>`** — persists until you run `/btw clear`. Use for session-wide preferences like "always use pnpm" or "focus on the auth module".

## How it works

1. `/btw <hint>` saves the hint to a file on disk and cancels the command before an LLM call is made
2. On every subsequent LLM call, the `experimental.chat.system.transform` hook reads the hint and appends it to the system prompt
3. When the model's turn finishes (`session.idle` event), transient hints are automatically removed
4. `/btw clear` removes any hint (transient or pinned)

Hints are **session-scoped** (each session has its own) and **project-scoped** (stored under a hash of the project directory). All data lives in `~/.cache/opencode/btw/`. Hint files are cleaned up automatically when sessions are deleted.

## Use cases

- **Error loops**: the model keeps making the same mistake — `/btw you're using the wrong API, check the docs for v2`
- **Tool preference**: `/btw pin use Edit instead of sed, use Grep instead of grep`
- **Scope nudge**: `/btw focus only on the auth module, don't touch other files`
- **Strategy shift**: `/btw try a completely different approach, the current one won't work`
- **Direct questions**: `/btw what file are you currently editing?`

## Development

```bash
bun test        # run test suite (51 tests)
```

## License

MIT

---

This is a community plugin and is not affiliated with or endorsed by the OpenCode project.

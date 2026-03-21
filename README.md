# opencode-btw

Hint injection plugin for [OpenCode](https://opencode.ai) — nudge the model mid-task without interrupting its flow.

When the model is stuck in a loop or heading in the wrong direction, `/btw` lets you inject a hint into its context without sending a new message. The hint persists in the system prompt until you clear it and is picked up on the next LLM call, including during tool loops.

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
/btw use the Edit tool instead of sed
/btw focus on error handling, you keep missing edge cases
/btw clear
/btw                              # show current hint
```

A confirmation message appears in the chat after each command. The model does not see this confirmation — only the hint itself (via the system prompt).

## How it works

1. `/btw <hint>` saves the hint to a file on disk and cancels the command before an LLM call is made
2. On every subsequent LLM call, the `experimental.chat.system.transform` hook reads the hint and appends it to the system prompt
3. `/btw clear` removes the hint file

Hints are **session-scoped** (each session has its own) and **project-scoped** (stored under a hash of the project directory). All data lives in `~/.cache/opencode/btw/`.

## Use cases

- **Error loops**: the model keeps making the same mistake — `/btw you're using the wrong API, check the docs for v2`
- **Tool preference**: `/btw use Edit instead of sed, use Grep instead of grep`
- **Scope nudge**: `/btw focus only on the auth module, don't touch other files`
- **Strategy shift**: `/btw try a completely different approach, the current one won't work`
- **Direct questions**: `/btw what file are you currently editing?`

## License

MIT

---

This is a community plugin and is not affiliated with or endorsed by the OpenCode project.

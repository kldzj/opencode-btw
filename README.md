# opencode-btw

Hint injection plugin for [OpenCode](https://opencode.ai) — nudge the model mid-task without interrupting its flow.

When the model is stuck in a loop or heading in the wrong direction, `/btw` lets you inject a hint into its context without sending a new message. The hint is picked up on the next LLM call, including during tool loops.

## Install

Add to your `opencode.json`:

```json
{
  "plugin": ["opencode-btw"]
}
```

Restart OpenCode after adding the plugin.

## Usage

```
/btw use the Edit tool instead of sed       # add transient hint (auto-clears)
/btw pin always use pnpm, not npm           # add persistent hint (manual clear)
/btw clear                                  # remove all hints
/btw clear last                             # remove the most recently added hint
/btw clear 2                                # remove hint #2
/btw                                        # show all active hints
/btw debug                                  # toggle debug mode (verbose logging)
/btw help                                   # show usage help
```

A confirmation toast appears after each command. The model does not see the confirmation — only the hints themselves.

### Stacking hints

Hints stack — each `/btw` adds to the list rather than replacing. This lets you layer corrections:

```
/btw pin always use TypeScript              # persistent base hint
/btw fix the bug in auth.ts first           # transient nudge on top
```

### Transient vs. pinned hints

- **`/btw <hint>`** — auto-clears after the model finishes its turn. Use for one-off corrections and nudges.
- **`/btw pin <hint>`** — persists until you run `/btw clear`. Use for session-wide preferences like "always use pnpm" or "focus on the auth module".

Transient hints auto-clear in two ways:
1. When the model uses the **question tool** (it has seen and processed the hints)
2. When the session goes **idle** (fallback, after the model's turn ends)

## How it works

1. `/btw <hint>` saves the hint to disk and cancels the command before an LLM call is made
2. On every subsequent LLM call, hints are prepended to the system prompt and appended to the last user message
3. When the model's turn ends, transient hints are automatically removed while pinned hints stay
4. `/btw clear` removes all hints, `/btw clear last` removes the most recent one, `/btw clear <N>` removes a specific hint by its number

Hints are **session-scoped** (each session has its own) and **project-scoped** (stored under a hash of the project directory). All data lives in `~/.cache/opencode/btw/`. Hint files are cleaned up automatically when sessions are deleted.

## Configuration

The plugin works out of the box with no configuration. All options below are optional — only add what you want to change.

### Config files

Configuration is loaded from two locations, merged in order (later overrides earlier):

| Layer      | Path                              | Purpose              |
| ---------- | --------------------------------- | -------------------- |
| **Global** | `~/.config/opencode/btw.jsonc`    | User-wide defaults   |
| **Project** | `.opencode/btw.jsonc` (walks up) | Per-project overrides |

The global config file is auto-created on first run with a `$schema` reference for IDE auto-completion. Files use JSONC format (JSON with comments and trailing commas).

You can also use `XDG_CONFIG_HOME` to customize the global config location: `$XDG_CONFIG_HOME/opencode/btw.jsonc`.

### Options

```jsonc
{
  // JSON Schema for IDE auto-completion
  "$schema": "https://raw.githubusercontent.com/kldzj/opencode-btw/main/btw.schema.json",

  // Default hint type: false = transient (auto-clears), true = pinned (persists)
  "defaultPinned": false,

  // Auto-clear behavior for transient hints
  "autoClear": {
    "onIdle": true,           // Clear when session goes idle
    "onQuestionTool": true    // Clear when the question tool fires
  },

  // Hint injection settings
  "injection": {
    "target": "both",                  // "both", "system", or "user"
    "systemPromptPosition": "prepend", // "prepend" or "append"
    "systemInstructions": null,        // Custom framing text (null = built-in default)
    "userMessagePrefix": "BTW, "       // Prefix for single-hint user messages
  },

  // Enable debug mode (verbose toast logging)
  "debug": false,

  // Default toast notification duration in milliseconds
  "toastDuration": 3000
}
```

### Examples

**Pinned hints by default** — skip typing `pin` every time:

```jsonc
{ "defaultPinned": true }
```

**System prompt only** — don't modify user messages:

```jsonc
{ "injection": { "target": "system" } }
```

**Custom framing** — change how hints are presented to the model:

```jsonc
{
  "injection": {
    "systemInstructions": "The user has set the following preferences. Follow them strictly.",
    "userMessagePrefix": "Note: "
  }
}
```

**Disable auto-clear on idle** — only clear when the question tool fires:

```jsonc
{ "autoClear": { "onIdle": false } }
```

## Use cases

- **Error loops**: the model keeps making the same mistake — `/btw you're using the wrong API, check the docs for v2`
- **Tool preference**: `/btw pin use Edit instead of sed, use Grep instead of grep`
- **Scope nudge**: `/btw focus only on the auth module, don't touch other files`
- **Strategy shift**: `/btw try a completely different approach, the current one won't work`
- **Direct questions**: `/btw what file are you currently editing?`

## Known issues

- **Web app error toast**: On the web app, `/btw` commands show a brief "command failed" error toast. This is cosmetic — the hint is saved and injected correctly. However, this also means `/btw` (status) can't display active hints on the web app — use the TUI for that. See [anomalyco/opencode#9306](https://github.com/anomalyco/opencode/issues/9306) for upstream tracking.

## Development

```bash
bun test        # run test suite
```

## License

MIT

---

This is a community plugin and is not affiliated with or endorsed by the OpenCode project.

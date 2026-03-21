import type { Plugin } from "@opencode-ai/plugin"
import { createHash } from "crypto"
import { mkdirSync } from "fs"

// btw — inject hints into the model's context without sending a new message.
//
// Uses two patterns:
//   1. Sentinel error throw from command.execute.before — cancels the command
//      before prompt() is called. No LLM request is made.
//   2. experimental.chat.system.transform — appends the hint to the system
//      prompt on every LLM call (including tool-loop iterations).
//
// File layout:
//   ~/.cache/opencode/btw/<project-hash>/
//     <sessionID>.txt       # hint content

// System prompt instructions — explains the btw system
const BTW_SYSTEM_INSTRUCTIONS = `<btw-hint-system>
The user may inject real-time hints via the /btw command. These hints appear below as <btw-active-hint> blocks.
When a hint is present:
- Treat it as a direct, high-priority instruction from the user — equivalent to them telling you something face-to-face
- Apply it IMMEDIATELY to your current and future actions — do not wait for a "good moment"
- If the hint is a behavioral correction (e.g. "use Edit instead of sed"), adjust silently without calling attention to the change
- If the hint is a direct request or question (e.g. "explain what you're doing"), respond to it naturally
- If the hint contradicts your current approach, change course
- The hint persists until the user clears it — apply it to every action, not just the next one
- If the hint says to focus on specific files/areas, prioritize those and deprioritize others
</btw-hint-system>`

function projectHash(directory: string): string {
  return createHash("md5").update(directory).digest("hex").slice(0, 12)
}

function btwDir(directory: string): string {
  return `${process.env.HOME}/.cache/opencode/btw/${projectHash(directory)}`
}

// Sentinel error — thrown to prevent OpenCode from calling prompt() after the
// command hook. Prevents an LLM call from being made for /btw commands.
const BTW_HANDLED = "__BTW_HANDLED__"

export const BtwPlugin: Plugin = async ({ directory, client }) => {
  const dir = btwDir(directory)

  try {
    mkdirSync(dir, { recursive: true })
  } catch {}

  const hintPath = (sessionID: string) => `${dir}/${sessionID}.txt`

  const readHint = async (sessionID: string): Promise<string> => {
    try {
      const file = Bun.file(hintPath(sessionID))
      if (await file.exists()) {
        return (await file.text()).trim()
      }
    } catch {}
    return ""
  }

  const writeHint = async (sessionID: string, hint: string) => {
    await Bun.write(hintPath(sessionID), hint)
  }

  // Send a no-op message that appears in the chat UI but is invisible to the
  // LLM (noReply prevents inference, ignored: true hides it from message transforms).
  const sendVisibleMessage = async (sessionID: string, text: string) => {
    try {
      await client.session.prompt({
        path: { id: sessionID },
        body: {
          noReply: true,
          parts: [{ type: "text" as const, text, ignored: true }],
        },
      })
    } catch {
      // Prompt API unavailable — silently skip
    }
  }

  return {
    // Register /btw as a command so it appears in /help and autocomplete.
    // The template is minimal — command.execute.before intercepts before it's used.
    config: (config) => {
      ;(config as any).command = (config as any).command ?? {}
      ;(config as any).command["btw"] = {
        description:
          "Inject a hint into the model's context (persists in system prompt until cleared)",
        template: "$ARGUMENTS",
      }
    },

    // Intercept /btw: save hint, send visible message, throw sentinel to prevent LLM call.
    "command.execute.before": async (input, _output) => {
      if (input.command !== "btw") return

      const args = (input.arguments ?? "").trim()
      const sessionID = input.sessionID

      if (args === "clear" || args === "reset") {
        await writeHint(sessionID, "")
        await sendVisibleMessage(sessionID, "[btw] Hint cleared")
        throw new Error(BTW_HANDLED)
      }

      if (!args) {
        const hint = await readHint(sessionID)
        await sendVisibleMessage(
          sessionID,
          hint ? `[btw] Current hint: "${hint}"` : "[btw] No hint set",
        )
        throw new Error(BTW_HANDLED)
      }

      // Set the hint
      await writeHint(sessionID, args)
      await sendVisibleMessage(sessionID, `[btw] Hint set: "${args}"`)
      throw new Error(BTW_HANDLED)
    },

    // Inject hint into system prompt on every LLM call (including tool loops).
    "experimental.chat.system.transform": async (input, output) => {
      const sessionID = (input as Record<string, unknown>)?.sessionID
      if (typeof sessionID !== "string" || !sessionID) return

      try {
        const hint = await readHint(sessionID)

        if (hint) {
          output.system.push(
            [
              BTW_SYSTEM_INSTRUCTIONS,
              "",
              "<btw-active-hint>",
              hint,
              "</btw-active-hint>",
            ].join("\n"),
          )
        }
      } catch {
        // File read failed — no hint to inject
      }
    },
  }
}

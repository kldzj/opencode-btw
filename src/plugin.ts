import type { Plugin } from "@opencode-ai/plugin"

import {
  type HintData,
  BTW_HANDLED,
  btwDir,
  buildSystemBlock,
  clearHint,
  ensureDir,
  hintPath,
  parseCommand,
  readHint,
  writeHint,
} from "./core"

// btw — inject hints into the model's context without sending a new message.
//
// Uses three hooks:
//   1. command.execute.before — intercepts /btw, saves hint, throws sentinel
//      to cancel the LLM call entirely.
//   2. experimental.chat.system.transform — appends hint to the system prompt
//      on every LLM call (including tool-loop iterations).
//   3. event — listens for session.idle to auto-clear transient hints, and
//      session.deleted to clean up hint files.
//
// File layout:
//   ~/.cache/opencode/btw/<project-hash>/
//     <sessionID>.json       # { text, pinned }

export const BtwPlugin: Plugin = async ({ directory, client }) => {
  const dir = btwDir(directory)
  ensureDir(dir)

  const hint = (sessionID: string) => hintPath(dir, sessionID)

  const sendVisibleMessage = async (sessionID: string, text: string) => {
    try {
      await client.session.prompt({
        path: { id: sessionID },
        body: {
          noReply: true,
          parts: [{ type: "text" as const, text, ignored: true }],
        },
      })
    } catch {}
  }

  return {
    config: (config) => {
      ;(config as any).command = (config as any).command ?? {}
      ;(config as any).command["btw"] = {
        description:
          "Inject a hint into the model's context (auto-clears after one turn, use 'pin' to persist)",
        template: "$ARGUMENTS",
      }
    },

    event: async ({ event }) => {
      // Auto-clear transient hints when the model finishes a complete turn
      if (event.type === "session.idle") {
        const sessionID = (event as any).properties?.sessionID
        if (typeof sessionID !== "string") return

        const data = await readHint(hint(sessionID))
        if (data && !data.pinned) {
          await clearHint(hint(sessionID))
          await sendVisibleMessage(sessionID, "[btw] Hint auto-cleared")
        }
      }

      // Clean up hint files when sessions are deleted
      if (event.type === "session.deleted") {
        const sessionID = (event as any).properties?.sessionID
        if (typeof sessionID === "string") {
          await clearHint(hint(sessionID))
        }
      }
    },

    "command.execute.before": async (input, _output) => {
      if (input.command !== "btw") return

      const sessionID = input.sessionID
      const parsed = parseCommand(input.arguments ?? "")

      switch (parsed.action) {
        case "clear":
          await clearHint(hint(sessionID))
          await sendVisibleMessage(sessionID, "[btw] Hint cleared")
          throw new Error(BTW_HANDLED)

        case "status": {
          const data = await readHint(hint(sessionID))
          if (data) {
            const label = data.pinned ? "pinned" : "transient"
            await sendVisibleMessage(
              sessionID,
              `[btw] Current hint (${label}): "${data.text}"`,
            )
          } else {
            await sendVisibleMessage(sessionID, "[btw] No hint set")
          }
          throw new Error(BTW_HANDLED)
        }

        case "error":
          await sendVisibleMessage(sessionID, `[btw] ${parsed.message}`)
          throw new Error(BTW_HANDLED)

        case "set":
          await writeHint(hint(sessionID), {
            text: parsed.text,
            pinned: parsed.pinned,
          })
          const verb = parsed.pinned ? "Pinned hint" : "Hint"
          await sendVisibleMessage(
            sessionID,
            `[btw] ${verb} set: "${parsed.text}"`,
          )
          throw new Error(BTW_HANDLED)
      }
    },

    "experimental.chat.system.transform": async (input, output) => {
      const sessionID = (input as Record<string, unknown>)?.sessionID
      if (typeof sessionID !== "string" || !sessionID) return

      try {
        const data = await readHint(hint(sessionID))
        if (data) {
          output.system.push(buildSystemBlock(data))
        }
      } catch {}
    },
  }
}

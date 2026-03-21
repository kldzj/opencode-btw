import type { Plugin } from "@opencode-ai/plugin"

import {
  BTW_HANDLED,
  addHint,
  buildSystemBlock,
  btwDir,
  clearHints,
  ensureDir,
  hintPath,
  parseCommand,
  readHints,
  removeLast,
  removeTransient,
} from "./core"

// btw — inject hints into the model's context without sending a new message.
//
// Uses three hooks:
//   1. command.execute.before — intercepts /btw, saves hint, throws sentinel
//      to cancel the LLM call entirely.
//   2. experimental.chat.system.transform — appends hints to the system prompt
//      on every LLM call (including tool-loop iterations).
//   3. event — listens for session.idle to auto-clear transient hints, and
//      session.deleted to clean up hint files.
//
// File layout:
//   ~/.cache/opencode/btw/<project-hash>/
//     <sessionID>.json       # { hints: [{ text, pinned }] }

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
          "Inject a hint into the model's context (stacks; transient by default, use 'pin' to persist)",
        template: "$ARGUMENTS",
      }
    },

    event: async ({ event }) => {
      // Auto-clear transient hints when the model finishes a complete turn
      if (event.type === "session.idle") {
        const sessionID = (event as any).properties?.sessionID
        if (typeof sessionID !== "string") return

        const removed = await removeTransient(hint(sessionID))
        if (removed) {
          await sendVisibleMessage(sessionID, "[btw] Transient hints auto-cleared")
        }
      }

      // Clean up hint files when sessions are deleted
      if (event.type === "session.deleted") {
        const sessionID = (event as any).properties?.sessionID
        if (typeof sessionID === "string") {
          await clearHints(hint(sessionID))
        }
      }
    },

    "command.execute.before": async (input, _output) => {
      if (input.command !== "btw") return

      const sessionID = input.sessionID
      const parsed = parseCommand(input.arguments ?? "")

      switch (parsed.action) {
        case "clear":
          if (parsed.which === "last") {
            const removed = await removeLast(hint(sessionID))
            if (removed) {
              await sendVisibleMessage(
                sessionID,
                `[btw] Removed last hint: "${removed.text}"`,
              )
            } else {
              await sendVisibleMessage(sessionID, "[btw] No hints to remove")
            }
          } else {
            await clearHints(hint(sessionID))
            await sendVisibleMessage(sessionID, "[btw] All hints cleared")
          }
          throw new Error(BTW_HANDLED)

        case "status": {
          const hints = await readHints(hint(sessionID))
          if (hints.length === 0) {
            await sendVisibleMessage(sessionID, "[btw] No hints set")
          } else {
            const lines = hints.map((h, i) => {
              const label = h.pinned ? "pinned" : "transient"
              return `  ${i + 1}. [${label}] "${h.text}"`
            })
            await sendVisibleMessage(
              sessionID,
              `[btw] Active hints:\n${lines.join("\n")}`,
            )
          }
          throw new Error(BTW_HANDLED)
        }

        case "error":
          await sendVisibleMessage(sessionID, `[btw] ${parsed.message}`)
          throw new Error(BTW_HANDLED)

        case "set":
          await addHint(hint(sessionID), {
            text: parsed.text,
            pinned: parsed.pinned,
          })
          const verb = parsed.pinned ? "Pinned hint" : "Hint"
          await sendVisibleMessage(
            sessionID,
            `[btw] ${verb} added: "${parsed.text}"`,
          )
          throw new Error(BTW_HANDLED)
      }
    },

    "experimental.chat.system.transform": async (input, output) => {
      const sessionID = (input as Record<string, unknown>)?.sessionID
      if (typeof sessionID !== "string" || !sessionID) return

      try {
        const hints = await readHints(hint(sessionID))
        if (hints.length > 0) {
          output.system.push(buildSystemBlock(hints))
        }
      } catch {}
    },
  }
}

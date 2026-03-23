import type { Plugin } from "@opencode-ai/plugin"

import {
  BTW_HELP,
  addHint,
  buildSystemBlock,
  buildUserHint,
  btwDir,
  cancelCommand,
  clearHints,
  ensureDir,
  hintPath,
  isDebugEnabled,
  parseCommand,
  readHints,
  removeAt,
  removeLast,
  removeTransient,
  toggleDebug,
} from "./core"
import { type BtwConfig, getConfig } from "./config"

// btw — inject hints into the model's context without sending a new message.
//
// Hint files are stored at ~/.cache/opencode/btw/<project-hash>/<sessionID>.json
// Debug mode marker: ~/.cache/opencode/btw/.debug

export const BtwPlugin: Plugin = async ({ directory, client }) => {
  const config = getConfig({ directory, client })

  const dir = btwDir(directory)
  ensureDir(dir)

  const hint = (sessionID: string) => hintPath(dir, sessionID)

  const notify = async (msg: string, duration?: number) => {
    try {
      await client.tui.showToast({
        body: {
          message: msg,
          variant: "info" as const,
          duration: duration ?? config.toastDuration,
        },
      })
    } catch {}
  }

  const debugLog = async (msg: string) => {
    if (!isDebugEnabled(config)) return
    await notify(`[btw/debug] ${msg}`, 2000)
  }

  return {
    config: (cfg) => {
      ;(cfg as any).command = (cfg as any).command ?? {}
      ;(cfg as any).command["btw"] = {
        description:
          "Inject a hint into the model's context (stacks; transient by default, use 'pin' to persist)",
        template: "$ARGUMENTS",
      }
    },

    "tool.execute.after": async (input, _output) => {
      // When the model uses the "question" tool, transient hints have served
      // their purpose — the model saw them, processed them, and asked the user
      // a question. Clear transient hints so the next LLM call (processing the
      // user's answer) doesn't carry stale one-shot nudges.
      if (!config.autoClear.onQuestionTool) return
      if (input.tool !== "question") return
      const sessionID = (input as any).sessionID
      if (typeof sessionID !== "string") return

      const removed = await removeTransient(hint(sessionID))
      if (removed) {
        await debugLog("question-clear: transient hints removed (question tool fired)")
        await notify("[btw] Transient hints auto-cleared (question asked)")
      }
    },

    event: async ({ event }) => {
      // Fallback: auto-clear transient hints when the model finishes
      if (event.type === "session.idle") {
        if (!config.autoClear.onIdle) return
        const sessionID = (event as any).properties?.sessionID
        if (typeof sessionID !== "string") return

        const removed = await removeTransient(hint(sessionID))
        if (removed) {
          await debugLog("idle-clear: transient hints removed")
          await notify("[btw] Transient hints auto-cleared")
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
      const parsed = parseCommand(input.arguments ?? "", config)

      switch (parsed.action) {
        case "clear":
          if (parsed.which === "last") {
            const removed = await removeLast(hint(sessionID))
            if (removed) {
              await notify(`[btw] Removed last hint: "${removed.text}"`)
            } else {
              await notify("[btw] No hints to remove")
            }
          } else if (typeof parsed.which === "number") {
            const removed = await removeAt(hint(sessionID), parsed.which - 1)
            if (removed) {
              await notify(`[btw] Removed hint #${parsed.which}: "${removed.text}"`)
            } else {
              await notify(`[btw] No hint at position #${parsed.which}`)
            }
          } else {
            await clearHints(hint(sessionID))
            await notify("[btw] All hints cleared")
          }
          await debugLog("clear: hints cleared")
          return cancelCommand()

        case "status": {
          const hints = await readHints(hint(sessionID))
          if (hints.length === 0) {
            await notify("[btw] No hints set")
          } else {
            const lines = hints.map((h, i) => {
              const label = h.pinned ? "pinned" : "transient"
              return `  ${i + 1}. [${label}] "${h.text}"`
            })
            await notify(`[btw] Active hints:\n${lines.join("\n")}`, 5000)
          }
          return cancelCommand()
        }

        case "error":
          await notify(`[btw] ${parsed.message}`)
          return cancelCommand()

        case "help":
          await notify(BTW_HELP, 8000)
          return cancelCommand()

        case "debug": {
          const enabled = await toggleDebug()
          await notify(`[btw] Debug mode ${enabled ? "enabled" : "disabled"}`)
          return cancelCommand()
        }

        case "set":
          await addHint(hint(sessionID), {
            text: parsed.text,
            pinned: parsed.pinned,
          })
          const verb = parsed.pinned ? "Pinned hint" : "Hint"
          await notify(`[btw] ${verb} added: "${parsed.text}"`)
          await debugLog(`set: "${parsed.text}" (${parsed.pinned ? "pinned" : "transient"})`)
          return cancelCommand()
      }
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      // Skip user message injection if target is "system" only
      if (config.injection.target === "system") return

      // Find the last user message to append hint text
      const messages = (output as Record<string, unknown>)?.messages
      if (!Array.isArray(messages) || messages.length === 0) return

      const lastUser = [...messages].reverse().find(
        (m: any) => m?.info?.role === "user",
      ) as { info: Record<string, unknown>; parts: any[] } | undefined
      if (!lastUser) return

      const sessionID = lastUser.info?.sessionID
      if (typeof sessionID !== "string" || !sessionID) return

      try {
        const hints = await readHints(hint(sessionID))
        if (hints.length === 0) return

        const hintText = buildUserHint(hints, config)
        lastUser.parts.push({
          id: `btw-${Date.now()}`,
          sessionID,
          messageID: lastUser.info.id ?? "",
          type: "text",
          text: hintText,
          synthetic: true,
        })
        await debugLog(`messages: appended preferences to last user message`)
      } catch {}
    },

    "experimental.chat.system.transform": async (input, output) => {
      // Skip system prompt injection if target is "user" only
      if (config.injection.target === "user") return

      const sessionID = (input as Record<string, unknown>)?.sessionID
      if (typeof sessionID !== "string" || !sessionID) return

      try {
        const hints = await readHints(hint(sessionID))
        if (hints.length > 0) {
          const block = buildSystemBlock(hints, config)
          if (config.injection.systemPromptPosition === "append") {
            output.system.push(block)
          } else {
            output.system.unshift(block)
          }
          await debugLog(`transform: applied ${hints.length} preference(s)`)
        }
      } catch {}
    },
  }
}

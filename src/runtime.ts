import { getConfig } from "./config"
import {
  BTW_HELP,
  addHint,
  btwDir,
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

export type Notify = (
  message: string,
  duration: number,
  sessionID?: string,
) => Promise<void>

// Version-independent command and hint lifecycle. Host adapters own notifications
// and, on V1 only, cancellation of the slash command's automatic model request.
export function createRuntime(directory: string, notify: Notify) {
  const config = getConfig({
    directory,
    warn: (message) => {
      void notify(message, 7000)
    },
  })
  const dir = btwDir(directory)
  ensureDir(dir)
  const hint = (sessionID: string) => hintPath(dir, sessionID)
  const show = (
    sessionID: string,
    message: string,
    duration = config.toastDuration,
  ) => notify(message, duration, sessionID)
  const debug = async (sessionID: string, message: string) => {
    if (isDebugEnabled(config))
      await show(sessionID, `[btw/debug] ${message}`, 2000)
  }

  return {
    config,
    hints: (sessionID: string) => readHints(hint(sessionID)),
    debug,
    async command(sessionID: string, args: string) {
      const parsed = parseCommand(args, config)
      switch (parsed.action) {
        case "clear":
          if (parsed.which === "last") {
            const removed = await removeLast(hint(sessionID))
            await show(
              sessionID,
              removed
                ? `[btw] Removed last hint: "${removed.text}"`
                : "[btw] No hints to remove",
            )
          } else if (typeof parsed.which === "number") {
            const removed = await removeAt(hint(sessionID), parsed.which - 1)
            await show(
              sessionID,
              removed
                ? `[btw] Removed hint #${parsed.which}: "${removed.text}"`
                : `[btw] No hint at position #${parsed.which}`,
            )
          } else {
            await clearHints(hint(sessionID))
            await show(sessionID, "[btw] All hints cleared")
          }
          await debug(sessionID, "clear: hints cleared")
          return
        case "status": {
          const hints = await readHints(hint(sessionID))
          if (!hints.length) await show(sessionID, "[btw] No hints set")
          else
            await show(
              sessionID,
              `[btw] Active hints:\n${hints.map((h, i) => `  ${i + 1}. [${h.pinned ? "pinned" : "transient"}] "${h.text}"`).join("\n")}`,
              5000,
            )
          return
        }
        case "error":
          await show(sessionID, `[btw] ${parsed.message}`)
          return
        case "help":
          await show(sessionID, BTW_HELP, 8000)
          return
        case "debug": {
          const enabled = await toggleDebug()
          await show(
            sessionID,
            `[btw] Debug mode ${enabled ? "enabled" : "disabled"}`,
          )
          return
        }
        case "set":
          await addHint(hint(sessionID), {
            text: parsed.text,
            pinned: parsed.pinned,
          })
          await show(
            sessionID,
            `[btw] ${parsed.pinned ? "Pinned hint" : "Hint"} added: "${parsed.text}"`,
          )
          await debug(
            sessionID,
            `set: "${parsed.text}" (${parsed.pinned ? "pinned" : "transient"})`,
          )
      }
    },
    async question(sessionID: string) {
      if (!config.autoClear.onQuestionTool) return
      if (await removeTransient(hint(sessionID))) {
        await debug(
          sessionID,
          "question-clear: transient hints removed (question tool fired)",
        )
        await show(
          sessionID,
          "[btw] Transient hints auto-cleared (question asked)",
        )
      }
    },
    async idle(sessionID: string) {
      if (!config.autoClear.onIdle) return
      if (await removeTransient(hint(sessionID))) {
        await debug(sessionID, "idle-clear: transient hints removed")
        await show(sessionID, "[btw] Transient hints auto-cleared")
      }
    },
    deleted: (sessionID: string) => clearHints(hint(sessionID)),
  }
}

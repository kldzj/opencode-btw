import type { Plugin } from "@opencode/plugin"
import { buildSystemBlock, buildUserHint } from "./core"
import { BtwRpc } from "./rpc"
import { createRuntime } from "./runtime"

export async function setup(ctx: Plugin.Context) {
  const notifications = await ctx.rpc.register(BtwRpc, {})
  const runtime = createRuntime(
    ctx.location.directory,
    async (message, duration, sessionID) => {
      await notifications.events.emit("notification", {
        message,
        duration,
        ...(sessionID ? { sessionID } : {}),
      })
    },
  )
  const { config } = runtime

  await ctx.command.transform((editor) => {
    editor.add({
      name: "btw",
      description:
        "Inject a hint without interrupting the model (use 'pin' to persist)",
      execute: ({ sessionID, prompt }) =>
        runtime.command(sessionID, prompt.text),
    })
  })

  await ctx.session.hook("context", async (event) => {
    const hints = await runtime.hints(event.sessionID)
    if (!hints.length) return
    if (config.injection.target !== "user") {
      const part = {
        type: "text" as const,
        text: buildSystemBlock(hints, config),
      }
      if (config.injection.systemPromptPosition === "append")
        event.system.push(part)
      else event.system.unshift(part)
    }
    if (config.injection.target !== "system") {
      const index = event.messages.findLastIndex(
        (message) => message.role === "user",
      )
      if (index !== -1) {
        const message = event.messages[index]
        // Replace the draft message rather than mutating readonly content shared
        // with history. All attachments and metadata remain intact.
        event.messages[index] = {
          ...message,
          content: [
            ...message.content,
            { type: "text", text: buildUserHint(hints, config) },
          ],
        }
      }
    }
    await runtime.debug(
      event.sessionID,
      `context: applied ${hints.length} preference(s)`,
    )
  })

  await ctx.tool.hook("execute.after", async (event) => {
    if (event.tool === "question" && event.status === "completed")
      await runtime.question(event.sessionID)
  })

  const controller = new AbortController()
  const events = (async () => {
    for await (const event of ctx.event.subscribe({
      signal: controller.signal,
    })) {
      // The shared server's event stream spans projects. A plugin instance must
      // only clear hints from its own location.
      if (event.location?.directory !== ctx.location.directory) continue
      if (event.type === "session.idle")
        await runtime.idle(event.data.sessionID)
      if (event.type === "session.deleted")
        await runtime.deleted(event.data.sessionID)
    }
  })().catch((error) => {
    if (!controller.signal.aborted)
      console.error("[btw] Event subscription failed", error)
  })

  return async () => {
    controller.abort()
    await events
  }
}

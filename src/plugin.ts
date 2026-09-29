import type { Plugin as V1Plugin } from "@opencode-ai/plugin"
import type { Plugin } from "@opencode/plugin"
import { buildSystemBlock, buildUserHint, cancelCommand } from "./core"
import { createRuntime } from "./runtime"

export const BtwPlugin: V1Plugin = async ({ directory, client }) => {
  const runtime = createRuntime(directory, async (message, duration) => {
    try {
      await client.tui.showToast({
        body: { message, duration, variant: "info" },
      })
    } catch {}
  })
  const { config } = runtime

  return {
    config: async (cfg) => {
      cfg.command ??= {}
      cfg.command.btw = {
        description:
          "Inject a hint into the model's context (stacks; transient by default, use 'pin' to persist)",
        template: "$ARGUMENTS",
      }
    },
    "command.execute.before": async (input) => {
      if (input.command !== "btw") return
      await runtime.command(input.sessionID, input.arguments ?? "")
      return cancelCommand()
    },
    "tool.execute.after": async (input) => {
      if (input.tool === "question" && typeof input.sessionID === "string") {
        await runtime.question(input.sessionID)
      }
    },
    event: async ({ event }) => {
      if (event.type === "session.idle")
        await runtime.idle(event.properties.sessionID)
      if (event.type === "session.deleted") {
        // Current V1 sends info.id; older releases sent sessionID.
        const properties = event.properties as {
          info?: { id: string }
          sessionID?: string
        }
        const id = properties.info?.id ?? properties.sessionID
        if (id) await runtime.deleted(id)
      }
    },
    "experimental.chat.messages.transform": async (_input, output) => {
      if (config.injection.target === "system") return
      const lastUser = [...output.messages]
        .reverse()
        .find((message) => message.info.role === "user")
      if (!lastUser) return
      const sessionID = lastUser.info.sessionID
      const hints = await runtime.hints(sessionID)
      if (!hints.length) return
      lastUser.parts.push({
        id: `btw-${Date.now()}`,
        sessionID,
        messageID: lastUser.info.id,
        type: "text",
        text: buildUserHint(hints, config),
        synthetic: true,
      })
      await runtime.debug(
        sessionID,
        "messages: appended preferences to last user message",
      )
    },
    "experimental.chat.system.transform": async (input, output) => {
      if (config.injection.target === "user" || !input.sessionID) return
      const hints = await runtime.hints(input.sessionID)
      if (!hints.length) return
      const block = buildSystemBlock(hints, config)
      if (config.injection.systemPromptPosition === "append")
        output.system.push(block)
      else output.system.unshift(block)
      await runtime.debug(
        input.sessionID,
        `transform: applied ${hints.length} preference(s)`,
      )
    },
  }
}

export default {
  id: "opencode-btw",
  server: BtwPlugin,
  async setup(ctx) {
    const { setup } = await import("./v2")
    return setup(ctx)
  },
} satisfies Plugin.Plugin & { server: V1Plugin }

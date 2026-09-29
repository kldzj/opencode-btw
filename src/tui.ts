import type { Plugin } from "@opencode/plugin/tui"
import { BtwRpc } from "./rpc"

export default {
  id: "opencode-btw.tui",
  setup(context) {
    const btw = context.client.rpc(BtwRpc)
    context.keymap.layer(() => ({
      mode: "global",
      priority: 100,
      commands: [
        {
          // V2 already owns /btw for side conversations. Override that command's
          // ID so installing this plugin keeps /btw's hint-injection semantics.
          id: "session.aside",
          title: "Manage BTW hints",
          group: "BTW",
          palette: true,
          slash: { name: "btw", arguments: true },
          async run(input) {
            const route = context.ui.router.current()
            if (route.type !== "session") {
              context.ui.toast.show({
                message: "[btw] Open a session before adding hints",
                variant: "info",
              })
              return
            }
            try {
              await context.client.session.command({
                sessionID: route.sessionID,
                name: "btw",
                text: input ?? "",
              })
            } catch (error) {
              context.ui.toast.show({
                message: `[btw] ${error instanceof Error ? error.message : String(error)}`,
                variant: "error",
              })
            }
          },
        },
      ],
    }))
    return btw.events.on("notification", (event) => {
      const route = context.ui.router.current()
      if (typeof event.data.sessionID === "string") {
        if (
          route.type !== "session" ||
          route.sessionID !== event.data.sessionID
        )
          return
      } else {
        const location = context.location ?? context.data.location.default()
        if (event.location.directory !== location.directory) return
      }
      if (
        typeof event.data.message !== "string" ||
        typeof event.data.duration !== "number"
      )
        return
      context.ui.toast.show({
        message: event.data.message,
        duration: event.data.duration,
        variant: "info",
      })
    })
  },
} satisfies Plugin.Definition

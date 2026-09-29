import type { Rpc } from "@opencode/plugin/rpc"

// Portable JSON schemas keep both the server and CLI entrypoints lightweight.
export const BtwRpc = {
  id: "opencode-btw",
  methods: {},
  events: {
    notification: {
      schema: {
        type: "object",
        properties: {
          message: { type: "string" },
          duration: { type: "number" },
          sessionID: { type: "string" },
        },
        required: ["message", "duration"],
        additionalProperties: false,
      },
    },
  },
} as const satisfies Rpc.PortableDefinition

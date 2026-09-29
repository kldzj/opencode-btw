import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin, { BtwPlugin } from "./plugin"
import tui from "./tui"
import { btwDir, hintPath, readHints } from "./core"
import type { BtwConfig } from "./config"

let home: string
let directory: string
let originalHome: string | undefined
let originalConfigHome: string | undefined
let cleanup: (() => Promise<void>) | undefined

beforeEach(() => {
  originalHome = process.env.HOME
  originalConfigHome = process.env.XDG_CONFIG_HOME
  home = mkdtempSync(join(tmpdir(), "btw-v2-"))
  directory = join(home, "project")
  mkdirSync(directory)
  process.env.HOME = home
  process.env.XDG_CONFIG_HOME = join(home, ".config")
})

afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = originalConfigHome
  rmSync(home, { recursive: true, force: true })
})

async function harness(config: Partial<BtwConfig> = {}) {
  mkdirSync(join(home, ".config", "opencode"), { recursive: true })
  writeFileSync(
    join(home, ".config", "opencode", "btw.jsonc"),
    JSON.stringify(config),
  )
  const hooks: Record<string, (event: any) => Promise<void>> = {}
  const notifications: any[] = []
  const commands: any[] = []
  const pending: Array<{ event: any; done(): void }> = []
  let wake = () => {}
  let signal: AbortSignal
  let finished = false
  const context = {
    location: { directory },
    rpc: {
      register: async () => ({
        events: {
          emit: async (_name: string, data: any) => notifications.push(data),
        },
      }),
    },
    command: {
      transform: async (transform: any) =>
        transform({ add: (command: any) => commands.push(command) }),
    },
    session: {
      hook: async (name: string, hook: any) => {
        hooks[name] = hook
      },
      prompt: () => {
        throw new Error("BTW must not submit a model prompt")
      },
    },
    tool: {
      hook: async (name: string, hook: any) => {
        hooks[name] = hook
      },
    },
    event: {
      subscribe: async function* (options: { signal: AbortSignal }) {
        signal = options.signal
        const abort = () => wake()
        signal.addEventListener("abort", abort)
        try {
          while (!signal.aborted) {
            if (!pending.length)
              await new Promise<void>((resolve) => {
                wake = resolve
              })
            const item = pending.shift()
            if (item) {
              yield item.event
              item.done()
            }
          }
        } finally {
          finished = true
          signal.removeEventListener("abort", abort)
        }
      },
    },
  }
  cleanup = (await plugin.setup(context as never)) as () => Promise<void>
  return {
    hooks,
    notifications,
    commands,
    stopped: () => finished && signal.aborted,
    command: (args: string, sessionID = "ses_one") =>
      commands[0].execute({
        sessionID,
        prompt: { text: args },
        delivery: "steer",
      }),
    hints: (sessionID = "ses_one") =>
      readHints(hintPath(btwDir(directory), sessionID)),
    emit: (type: string, sessionID = "ses_one", location = directory) =>
      new Promise<void>((done) => {
        pending.push({
          event: {
            type,
            location: { directory: location },
            data: { sessionID },
          },
          done,
        })
        wake()
      }),
  }
}

function request(sessionID = "ses_one") {
  return {
    sessionID,
    system: [{ type: "text", text: "base" }],
    messages: [
      { role: "user", content: [{ type: "text", text: "first request" }] },
      { role: "assistant", content: [{ type: "text", text: "working" }] },
      {
        role: "user",
        metadata: { keep: true },
        content: Object.freeze([
          { type: "text", text: "current request" },
          { type: "media", media: { uri: "file:///image.png" } },
        ]),
      },
      { role: "tool", content: [{ type: "text", text: "result" }] },
    ],
  }
}

describe("OpenCode V2 adapter", () => {
  test("dual entrypoint retains the named V1 factory", () => {
    expect(plugin.id).toBe("opencode-btw")
    expect(plugin.server).toBe(BtwPlugin)
  })

  test("slash commands complete without throwing or submitting a model prompt", async () => {
    const h = await harness()
    expect(h.commands[0].name).toBe("btw")
    await h.command("pin use TypeScript")
    await h.command("add tests")
    await h.command("")
    expect(h.notifications.at(-1).message).toContain("[pinned]")
    expect(h.notifications.at(-1).sessionID).toBe("ses_one")
    expect(await h.hints()).toHaveLength(2)
    await h.command("clear 1")
    expect(await h.hints()).toEqual([{ text: "add tests", pinned: false }])
    await h.command("clear last")
    expect(await h.hints()).toEqual([])
    await h.command("help")
    expect(h.notifications.at(-1).message).toContain("/btw pin")
    await h.command("pin")
    expect(h.notifications.at(-1).message).toContain("Usage:")
    await h.command("debug")
    expect(h.notifications.at(-1).message).toContain("enabled")
    await h.command("debug")
    expect(h.notifications.at(-1).message).toContain("disabled")
    await h.command("again")
    await h.command("clear")
    expect(await h.hints()).toEqual([])
  })

  test("context injection preserves attachments and history and repeats during tool loops", async () => {
    const h = await harness()
    await h.command("be brief")
    for (let turn = 0; turn < 2; turn++) {
      const event = request()
      const original = event.messages[2]
      await h.hooks.context(event)
      expect(event.system[0].text).toContain("be brief")
      expect(event.messages[0].content).toHaveLength(1)
      expect(event.messages[2].content.at(-1)).toEqual({
        type: "text",
        text: "BTW, be brief",
      })
      expect(event.messages[2].content[1]).toBe(original.content[1])
      expect(event.messages[2].metadata).toEqual({ keep: true })
      expect(original.content).toHaveLength(2)
    }
    expect(await h.hints()).toHaveLength(1)
    expect(Object.keys(h.hooks).sort()).toEqual(["context", "execute.after"])
  })

  test.each(["system", "user", "both"] as const)(
    "honors the %s injection target and append position",
    async (target) => {
      const h = await harness({
        injection: {
          target,
          systemPromptPosition: "append",
          systemInstructions: "custom",
          userMessagePrefix: "Note: ",
        },
      })
      await h.command("focus")
      const event = request()
      await h.hooks.context(event)
      expect(event.system[0].text).toBe("base")
      expect(event.system).toHaveLength(target === "user" ? 1 : 2)
      expect(event.messages[2].content).toHaveLength(
        target === "system" ? 2 : 3,
      )
      if (target !== "system")
        expect(event.messages[2].content.at(-1).text).toBe("Note: focus")
    },
  )

  test("session isolation and empty message lists", async () => {
    const h = await harness()
    await h.command("only first")
    const other = request("ses_other")
    await h.hooks.context(other)
    expect(other.system).toHaveLength(1)
    await h.hooks.context({ sessionID: "ses_one", system: [], messages: [] })
  })

  test("completed questions clear transient hints; failures and other tools do not", async () => {
    const h = await harness()
    await h.command("pin keep")
    await h.command("temporary")
    await h.hooks["execute.after"]({
      tool: "question",
      status: "error",
      sessionID: "ses_one",
    })
    await h.hooks["execute.after"]({
      tool: "shell",
      status: "completed",
      sessionID: "ses_one",
    })
    expect(await h.hints()).toHaveLength(2)
    await h.hooks["execute.after"]({
      tool: "question",
      status: "completed",
      sessionID: "ses_one",
    })
    expect(await h.hints()).toEqual([{ text: "keep", pinned: true }])
  })

  test("V2 data envelopes clear on idle/delete and ignore other locations", async () => {
    const h = await harness()
    await h.command("pin keep")
    await h.command("temporary")
    await h.emit("session.idle", "ses_one", "/another/project")
    expect(await h.hints()).toHaveLength(2)
    await h.emit("session.idle")
    expect(await h.hints()).toEqual([{ text: "keep", pinned: true }])
    await h.emit("session.deleted")
    expect(await h.hints()).toEqual([])
    await cleanup!()
    expect(h.stopped()).toBe(true)
  })

  test("respects disabled auto-clear options and defaultPinned", async () => {
    const h = await harness({
      autoClear: { onIdle: false, onQuestionTool: false },
    })
    await h.command("keep transient")
    await h.emit("session.idle")
    await h.hooks["execute.after"]({
      tool: "question",
      status: "completed",
      sessionID: "ses_one",
    })
    expect(await h.hints()).toHaveLength(1)
  })

  test("defaultPinned applies to hints without pin", async () => {
    const h = await harness({ defaultPinned: true })
    await h.command("default persistent")
    await h.emit("session.idle")
    expect(await h.hints()).toEqual([
      { text: "default persistent", pinned: true },
    ])
  })
})

test("CLI overrides the native /btw command and scopes notifications with cleanup", async () => {
  let callback: (event: any) => void
  let stopped = false
  const toasts: any[] = []
  const calls: any[] = []
  let layer: any
  const dispose = tui.setup({
    client: {
      session: { command: async (input: any) => calls.push(input) },
      rpc: () => ({
        events: {
          on: (_name: string, handler: any) => {
            callback = handler
            return () => {
              stopped = true
            }
          },
        },
      }),
    },
    location: { directory },
    keymap: {
      layer: (factory: any) => {
        layer = factory()
      },
    },
    ui: {
      router: { current: () => ({ type: "session", sessionID: "ses_one" }) },
      toast: { show: (toast: any) => toasts.push(toast) },
    },
  } as never)
  const event = {
    location: { directory },
    data: { message: "saved", duration: 3000, sessionID: "ses_one" },
  }
  callback!(event)
  callback!({ ...event, data: { ...event.data, sessionID: "ses_other" } })
  callback!({
    location: { directory: "/other" },
    data: { message: "warning", duration: 7000 },
  })
  expect(toasts).toEqual([
    { message: "saved", duration: 3000, variant: "info" },
  ])
  expect(layer.priority).toBeGreaterThan(0)
  expect(layer.commands[0].id).toBe("session.aside")
  await layer.commands[0].run("pin concise")
  expect(calls).toEqual([
    { sessionID: "ses_one", name: "btw", text: "pin concise" },
  ])
  ;(dispose as () => void)()
  expect(stopped).toBe(true)
})

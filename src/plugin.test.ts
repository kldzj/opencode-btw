import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test"
import { mkdirSync, rmSync, existsSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

import { BTW_HANDLED, readHints, writeHints } from "./core"
import { BtwPlugin } from "./plugin"

// ─── Test Helpers ────────────────────────────────────────────────────

function createMockClient() {
  const promptCalls: any[] = []

  return {
    promptCalls,
    session: {
      prompt: mock(async (opts: any) => {
        promptCalls.push(opts)
        return {}
      }),
    },
    tui: {
      showToast: mock(async () => {}),
    },
  }
}

// ─── Plugin Factory ──────────────────────────────────────────────────

describe("BtwPlugin factory", () => {
  let testDir: string
  let mockClient: ReturnType<typeof createMockClient>

  beforeEach(() => {
    testDir = join(tmpdir(), `btw-plugin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  async function createPlugin() {
    mockClient = createMockClient()
    return await BtwPlugin({
      directory: testDir,
      client: mockClient as any,
      project: "test",
      worktree: false,
      serverUrl: "http://localhost:3000",
      $: null as any,
    })
  }

  // ─── Config Hook ────────────────────────────────────────────────

  describe("config hook", () => {
    test("registers /btw command", async () => {
      const hooks = await createPlugin()
      const config: any = {}
      hooks.config!(config)

      expect(config.command.btw).toBeDefined()
      expect(config.command.btw.description).toContain("hint")
      expect(config.command.btw.template).toBe("$ARGUMENTS")
    })

    test("preserves existing commands", async () => {
      const hooks = await createPlugin()
      const config: any = { command: { existing: { template: "hello" } } }
      hooks.config!(config)

      expect(config.command.existing).toBeDefined()
      expect(config.command.btw).toBeDefined()
    })
  })

  // ─── Command Interception ─────────────────────────────────────────

  describe("command.execute.before", () => {
    test("ignores non-btw commands", async () => {
      const hooks = await createPlugin()
      const handler = hooks["command.execute.before"]!

      // Should not throw for other commands
      await handler(
        { command: "help", sessionID: "s1", arguments: "" },
        { parts: [] },
      )
    })

    test("throws BTW_HANDLED for /btw with hint text", async () => {
      const hooks = await createPlugin()
      const handler = hooks["command.execute.before"]!

      let thrown: Error | null = null
      try {
        await handler(
          { command: "btw", sessionID: "s1", arguments: "use Edit tool" },
          { parts: [] },
        )
      } catch (e) {
        thrown = e as Error
      }

      expect(thrown).not.toBeNull()
      expect(thrown!.message).toBe(BTW_HANDLED)
    })

    test("adds transient hint on /btw <text>", async () => {
      const hooks = await createPlugin()
      const handler = hooks["command.execute.before"]!

      try {
        await handler(
          { command: "btw", sessionID: "s1", arguments: "focus on auth" },
          { parts: [] },
        )
      } catch {}

      const { btwDir, hintPath } = await import("./core")
      const dir = btwDir(testDir)
      const hints = await readHints(hintPath(dir, "s1"))

      expect(hints).toEqual([{ text: "focus on auth", pinned: false }])
    })

    test("adds pinned hint on /btw pin <text>", async () => {
      const hooks = await createPlugin()
      const handler = hooks["command.execute.before"]!

      try {
        await handler(
          { command: "btw", sessionID: "s1", arguments: "pin always use TypeScript" },
          { parts: [] },
        )
      } catch {}

      const { btwDir, hintPath } = await import("./core")
      const dir = btwDir(testDir)
      const hints = await readHints(hintPath(dir, "s1"))

      expect(hints).toEqual([{ text: "always use TypeScript", pinned: true }])
    })

    test("stacks multiple hints", async () => {
      const hooks = await createPlugin()
      const handler = hooks["command.execute.before"]!

      try {
        await handler(
          { command: "btw", sessionID: "s1", arguments: "pin use TypeScript" },
          { parts: [] },
        )
      } catch {}

      try {
        await handler(
          { command: "btw", sessionID: "s1", arguments: "also add JSDoc" },
          { parts: [] },
        )
      } catch {}

      const { btwDir, hintPath } = await import("./core")
      const dir = btwDir(testDir)
      const hints = await readHints(hintPath(dir, "s1"))

      expect(hints).toEqual([
        { text: "use TypeScript", pinned: true },
        { text: "also add JSDoc", pinned: false },
      ])
    })

    test("clears all hints on /btw clear", async () => {
      const hooks = await createPlugin()
      const handler = hooks["command.execute.before"]!

      // Set two hints
      const { btwDir, hintPath, writeHints } = await import("./core")
      const dir = btwDir(testDir)
      mkdirSync(dir, { recursive: true })
      await writeHints(hintPath(dir, "s1"), [
        { text: "hint 1", pinned: false },
        { text: "hint 2", pinned: true },
      ])

      try {
        await handler(
          { command: "btw", sessionID: "s1", arguments: "clear" },
          { parts: [] },
        )
      } catch {}

      const hints = await readHints(hintPath(dir, "s1"))
      expect(hints).toEqual([])
    })

    test("clears last hint on /btw clear last", async () => {
      const hooks = await createPlugin()
      const handler = hooks["command.execute.before"]!

      // Set two hints
      const { btwDir, hintPath, writeHints } = await import("./core")
      const dir = btwDir(testDir)
      mkdirSync(dir, { recursive: true })
      await writeHints(hintPath(dir, "s1"), [
        { text: "hint 1", pinned: true },
        { text: "hint 2", pinned: false },
      ])

      try {
        await handler(
          { command: "btw", sessionID: "s1", arguments: "clear last" },
          { parts: [] },
        )
      } catch {}

      const hints = await readHints(hintPath(dir, "s1"))
      expect(hints).toEqual([{ text: "hint 1", pinned: true }])
    })

    test("sends visible message with removed hint text on clear last", async () => {
      const hooks = await createPlugin()
      const handler = hooks["command.execute.before"]!

      // Set a hint
      const { btwDir, hintPath, writeHints } = await import("./core")
      const dir = btwDir(testDir)
      mkdirSync(dir, { recursive: true })
      await writeHints(hintPath(dir, "s1"), [{ text: "my hint", pinned: false }])

      try {
        await handler(
          { command: "btw", sessionID: "s1", arguments: "clear last" },
          { parts: [] },
        )
      } catch {}

      const lastCall = mockClient.promptCalls[mockClient.promptCalls.length - 1]
      expect(lastCall.body.parts[0].text).toContain("my hint")
    })

    test("sends visible message for added hint", async () => {
      const hooks = await createPlugin()
      const handler = hooks["command.execute.before"]!

      try {
        await handler(
          { command: "btw", sessionID: "s1", arguments: "test message" },
          { parts: [] },
        )
      } catch {}

      expect(mockClient.promptCalls.length).toBeGreaterThan(0)
      const lastCall = mockClient.promptCalls[mockClient.promptCalls.length - 1]
      expect(lastCall.body.noReply).toBe(true)
      expect(lastCall.body.parts[0].ignored).toBe(true)
      expect(lastCall.body.parts[0].text).toContain("added")
      expect(lastCall.body.parts[0].text).toContain("test message")
    })

    test("sends status message when no hints are set", async () => {
      const hooks = await createPlugin()
      const handler = hooks["command.execute.before"]!

      try {
        await handler(
          { command: "btw", sessionID: "s1", arguments: "" },
          { parts: [] },
        )
      } catch {}

      const lastCall = mockClient.promptCalls[mockClient.promptCalls.length - 1]
      expect(lastCall.body.parts[0].text).toContain("No hints set")
    })

    test("sends status listing all hints when some exist", async () => {
      const hooks = await createPlugin()
      const handler = hooks["command.execute.before"]!

      // Set two hints
      try {
        await handler(
          { command: "btw", sessionID: "s1", arguments: "pin first" },
          { parts: [] },
        )
      } catch {}
      try {
        await handler(
          { command: "btw", sessionID: "s1", arguments: "second" },
          { parts: [] },
        )
      } catch {}

      mockClient.promptCalls.length = 0

      try {
        await handler(
          { command: "btw", sessionID: "s1", arguments: "" },
          { parts: [] },
        )
      } catch {}

      const lastCall = mockClient.promptCalls[mockClient.promptCalls.length - 1]
      const text = lastCall.body.parts[0].text
      expect(text).toContain("Active hints")
      expect(text).toContain("[pinned]")
      expect(text).toContain("[transient]")
      expect(text).toContain("first")
      expect(text).toContain("second")
    })
  })

  // ─── System Transform ─────────────────────────────────────────────

  describe("experimental.chat.system.transform", () => {
    test("does nothing when no hints exist", async () => {
      const hooks = await createPlugin()
      const handler = hooks["experimental.chat.system.transform"]!

      const output = { system: ["existing prompt"] }
      await handler({ sessionID: "s1" } as any, output)

      expect(output.system).toEqual(["existing prompt"])
    })

    test("appends hint block when hints exist", async () => {
      const hooks = await createPlugin()

      // Set a hint via the command handler
      try {
        await hooks["command.execute.before"]!(
          { command: "btw", sessionID: "s1", arguments: "use Edit tool" },
          { parts: [] },
        )
      } catch {}

      const handler = hooks["experimental.chat.system.transform"]!
      const output = { system: ["existing prompt"] }
      await handler({ sessionID: "s1" } as any, output)

      expect(output.system.length).toBe(2)
      expect(output.system[1]).toContain("<btw-active-hint>")
      expect(output.system[1]).toContain("use Edit tool")
      expect(output.system[1]).toContain("</btw-active-hint>")
    })

    test("renders multiple hints as separate blocks", async () => {
      const hooks = await createPlugin()

      try {
        await hooks["command.execute.before"]!(
          { command: "btw", sessionID: "s1", arguments: "pin first" },
          { parts: [] },
        )
      } catch {}
      try {
        await hooks["command.execute.before"]!(
          { command: "btw", sessionID: "s1", arguments: "second" },
          { parts: [] },
        )
      } catch {}

      const handler = hooks["experimental.chat.system.transform"]!
      const output = { system: ["existing prompt"] }
      await handler({ sessionID: "s1" } as any, output)

      expect(output.system.length).toBe(2)
      const matches = output.system[1].match(/<btw-active-hint>\n/g)
      expect(matches?.length).toBe(2)
    })

    test("does nothing without sessionID", async () => {
      const hooks = await createPlugin()
      const handler = hooks["experimental.chat.system.transform"]!

      const output = { system: ["existing"] }
      await handler({} as any, output)

      expect(output.system).toEqual(["existing"])
    })
  })

  // ─── Event Hook ────────────────────────────────────────────────────

  describe("event hook", () => {
    test("auto-clears transient hints on session.idle", async () => {
      const hooks = await createPlugin()

      // Set a transient hint
      try {
        await hooks["command.execute.before"]!(
          { command: "btw", sessionID: "s1", arguments: "transient hint" },
          { parts: [] },
        )
      } catch {}

      // Fire session.idle event
      await hooks.event!({
        event: {
          type: "session.idle",
          properties: { sessionID: "s1" },
        } as any,
      })

      // Hint should be cleared
      const { btwDir, hintPath } = await import("./core")
      const hints = await readHints(hintPath(btwDir(testDir), "s1"))
      expect(hints).toEqual([])
    })

    test("keeps pinned hints on session.idle", async () => {
      const hooks = await createPlugin()

      // Set a pinned hint
      try {
        await hooks["command.execute.before"]!(
          { command: "btw", sessionID: "s1", arguments: "pin stay forever" },
          { parts: [] },
        )
      } catch {}

      // Fire session.idle event
      await hooks.event!({
        event: {
          type: "session.idle",
          properties: { sessionID: "s1" },
        } as any,
      })

      // Pinned hint should still exist
      const { btwDir, hintPath } = await import("./core")
      const hints = await readHints(hintPath(btwDir(testDir), "s1"))
      expect(hints).toEqual([{ text: "stay forever", pinned: true }])
    })

    test("removes only transient from mixed hints on session.idle", async () => {
      const hooks = await createPlugin()

      // Set mixed hints
      try {
        await hooks["command.execute.before"]!(
          { command: "btw", sessionID: "s1", arguments: "pin persistent" },
          { parts: [] },
        )
      } catch {}
      try {
        await hooks["command.execute.before"]!(
          { command: "btw", sessionID: "s1", arguments: "temporary" },
          { parts: [] },
        )
      } catch {}

      // Fire session.idle event
      await hooks.event!({
        event: {
          type: "session.idle",
          properties: { sessionID: "s1" },
        } as any,
      })

      const { btwDir, hintPath } = await import("./core")
      const hints = await readHints(hintPath(btwDir(testDir), "s1"))
      expect(hints).toEqual([{ text: "persistent", pinned: true }])
    })

    test("sends auto-clear message on session.idle", async () => {
      const hooks = await createPlugin()

      // Set a transient hint
      try {
        await hooks["command.execute.before"]!(
          { command: "btw", sessionID: "s1", arguments: "will auto-clear" },
          { parts: [] },
        )
      } catch {}

      mockClient.promptCalls.length = 0

      // Fire session.idle event
      await hooks.event!({
        event: {
          type: "session.idle",
          properties: { sessionID: "s1" },
        } as any,
      })

      expect(mockClient.promptCalls.length).toBe(1)
      expect(mockClient.promptCalls[0].body.parts[0].text).toContain("auto-cleared")
    })

    test("does NOT send auto-clear message when only pinned hints exist", async () => {
      const hooks = await createPlugin()

      // Set a pinned hint only
      try {
        await hooks["command.execute.before"]!(
          { command: "btw", sessionID: "s1", arguments: "pin persistent" },
          { parts: [] },
        )
      } catch {}

      mockClient.promptCalls.length = 0

      // Fire session.idle event
      await hooks.event!({
        event: {
          type: "session.idle",
          properties: { sessionID: "s1" },
        } as any,
      })

      // No auto-clear message should be sent
      expect(mockClient.promptCalls.length).toBe(0)
    })

    test("cleans up on session.deleted", async () => {
      const hooks = await createPlugin()

      // Set hints
      try {
        await hooks["command.execute.before"]!(
          { command: "btw", sessionID: "s1", arguments: "pin important" },
          { parts: [] },
        )
      } catch {}

      // Fire session.deleted event
      await hooks.event!({
        event: {
          type: "session.deleted",
          properties: { sessionID: "s1" },
        } as any,
      })

      // File should be removed
      const { btwDir, hintPath } = await import("./core")
      const filePath = hintPath(btwDir(testDir), "s1")
      expect(existsSync(filePath)).toBe(false)
    })

    test("ignores other events", async () => {
      const hooks = await createPlugin()

      // Should not throw
      await hooks.event!({
        event: {
          type: "message.updated",
          properties: { sessionID: "s1" },
        } as any,
      })
    })
  })
})

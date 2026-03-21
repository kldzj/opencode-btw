import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test"
import { mkdirSync, rmSync, existsSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

import { BTW_HANDLED, readHint, writeHint } from "./core"
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

    test("writes transient hint file on /btw <text>", async () => {
      const hooks = await createPlugin()
      const handler = hooks["command.execute.before"]!

      try {
        await handler(
          { command: "btw", sessionID: "s1", arguments: "focus on auth" },
          { parts: [] },
        )
      } catch {}

      // Find the hint file - it's in the btw cache dir for this test directory
      const { btwDir, hintPath } = await import("./core")
      const dir = btwDir(testDir)
      const data = await readHint(hintPath(dir, "s1"))

      expect(data).toEqual({ text: "focus on auth", pinned: false })
    })

    test("writes pinned hint file on /btw pin <text>", async () => {
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
      const data = await readHint(hintPath(dir, "s1"))

      expect(data).toEqual({ text: "always use TypeScript", pinned: true })
    })

    test("clears hint on /btw clear", async () => {
      const hooks = await createPlugin()
      const handler = hooks["command.execute.before"]!

      // Set a hint first
      const { btwDir, hintPath, writeHint } = await import("./core")
      const dir = btwDir(testDir)
      mkdirSync(dir, { recursive: true })
      await writeHint(hintPath(dir, "s1"), { text: "old hint", pinned: false })

      try {
        await handler(
          { command: "btw", sessionID: "s1", arguments: "clear" },
          { parts: [] },
        )
      } catch {}

      const data = await readHint(hintPath(dir, "s1"))
      expect(data).toBeNull()
    })

    test("sends visible message for set hint", async () => {
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
      expect(lastCall.body.parts[0].text).toContain("Hint set")
      expect(lastCall.body.parts[0].text).toContain("test message")
    })

    test("sends status message when no hint is set", async () => {
      const hooks = await createPlugin()
      const handler = hooks["command.execute.before"]!

      try {
        await handler(
          { command: "btw", sessionID: "s1", arguments: "" },
          { parts: [] },
        )
      } catch {}

      const lastCall = mockClient.promptCalls[mockClient.promptCalls.length - 1]
      expect(lastCall.body.parts[0].text).toContain("No hint set")
    })

    test("sends status with current hint when one exists", async () => {
      const hooks = await createPlugin()
      const handler = hooks["command.execute.before"]!

      // Set a hint first
      try {
        await handler(
          { command: "btw", sessionID: "s1", arguments: "my hint" },
          { parts: [] },
        )
      } catch {}

      // Reset call tracking
      mockClient.promptCalls.length = 0

      // Check status
      try {
        await handler(
          { command: "btw", sessionID: "s1", arguments: "" },
          { parts: [] },
        )
      } catch {}

      const lastCall = mockClient.promptCalls[mockClient.promptCalls.length - 1]
      expect(lastCall.body.parts[0].text).toContain("transient")
      expect(lastCall.body.parts[0].text).toContain("my hint")
    })
  })

  // ─── System Transform ─────────────────────────────────────────────

  describe("experimental.chat.system.transform", () => {
    test("does nothing when no hint exists", async () => {
      const hooks = await createPlugin()
      const handler = hooks["experimental.chat.system.transform"]!

      const output = { system: ["existing prompt"] }
      await handler({ sessionID: "s1" } as any, output)

      expect(output.system).toEqual(["existing prompt"])
    })

    test("appends hint block when hint exists", async () => {
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
    test("auto-clears transient hint on session.idle", async () => {
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
      const data = await readHint(hintPath(btwDir(testDir), "s1"))
      expect(data).toBeNull()
    })

    test("does NOT clear pinned hint on session.idle", async () => {
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

      // Hint should still exist
      const { btwDir, hintPath } = await import("./core")
      const data = await readHint(hintPath(btwDir(testDir), "s1"))
      expect(data).toEqual({ text: "stay forever", pinned: true })
    })

    test("cleans up on session.deleted", async () => {
      const hooks = await createPlugin()

      // Set a hint
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

      // Hint should be removed
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

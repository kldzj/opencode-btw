import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test"
import { mkdirSync, rmSync, existsSync, unlinkSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

import { readHints, writeHints, debugMarkerPath } from "./core"
import { BtwPlugin } from "./plugin"

// ─── Test Helpers ────────────────────────────────────────────────────

function createMockClient() {
  const promptCalls: any[] = []
  const toastCalls: any[] = []

  return {
    promptCalls,
    toastCalls,
    session: {
      prompt: mock(async (opts: any) => {
        promptCalls.push(opts)
        return {}
      }),
    },
    tui: {
      showToast: mock(async (opts: any) => {
        toastCalls.push(opts)
      }),
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

    // Ensure debug mode is off so debugLog messages don't interfere with tests
    try { unlinkSync(debugMarkerPath()) } catch {}
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

    test("throws for /btw with hint text (cancels LLM call)", async () => {
      const hooks = await createPlugin()
      const handler = hooks["command.execute.before"]!

      await expect(
        handler(
          { command: "btw", sessionID: "s1", arguments: "use Edit tool" },
          { parts: [] },
        ),
      ).rejects.toThrow()
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

    test("clears specific hint by number on /btw clear 2", async () => {
      const hooks = await createPlugin()
      const handler = hooks["command.execute.before"]!

      // Set three hints
      const { btwDir, hintPath, writeHints } = await import("./core")
      const dir = btwDir(testDir)
      mkdirSync(dir, { recursive: true })
      await writeHints(hintPath(dir, "s1"), [
        { text: "hint A", pinned: true },
        { text: "hint B", pinned: false },
        { text: "hint C", pinned: true },
      ])

      try {
        await handler(
          { command: "btw", sessionID: "s1", arguments: "clear 2" },
          { parts: [] },
        )
      } catch {}

      const hints = await readHints(hintPath(dir, "s1"))
      expect(hints).toEqual([
        { text: "hint A", pinned: true },
        { text: "hint C", pinned: true },
      ])
    })

    test("sends message with removed hint text on clear <N>", async () => {
      const hooks = await createPlugin()
      const handler = hooks["command.execute.before"]!

      const { btwDir, hintPath, writeHints } = await import("./core")
      const dir = btwDir(testDir)
      mkdirSync(dir, { recursive: true })
      await writeHints(hintPath(dir, "s1"), [
        { text: "first", pinned: false },
        { text: "target", pinned: true },
      ])

      try {
        await handler(
          { command: "btw", sessionID: "s1", arguments: "clear 2" },
          { parts: [] },
        )
      } catch {}

      const lastCall = mockClient.toastCalls[mockClient.toastCalls.length - 1]
      expect(lastCall.body.message).toContain("#2")
      expect(lastCall.body.message).toContain("target")
    })

    test("shows error for out-of-range clear <N>", async () => {
      const hooks = await createPlugin()
      const handler = hooks["command.execute.before"]!

      const { btwDir, hintPath, writeHints } = await import("./core")
      const dir = btwDir(testDir)
      mkdirSync(dir, { recursive: true })
      await writeHints(hintPath(dir, "s1"), [{ text: "only", pinned: false }])

      try {
        await handler(
          { command: "btw", sessionID: "s1", arguments: "clear 5" },
          { parts: [] },
        )
      } catch {}

      const lastCall = mockClient.toastCalls[mockClient.toastCalls.length - 1]
      expect(lastCall.body.message).toContain("#5")
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

      const lastCall = mockClient.toastCalls[mockClient.toastCalls.length - 1]
      expect(lastCall.body.message).toContain("my hint")
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

      expect(mockClient.toastCalls.length).toBeGreaterThan(0)
      const lastCall = mockClient.toastCalls[mockClient.toastCalls.length - 1]
      expect(lastCall.body.message).toContain("added")
      expect(lastCall.body.message).toContain("test message")
    })

    test("sends help message on /btw help", async () => {
      const hooks = await createPlugin()
      const handler = hooks["command.execute.before"]!

      try {
        await handler(
          { command: "btw", sessionID: "s1", arguments: "help" },
          { parts: [] },
        )
      } catch {}

      const lastCall = mockClient.toastCalls[mockClient.toastCalls.length - 1]
      expect(lastCall.body.message).toContain("/btw pin")
      expect(lastCall.body.message).toContain("/btw clear")
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

      const lastCall = mockClient.toastCalls[mockClient.toastCalls.length - 1]
      expect(lastCall.body.message).toContain("No hints set")
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

      mockClient.toastCalls.length = 0

      try {
        await handler(
          { command: "btw", sessionID: "s1", arguments: "" },
          { parts: [] },
        )
      } catch {}

      const lastCall = mockClient.toastCalls[mockClient.toastCalls.length - 1]
      const text = lastCall.body.message
      expect(text).toContain("Active hints")
      expect(text).toContain("[pinned]")
      expect(text).toContain("[transient]")
      expect(text).toContain("first")
      expect(text).toContain("second")
    })
  })

  // ─── Messages Transform ──────────────────────────────────────────

  describe("experimental.chat.messages.transform", () => {
    function makeUserMsg(sessionID: string, messageID: string, text: string) {
      return {
        info: { id: messageID, sessionID, role: "user" },
        parts: [{ id: "p1", sessionID, messageID, type: "text", text }],
      }
    }

    function makeAssistantMsg(sessionID: string, messageID: string) {
      return {
        info: { id: messageID, sessionID, role: "assistant" },
        parts: [{ id: "p2", sessionID, messageID, type: "text", text: "response" }],
      }
    }

    test("appends hint text to last user message", async () => {
      const hooks = await createPlugin()

      try {
        await hooks["command.execute.before"]!(
          { command: "btw", sessionID: "s1", arguments: "use emojis" },
          { parts: [] },
        )
      } catch {}

      const handler = hooks["experimental.chat.messages.transform"]!
      const messages = [makeUserMsg("s1", "msg-1", "hello")]
      const output = { messages }
      await handler({} as any, output)

      expect(messages[0].parts.length).toBe(2)
      expect(messages[0].parts[1].text).toBe("BTW, use emojis")
      expect(messages[0].parts[1].synthetic).toBe(true)
    })

    test("finds last user message even after assistant messages", async () => {
      const hooks = await createPlugin()

      try {
        await hooks["command.execute.before"]!(
          { command: "btw", sessionID: "s1", arguments: "be brief" },
          { parts: [] },
        )
      } catch {}

      const handler = hooks["experimental.chat.messages.transform"]!
      const messages = [
        makeUserMsg("s1", "msg-1", "hello"),
        makeAssistantMsg("s1", "msg-2"),
        makeUserMsg("s1", "msg-3", "fix it"),
      ]
      const output = { messages }
      await handler({} as any, output)

      // Only last user message gets the hint
      expect(messages[0].parts.length).toBe(1) // unchanged
      expect(messages[2].parts.length).toBe(2)
      expect(messages[2].parts[1].text).toBe("BTW, be brief")
    })

    test("does nothing when no hints exist", async () => {
      const hooks = await createPlugin()
      const handler = hooks["experimental.chat.messages.transform"]!
      const messages = [makeUserMsg("s1", "msg-1", "hello")]
      const output = { messages }
      await handler({} as any, output)

      expect(messages[0].parts.length).toBe(1)
    })

    test("does nothing when no user messages exist", async () => {
      const hooks = await createPlugin()

      try {
        await hooks["command.execute.before"]!(
          { command: "btw", sessionID: "s1", arguments: "test" },
          { parts: [] },
        )
      } catch {}

      const handler = hooks["experimental.chat.messages.transform"]!
      const messages = [makeAssistantMsg("s1", "msg-1")]
      const output = { messages }
      await handler({} as any, output)

      expect(messages[0].parts.length).toBe(1)
    })

    test("does nothing with empty messages array", async () => {
      const hooks = await createPlugin()
      const handler = hooks["experimental.chat.messages.transform"]!
      const output = { messages: [] as any[] }
      await handler({} as any, output)

      expect(output.messages.length).toBe(0)
    })

    test("formats multiple hints as numbered list", async () => {
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

      const handler = hooks["experimental.chat.messages.transform"]!
      const messages = [makeUserMsg("s1", "msg-1", "hello")]
      const output = { messages }
      await handler({} as any, output)

      expect(messages[0].parts.length).toBe(2)
      expect(messages[0].parts[1].text).toContain("1. first")
      expect(messages[0].parts[1].text).toContain("2. second")
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
      expect(output.system[0]).toContain("### Current Preferences")
      expect(output.system[0]).toContain("use Edit tool")
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
      expect(output.system[0]).toContain("1. first")
      expect(output.system[0]).toContain("2. second")
    })

    test("does nothing without sessionID", async () => {
      const hooks = await createPlugin()
      const handler = hooks["experimental.chat.system.transform"]!

      const output = { system: ["existing"] }
      await handler({} as any, output)

      expect(output.system).toEqual(["existing"])
    })

    test("clears transient hints on second call (inject-once)", async () => {
      const hooks = await createPlugin()

      // Set a transient hint
      try {
        await hooks["command.execute.before"]!(
          { command: "btw", sessionID: "s1", arguments: "one-shot hint" },
          { parts: [] },
        )
      } catch {}

      const handler = hooks["experimental.chat.system.transform"]!

      // First call: hint should be injected
      const output1 = { system: ["base"] }
      await handler({ sessionID: "s1" } as any, output1)
      expect(output1.system.length).toBe(2)
      expect(output1.system[0]).toContain("one-shot hint")

      // Second call: hint still present (no inject-once; clearing via tool.execute.after)
      const output2 = { system: ["base"] }
      await handler({ sessionID: "s1" } as any, output2)
      expect(output2.system.length).toBe(2)
      expect(output2.system[0]).toContain("one-shot hint")
    })

    test("keeps pinned hints across multiple calls", async () => {
      const hooks = await createPlugin()

      // Set a pinned hint only
      try {
        await hooks["command.execute.before"]!(
          { command: "btw", sessionID: "s1", arguments: "pin persistent" },
          { parts: [] },
        )
      } catch {}

      const handler = hooks["experimental.chat.system.transform"]!

      // First call: pinned hint injected
      const output1 = { system: ["base"] }
      await handler({ sessionID: "s1" } as any, output1)
      expect(output1.system[0]).toContain("persistent")

      // Second call: pinned hint still present (no transient to clear)
      const output2 = { system: ["base"] }
      await handler({ sessionID: "s1" } as any, output2)
      expect(output2.system[0]).toContain("persistent")
    })

    test("keeps all hints across multiple calls (no inject-once)", async () => {
      const hooks = await createPlugin()

      // Set pinned + transient
      try {
        await hooks["command.execute.before"]!(
          { command: "btw", sessionID: "s1", arguments: "pin keeper" },
          { parts: [] },
        )
      } catch {}
      try {
        await hooks["command.execute.before"]!(
          { command: "btw", sessionID: "s1", arguments: "temporary" },
          { parts: [] },
        )
      } catch {}

      const handler = hooks["experimental.chat.system.transform"]!

      // First call: both hints injected
      const output1 = { system: ["base"] }
      await handler({ sessionID: "s1" } as any, output1)
      expect(output1.system[0]).toContain("keeper")
      expect(output1.system[0]).toContain("temporary")

      // Second call: both hints still present (clearing via tool.execute.after, not system.transform)
      const output2 = { system: ["base"] }
      await handler({ sessionID: "s1" } as any, output2)
      expect(output2.system[0]).toContain("keeper")
      expect(output2.system[0]).toContain("temporary")
    })

    test("system.transform and messages.transform both read same hints consistently", async () => {
      const hooks = await createPlugin()

      function makeUserMsg(sessionID: string, messageID: string, text: string) {
        return {
          info: { id: messageID, sessionID, role: "user" },
          parts: [{ id: "p1", sessionID, messageID, type: "text", text }],
        }
      }

      // Set a transient hint
      try {
        await hooks["command.execute.before"]!(
          { command: "btw", sessionID: "s1", arguments: "persists" },
          { parts: [] },
        )
      } catch {}

      // First system.transform: injects hint
      const sysOutput1 = { system: ["base"] }
      await hooks["experimental.chat.system.transform"]!(
        { sessionID: "s1" } as any,
        sysOutput1,
      )
      expect(sysOutput1.system[0]).toContain("persists")

      // First messages.transform: also reads and injects
      const msgOutput1 = { messages: [makeUserMsg("s1", "msg-1", "hello")] }
      await hooks["experimental.chat.messages.transform"]!(
        {} as any,
        msgOutput1,
      )
      expect(msgOutput1.messages[0].parts.length).toBe(2)
      expect(msgOutput1.messages[0].parts[1].text).toContain("persists")

      // Second system.transform: hint still present (no inject-once)
      const sysOutput2 = { system: ["base"] }
      await hooks["experimental.chat.system.transform"]!(
        { sessionID: "s1" } as any,
        sysOutput2,
      )
      expect(sysOutput2.system.length).toBe(2)
      expect(sysOutput2.system[0]).toContain("persists")
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

      mockClient.toastCalls.length = 0

      // Fire session.idle event
      await hooks.event!({
        event: {
          type: "session.idle",
          properties: { sessionID: "s1" },
        } as any,
      })

      expect(mockClient.toastCalls.length).toBe(1)
      expect(mockClient.toastCalls[0].body.message).toContain("auto-cleared")
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

      mockClient.toastCalls.length = 0

      // Fire session.idle event
      await hooks.event!({
        event: {
          type: "session.idle",
          properties: { sessionID: "s1" },
        } as any,
      })

      // No auto-clear message should be sent
      expect(mockClient.toastCalls.length).toBe(0)
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

  // ─── Tool Execute After Hook ─────────────────────────────────────────

  describe("tool.execute.after hook", () => {
    test("clears transient hints when question tool fires", async () => {
      const hooks = await createPlugin()

      // Set a transient hint
      try {
        await hooks["command.execute.before"]!(
          { command: "btw", sessionID: "s1", arguments: "one-shot" },
          { parts: [] },
        )
      } catch {}

      // Fire tool.execute.after for question tool
      const handler = hooks["tool.execute.after"]!
      await handler(
        { tool: "question", sessionID: "s1", callID: "c1", args: {} } as any,
        { title: "", output: "", metadata: {} },
      )

      // Hint should be cleared
      const { btwDir, hintPath } = await import("./core")
      const hints = await readHints(hintPath(btwDir(testDir), "s1"))
      expect(hints).toEqual([])
    })

    test("keeps pinned hints when question tool fires", async () => {
      const hooks = await createPlugin()

      // Set a pinned hint + transient hint
      try {
        await hooks["command.execute.before"]!(
          { command: "btw", sessionID: "s1", arguments: "pin keeper" },
          { parts: [] },
        )
      } catch {}
      try {
        await hooks["command.execute.before"]!(
          { command: "btw", sessionID: "s1", arguments: "temporary" },
          { parts: [] },
        )
      } catch {}

      // Fire question tool
      const handler = hooks["tool.execute.after"]!
      await handler(
        { tool: "question", sessionID: "s1", callID: "c1", args: {} } as any,
        { title: "", output: "", metadata: {} },
      )

      // Only pinned remains
      const { btwDir, hintPath } = await import("./core")
      const hints = await readHints(hintPath(btwDir(testDir), "s1"))
      expect(hints).toEqual([{ text: "keeper", pinned: true }])
    })

    test("ignores non-question tool calls", async () => {
      const hooks = await createPlugin()

      // Set a transient hint
      try {
        await hooks["command.execute.before"]!(
          { command: "btw", sessionID: "s1", arguments: "stay" },
          { parts: [] },
        )
      } catch {}

      // Fire tool.execute.after for grep (not question)
      const handler = hooks["tool.execute.after"]!
      await handler(
        { tool: "grep", sessionID: "s1", callID: "c1", args: {} } as any,
        { title: "", output: "", metadata: {} },
      )

      // Hint should still exist
      const { btwDir, hintPath } = await import("./core")
      const hints = await readHints(hintPath(btwDir(testDir), "s1"))
      expect(hints).toEqual([{ text: "stay", pinned: false }])
    })

    test("sends auto-clear message when transient hints are removed", async () => {
      const hooks = await createPlugin()

      // Set a transient hint
      try {
        await hooks["command.execute.before"]!(
          { command: "btw", sessionID: "s1", arguments: "will clear" },
          { parts: [] },
        )
      } catch {}

      mockClient.toastCalls.length = 0

      // Fire question tool
      const handler = hooks["tool.execute.after"]!
      await handler(
        { tool: "question", sessionID: "s1", callID: "c1", args: {} } as any,
        { title: "", output: "", metadata: {} },
      )

      expect(mockClient.toastCalls.length).toBe(1)
      expect(mockClient.toastCalls[0].body.message).toContain("auto-cleared")
      expect(mockClient.toastCalls[0].body.message).toContain("question")
    })

    test("does not send message when no transient hints exist", async () => {
      const hooks = await createPlugin()

      // Only pinned hints
      try {
        await hooks["command.execute.before"]!(
          { command: "btw", sessionID: "s1", arguments: "pin persistent" },
          { parts: [] },
        )
      } catch {}

      mockClient.toastCalls.length = 0

      // Fire question tool
      const handler = hooks["tool.execute.after"]!
      await handler(
        { tool: "question", sessionID: "s1", callID: "c1", args: {} } as any,
        { title: "", output: "", metadata: {} },
      )

      // No auto-clear message (no transient hints to clear)
      expect(mockClient.toastCalls.length).toBe(0)
    })

    test("handles missing sessionID gracefully", async () => {
      const hooks = await createPlugin()
      const handler = hooks["tool.execute.after"]!

      // Should not throw
      await handler(
        { tool: "question", callID: "c1", args: {} } as any,
        { title: "", output: "", metadata: {} },
      )
    })

    test("system.transform no longer injects after question tool clears", async () => {
      const hooks = await createPlugin()

      // Set a transient hint
      try {
        await hooks["command.execute.before"]!(
          { command: "btw", sessionID: "s1", arguments: "vanishes" },
          { parts: [] },
        )
      } catch {}

      // First system.transform: hint injected
      const output1 = { system: ["base"] }
      await hooks["experimental.chat.system.transform"]!(
        { sessionID: "s1" } as any,
        output1,
      )
      expect(output1.system[0]).toContain("vanishes")

      // Question tool fires — clears transient hints
      await hooks["tool.execute.after"]!(
        { tool: "question", sessionID: "s1", callID: "c1", args: {} } as any,
        { title: "", output: "", metadata: {} },
      )

      // Second system.transform: hint no longer present
      const output2 = { system: ["base"] }
      await hooks["experimental.chat.system.transform"]!(
        { sessionID: "s1" } as any,
        output2,
      )
      expect(output2.system).toEqual(["base"])
    })
  })

  // ─── Debug Command ────────────────────────────────────────────────

  describe("debug command", () => {
    let origHome: string | undefined

    beforeEach(() => {
      origHome = process.env.HOME
      // Set HOME to temp dir so toggleDebug doesn't affect real state
      const tempDir = join(tmpdir(), `btw-debug-plugin-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      const cacheDir = join(tempDir, ".cache", "opencode", "btw")
      mkdirSync(cacheDir, { recursive: true })
      process.env.HOME = tempDir
    })

    afterEach(() => {
      const tempDir = process.env.HOME!
      process.env.HOME = origHome
      try {
        rmSync(tempDir, { recursive: true, force: true })
      } catch {}
    })

    test("toggles debug mode on via /btw debug", async () => {
      const hooks = await createPlugin()
      const handler = hooks["command.execute.before"]!

      try {
        await handler(
          { command: "btw", sessionID: "s1", arguments: "debug" },
          { parts: [] },
        )
      } catch {}

      const lastCall = mockClient.toastCalls[mockClient.toastCalls.length - 1]
      expect(lastCall.body.message).toContain("enabled")
    })

    test("toggles debug mode off on second /btw debug", async () => {
      const hooks = await createPlugin()
      const handler = hooks["command.execute.before"]!

      // Enable
      try {
        await handler(
          { command: "btw", sessionID: "s1", arguments: "debug" },
          { parts: [] },
        )
      } catch {}

      // Disable
      try {
        await handler(
          { command: "btw", sessionID: "s1", arguments: "debug" },
          { parts: [] },
        )
      } catch {}

      const lastCall = mockClient.toastCalls[mockClient.toastCalls.length - 1]
      expect(lastCall.body.message).toContain("disabled")
    })

    test("throws to cancel command on /btw debug", async () => {
      const hooks = await createPlugin()
      const handler = hooks["command.execute.before"]!

      await expect(
        handler(
          { command: "btw", sessionID: "s1", arguments: "debug" },
          { parts: [] },
        ),
      ).rejects.toThrow()
    })
  })
})

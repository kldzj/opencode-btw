import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdirSync, rmSync, existsSync, readFileSync, unlinkSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

import {
  type HintEntry,
  BTW_HANDLED,
  BTW_HELP,
  cancelCommand,
  projectHash,
  btwDir,
  hintPath,
  readHints,
  writeHints,
  addHint,
  clearHints,
  removeTransient,
  removeLast,
  removeAt,
  parseCommand,
  buildSystemBlock,
  buildUserHint,
  ensureDir,
  debugMarkerPath,
  isDebugEnabled,
  toggleDebug,
} from "./core"
import { DEFAULT_SYSTEM_INSTRUCTIONS, type BtwConfig, DEFAULT_CONFIG } from "./config"

// ─── Pure Functions ──────────────────────────────────────────────────

describe("projectHash", () => {
  test("returns a 12-character hex string", () => {
    const hash = projectHash("/home/user/project")
    expect(hash).toMatch(/^[a-f0-9]{12}$/)
  })

  test("is deterministic", () => {
    const a = projectHash("/some/path")
    const b = projectHash("/some/path")
    expect(a).toBe(b)
  })

  test("different paths produce different hashes", () => {
    const a = projectHash("/path/a")
    const b = projectHash("/path/b")
    expect(a).not.toBe(b)
  })
})

describe("btwDir", () => {
  test("uses HOME env and project hash", () => {
    const original = process.env.HOME
    process.env.HOME = "/mock/home"

    const dir = btwDir("/my/project")
    const hash = projectHash("/my/project")
    expect(dir).toBe(`/mock/home/.cache/opencode/btw/${hash}`)

    process.env.HOME = original
  })
})

describe("hintPath", () => {
  test("combines dir and sessionID", () => {
    const path = hintPath("/some/dir", "session-123")
    expect(path).toBe("/some/dir/session-123.json")
  })

  test("sanitizes sessionID to prevent path traversal", () => {
    const path = hintPath("/some/dir", "../../etc/passwd")
    expect(path).toBe("/some/dir/______etc_passwd.json")
    expect(path).not.toContain("..")
  })
})

// ─── Command Parsing ─────────────────────────────────────────────────

describe("parseCommand", () => {
  test('returns clear all for "clear"', () => {
    expect(parseCommand("clear")).toEqual({ action: "clear", which: "all" })
  })

  test('returns clear all for "reset"', () => {
    expect(parseCommand("reset")).toEqual({ action: "clear", which: "all" })
  })

  test('returns clear last for "clear last"', () => {
    expect(parseCommand("clear last")).toEqual({ action: "clear", which: "last" })
  })

  test('returns help action for "help"', () => {
    expect(parseCommand("help")).toEqual({ action: "help" })
  })

  test("trims whitespace before matching", () => {
    expect(parseCommand("  clear  ")).toEqual({ action: "clear", which: "all" })
  })

  test("returns status action for empty string", () => {
    expect(parseCommand("")).toEqual({ action: "status" })
  })

  test("returns status action for whitespace-only", () => {
    expect(parseCommand("   ")).toEqual({ action: "status" })
  })

  test("returns pinned set for pin prefix", () => {
    expect(parseCommand("pin use Edit tool")).toEqual({
      action: "set",
      text: "use Edit tool",
      pinned: true,
    })
  })

  test("returns error for pin without text", () => {
    expect(parseCommand("pin ")).toEqual({
      action: "error",
      message: "Usage: /btw pin <hint>",
    })
  })

  test("returns error for pin with only spaces", () => {
    expect(parseCommand("pin    ")).toEqual({
      action: "error",
      message: "Usage: /btw pin <hint>",
    })
  })

  test("returns error for bare pin", () => {
    expect(parseCommand("pin")).toEqual({
      action: "error",
      message: "Usage: /btw pin <hint>",
    })
  })

  test("returns transient set for regular text", () => {
    expect(parseCommand("use smaller functions")).toEqual({
      action: "set",
      text: "use smaller functions",
      pinned: false,
    })
  })

  test("does not treat 'pinned' as pin command", () => {
    expect(parseCommand("pinned note")).toEqual({
      action: "set",
      text: "pinned note",
      pinned: false,
    })
  })

  test("does not treat 'pint' as pin command", () => {
    expect(parseCommand("pint of beer")).toEqual({
      action: "set",
      text: "pint of beer",
      pinned: false,
    })
  })

  test("preserves special characters in hint text", () => {
    expect(parseCommand('use "double quotes" & <tags>')).toEqual({
      action: "set",
      text: 'use "double quotes" & <tags>',
      pinned: false,
    })
  })

  test("treats 'clear last' literally", () => {
    expect(parseCommand("clear last")).toEqual({ action: "clear", which: "last" })
  })

  test("treats 'clear something' as a set action", () => {
    // "clear something" doesn't match any clear variant, so it's treated as hint text
    expect(parseCommand("clear something")).toEqual({
      action: "set",
      text: "clear something",
      pinned: false,
    })
  })

  test('returns clear with number for "clear 2"', () => {
    expect(parseCommand("clear 2")).toEqual({ action: "clear", which: 2 })
  })

  test('returns clear with number for "clear 1"', () => {
    expect(parseCommand("clear 1")).toEqual({ action: "clear", which: 1 })
  })

  test("treats clear 0 as error", () => {
    expect(parseCommand("clear 0")).toEqual({
      action: "error",
      message: "Hint numbers start at 1",
    })
  })

  test("treats 'clear all' as clear command", () => {
    expect(parseCommand("clear all")).toEqual({
      action: "clear",
      which: "all",
    })
  })

  test('returns debug action for "debug"', () => {
    expect(parseCommand("debug")).toEqual({ action: "debug" })
  })

  test("trims whitespace around debug", () => {
    expect(parseCommand("  debug  ")).toEqual({ action: "debug" })
  })

  test("treats 'debugging' as a set action, not debug", () => {
    expect(parseCommand("debugging")).toEqual({
      action: "set",
      text: "debugging",
      pinned: false,
    })
  })
})

// ─── System Prompt Construction ──────────────────────────────────────

describe("buildSystemBlock", () => {
  test("returns empty string for no hints", () => {
    expect(buildSystemBlock([])).toBe("")
  })

  test("includes system instructions for single hint", () => {
    const block = buildSystemBlock([{ text: "test hint", pinned: false }])
    expect(block).toContain(DEFAULT_SYSTEM_INSTRUCTIONS)
  })

  test("formats single hint as plain text under preferences header", () => {
    const block = buildSystemBlock([{ text: "use Edit tool", pinned: false }])
    expect(block).toContain("### Current Preferences")
    expect(block).toContain("use Edit tool")
    // Single hint should not be numbered
    expect(block).not.toContain("1.")
  })

  test("renders multiple hints as numbered list", () => {
    const block = buildSystemBlock([
      { text: "hint one", pinned: false },
      { text: "hint two", pinned: true },
    ])
    expect(block).toContain("1. hint one")
    expect(block).toContain("2. hint two")
  })

  test("includes system instructions only once for multiple hints", () => {
    const block = buildSystemBlock([
      { text: "a", pinned: false },
      { text: "b", pinned: false },
    ])
    const matches = block.match(/## Active User Preferences/g)
    expect(matches?.length).toBe(1)
  })
})

describe("DEFAULT_SYSTEM_INSTRUCTIONS", () => {
  test("contains key behavioral directives", () => {
    expect(DEFAULT_SYSTEM_INSTRUCTIONS).toContain("user preferences")
    expect(DEFAULT_SYSTEM_INSTRUCTIONS).toContain("apply them naturally")
    expect(DEFAULT_SYSTEM_INSTRUCTIONS).toContain("corrects your approach")
  })
})

describe("buildUserHint", () => {
  test("returns empty string for no hints", () => {
    expect(buildUserHint([])).toBe("")
  })

  test("formats single hint with BTW prefix", () => {
    const result = buildUserHint([{ text: "use emojis", pinned: false }])
    expect(result).toBe("BTW, use emojis")
  })

  test("formats multiple hints as numbered list", () => {
    const result = buildUserHint([
      { text: "use emojis", pinned: false },
      { text: "focus on auth", pinned: true },
    ])
    expect(result).toBe("BTW:\n1. use emojis\n2. focus on auth")
  })

  test("single hint is not numbered", () => {
    const result = buildUserHint([{ text: "be brief", pinned: false }])
    expect(result).not.toContain("1.")
  })
})

// ─── Hint File I/O ───────────────────────────────────────────────────

describe("hint file I/O", () => {
  let testDir: string

  beforeEach(() => {
    testDir = join(tmpdir(), `btw-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  test("writeHints creates a JSON file with hints array", async () => {
    const filePath = join(testDir, "session-1.json")
    await writeHints(filePath, [{ text: "test hint", pinned: false }])

    const raw = readFileSync(filePath, "utf-8")
    const data = JSON.parse(raw)
    expect(data).toEqual({ hints: [{ text: "test hint", pinned: false }] })
  })

  test("readHints reads back written data", async () => {
    const filePath = join(testDir, "session-1.json")
    await writeHints(filePath, [{ text: "hello", pinned: true }])

    const result = await readHints(filePath)
    expect(result).toEqual([{ text: "hello", pinned: true }])
  })

  test("readHints returns empty array for non-existent file", async () => {
    const result = await readHints(join(testDir, "missing.json"))
    expect(result).toEqual([])
  })

  test("readHints returns empty array for invalid JSON", async () => {
    const filePath = join(testDir, "bad.json")
    await Bun.write(filePath, "not valid json{{{")

    const result = await readHints(filePath)
    expect(result).toEqual([])
  })

  test("readHints handles legacy single-hint format", async () => {
    const filePath = join(testDir, "legacy.json")
    await Bun.write(filePath, JSON.stringify({ text: "old format", pinned: true }))

    const result = await readHints(filePath)
    expect(result).toEqual([{ text: "old format", pinned: true }])
  })

  test("readHints returns empty for legacy format without text", async () => {
    const filePath = join(testDir, "empty.json")
    await Bun.write(filePath, JSON.stringify({ pinned: true }))

    const result = await readHints(filePath)
    expect(result).toEqual([])
  })

  test("readHints returns empty for empty hints array", async () => {
    const filePath = join(testDir, "empty-array.json")
    await Bun.write(filePath, JSON.stringify({ hints: [] }))

    const result = await readHints(filePath)
    expect(result).toEqual([])
  })

  test("addHint appends to existing hints", async () => {
    const filePath = join(testDir, "session-1.json")
    await writeHints(filePath, [{ text: "first", pinned: false }])
    await addHint(filePath, { text: "second", pinned: true })

    const result = await readHints(filePath)
    expect(result).toEqual([
      { text: "first", pinned: false },
      { text: "second", pinned: true },
    ])
  })

  test("addHint creates file if none exists", async () => {
    const filePath = join(testDir, "new.json")
    await addHint(filePath, { text: "first", pinned: false })

    const result = await readHints(filePath)
    expect(result).toEqual([{ text: "first", pinned: false }])
  })

  test("writeHints with empty array removes file", async () => {
    const filePath = join(testDir, "session-1.json")
    await writeHints(filePath, [{ text: "test", pinned: false }])
    expect(existsSync(filePath)).toBe(true)

    await writeHints(filePath, [])
    expect(existsSync(filePath)).toBe(false)
  })

  test("clearHints removes the file", async () => {
    const filePath = join(testDir, "session-1.json")
    await writeHints(filePath, [{ text: "test", pinned: false }])
    expect(existsSync(filePath)).toBe(true)

    await clearHints(filePath)
    expect(existsSync(filePath)).toBe(false)
  })

  test("clearHints is safe on non-existent file", async () => {
    // Should not throw
    await clearHints(join(testDir, "missing.json"))
  })
})

// ─── removeTransient ─────────────────────────────────────────────────

describe("removeTransient", () => {
  let testDir: string

  beforeEach(() => {
    testDir = join(tmpdir(), `btw-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  test("removes only transient hints, keeps pinned", async () => {
    const filePath = join(testDir, "session-1.json")
    await writeHints(filePath, [
      { text: "transient", pinned: false },
      { text: "pinned", pinned: true },
      { text: "also transient", pinned: false },
    ])

    const removed = await removeTransient(filePath)
    expect(removed).toBe(true)

    const result = await readHints(filePath)
    expect(result).toEqual([{ text: "pinned", pinned: true }])
  })

  test("returns false if all hints are pinned", async () => {
    const filePath = join(testDir, "session-1.json")
    await writeHints(filePath, [{ text: "pinned", pinned: true }])

    const removed = await removeTransient(filePath)
    expect(removed).toBe(false)

    const result = await readHints(filePath)
    expect(result).toEqual([{ text: "pinned", pinned: true }])
  })

  test("removes file when all hints are transient", async () => {
    const filePath = join(testDir, "session-1.json")
    await writeHints(filePath, [
      { text: "a", pinned: false },
      { text: "b", pinned: false },
    ])

    const removed = await removeTransient(filePath)
    expect(removed).toBe(true)
    expect(existsSync(filePath)).toBe(false)
  })

  test("returns false for empty/missing file", async () => {
    const filePath = join(testDir, "missing.json")
    const removed = await removeTransient(filePath)
    expect(removed).toBe(false)
  })
})

// ─── removeAt ────────────────────────────────────────────────────────

describe("removeAt", () => {
  let testDir: string

  beforeEach(() => {
    testDir = join(tmpdir(), `btw-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  test("removes hint at given index (0-based)", async () => {
    const filePath = join(testDir, "session-1.json")
    await writeHints(filePath, [
      { text: "first", pinned: false },
      { text: "second", pinned: true },
      { text: "third", pinned: false },
    ])

    const removed = await removeAt(filePath, 1)
    expect(removed).toEqual({ text: "second", pinned: true })

    const result = await readHints(filePath)
    expect(result).toEqual([
      { text: "first", pinned: false },
      { text: "third", pinned: false },
    ])
  })

  test("removes first hint at index 0", async () => {
    const filePath = join(testDir, "session-1.json")
    await writeHints(filePath, [
      { text: "first", pinned: false },
      { text: "second", pinned: true },
    ])

    const removed = await removeAt(filePath, 0)
    expect(removed).toEqual({ text: "first", pinned: false })

    const result = await readHints(filePath)
    expect(result).toEqual([{ text: "second", pinned: true }])
  })

  test("removes file when last remaining hint is removed", async () => {
    const filePath = join(testDir, "session-1.json")
    await writeHints(filePath, [{ text: "only", pinned: false }])

    const removed = await removeAt(filePath, 0)
    expect(removed).toEqual({ text: "only", pinned: false })
    expect(existsSync(filePath)).toBe(false)
  })

  test("returns null for out-of-bounds index", async () => {
    const filePath = join(testDir, "session-1.json")
    await writeHints(filePath, [{ text: "only", pinned: false }])

    const removed = await removeAt(filePath, 5)
    expect(removed).toBeNull()

    // Original hints should be unchanged
    const result = await readHints(filePath)
    expect(result).toEqual([{ text: "only", pinned: false }])
  })

  test("returns null for negative index", async () => {
    const filePath = join(testDir, "session-1.json")
    await writeHints(filePath, [{ text: "only", pinned: false }])

    const removed = await removeAt(filePath, -1)
    expect(removed).toBeNull()
  })

  test("returns null for empty/missing file", async () => {
    const removed = await removeAt(join(testDir, "missing.json"), 0)
    expect(removed).toBeNull()
  })
})

// ─── removeLast ──────────────────────────────────────────────────────

describe("removeLast", () => {
  let testDir: string

  beforeEach(() => {
    testDir = join(tmpdir(), `btw-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  test("removes and returns the last hint", async () => {
    const filePath = join(testDir, "session-1.json")
    await writeHints(filePath, [
      { text: "first", pinned: false },
      { text: "second", pinned: true },
    ])

    const removed = await removeLast(filePath)
    expect(removed).toEqual({ text: "second", pinned: true })

    const result = await readHints(filePath)
    expect(result).toEqual([{ text: "first", pinned: false }])
  })

  test("removes file when last hint is removed", async () => {
    const filePath = join(testDir, "session-1.json")
    await writeHints(filePath, [{ text: "only", pinned: false }])

    const removed = await removeLast(filePath)
    expect(removed).toEqual({ text: "only", pinned: false })
    expect(existsSync(filePath)).toBe(false)
  })

  test("returns null for empty/missing file", async () => {
    const filePath = join(testDir, "missing.json")
    const removed = await removeLast(filePath)
    expect(removed).toBeNull()
  })
})

// ─── ensureDir ───────────────────────────────────────────────────────

describe("ensureDir", () => {
  test("creates directory recursively", () => {
    const dir = join(
      tmpdir(),
      `btw-test-${Date.now()}`,
      "nested",
      "deep",
    )
    ensureDir(dir)
    expect(existsSync(dir)).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  test("is safe on existing directory", () => {
    const dir = join(tmpdir(), `btw-test-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    // Should not throw
    ensureDir(dir)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe("BTW_HELP", () => {
  test("contains key subcommands", () => {
    expect(BTW_HELP).toContain("/btw pin")
    expect(BTW_HELP).toContain("/btw clear")
    expect(BTW_HELP).toContain("/btw help")
  })

  test("contains debug subcommand", () => {
    expect(BTW_HELP).toContain("/btw debug")
  })
})

// ─── cancelCommand ──────────────────────────────────────────────────

describe("cancelCommand", () => {
  test("always throws (never resolves)", async () => {
    await expect(cancelCommand()).rejects.toThrow()
  })

  test("throws Error with BTW_HANDLED message", async () => {
    let thrown: Error | null = null
    try {
      await cancelCommand()
    } catch (e) {
      thrown = e as Error
    }

    expect(thrown).not.toBeNull()
    expect(thrown).toBeInstanceOf(Error)
    expect(thrown!.message).toBe(BTW_HANDLED)
  })
})

// ─── BTW_HANDLED sentinel ───────────────────────────────────────────

describe("BTW_HANDLED", () => {
  test("is a non-empty string", () => {
    expect(BTW_HANDLED).toBeTruthy()
    expect(typeof BTW_HANDLED).toBe("string")
  })
})

// ─── Debug Mode ────────────────────────────────────────────────────

describe("debugMarkerPath", () => {
  test("returns a path under ~/.cache/opencode/btw/", () => {
    const original = process.env.HOME
    process.env.HOME = "/mock/home"

    expect(debugMarkerPath()).toBe("/mock/home/.cache/opencode/btw/.debug")

    process.env.HOME = original
  })
})

describe("isDebugEnabled / toggleDebug", () => {
  let debugPath: string

  beforeEach(() => {
    // Use a temp directory to avoid polluting real debug state
    const tempDebugDir = join(tmpdir(), `btw-debug-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(tempDebugDir, { recursive: true })
    debugPath = join(tempDebugDir, ".debug")

    // Override HOME so debugMarkerPath() points to our temp dir
    process.env._BTW_ORIG_HOME = process.env.HOME
    process.env.HOME = join(tempDebugDir, "..")
    // We need the path to be exactly HOME/.cache/opencode/btw/.debug
    // So let's set up the directory structure
  })

  afterEach(() => {
    process.env.HOME = process.env._BTW_ORIG_HOME
    delete process.env._BTW_ORIG_HOME
    try {
      unlinkSync(debugPath)
    } catch {}
  })

  test("isDebugEnabled returns false when marker file doesn't exist", () => {
    // With our temp HOME, the .debug file won't exist
    expect(isDebugEnabled()).toBe(false)
  })

  test("toggleDebug creates marker file and returns true", async () => {
    // Set HOME so debugMarkerPath() resolves to a real temp path
    const tempDir = join(tmpdir(), `btw-debug-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    const cacheDir = join(tempDir, ".cache", "opencode", "btw")
    mkdirSync(cacheDir, { recursive: true })
    const origHome = process.env.HOME
    process.env.HOME = tempDir

    try {
      const result = await toggleDebug()
      expect(result).toBe(true)
      expect(existsSync(debugMarkerPath())).toBe(true)
    } finally {
      process.env.HOME = origHome
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test("toggleDebug disables when already enabled", async () => {
    const tempDir = join(tmpdir(), `btw-debug-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    const cacheDir = join(tempDir, ".cache", "opencode", "btw")
    mkdirSync(cacheDir, { recursive: true })
    const origHome = process.env.HOME
    process.env.HOME = tempDir

    try {
      // Enable first
      await toggleDebug()
      expect(isDebugEnabled()).toBe(true)

      // Toggle again to disable
      const result = await toggleDebug()
      expect(result).toBe(false)
      expect(isDebugEnabled()).toBe(false)
    } finally {
      process.env.HOME = origHome
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})

// ─── Config-Aware Behavior ──────────────────────────────────────────

describe("parseCommand with config", () => {
  test("uses defaultPinned from config when adding hints", () => {
    const config = { ...DEFAULT_CONFIG, defaultPinned: true }
    const result = parseCommand("my hint", config)
    expect(result).toEqual({ action: "set", text: "my hint", pinned: true })
  })

  test("defaults to transient when no config provided", () => {
    const result = parseCommand("my hint")
    expect(result).toEqual({ action: "set", text: "my hint", pinned: false })
  })

  test("explicit pin overrides defaultPinned=false", () => {
    const config = { ...DEFAULT_CONFIG, defaultPinned: false }
    const result = parseCommand("pin my hint", config)
    expect(result).toEqual({ action: "set", text: "my hint", pinned: true })
  })

  test("explicit pin still works with defaultPinned=true", () => {
    const config = { ...DEFAULT_CONFIG, defaultPinned: true }
    const result = parseCommand("pin my hint", config)
    expect(result).toEqual({ action: "set", text: "my hint", pinned: true })
  })
})

describe("buildSystemBlock with config", () => {
  test("uses custom systemInstructions from config", () => {
    const config: BtwConfig = {
      ...DEFAULT_CONFIG,
      injection: { ...DEFAULT_CONFIG.injection, systemInstructions: "Custom instructions here" },
    }
    const block = buildSystemBlock([{ text: "hint", pinned: false }], config)
    expect(block).toContain("Custom instructions here")
    expect(block).not.toContain("Active User Preferences")
  })

  test("uses default instructions when systemInstructions is null", () => {
    const config: BtwConfig = {
      ...DEFAULT_CONFIG,
      injection: { ...DEFAULT_CONFIG.injection, systemInstructions: null },
    }
    const block = buildSystemBlock([{ text: "hint", pinned: false }], config)
    expect(block).toContain("Active User Preferences")
  })

  test("uses default instructions when no config provided", () => {
    const block = buildSystemBlock([{ text: "hint", pinned: false }])
    expect(block).toContain("Active User Preferences")
  })
})

describe("buildUserHint with config", () => {
  test("uses custom userMessagePrefix from config", () => {
    const config: BtwConfig = {
      ...DEFAULT_CONFIG,
      injection: { ...DEFAULT_CONFIG.injection, userMessagePrefix: "Hey, " },
    }
    const result = buildUserHint([{ text: "use emojis", pinned: false }], config)
    expect(result).toBe("Hey, use emojis")
  })

  test("uses default prefix when no config provided", () => {
    const result = buildUserHint([{ text: "use emojis", pinned: false }])
    expect(result).toBe("BTW, use emojis")
  })

  test("multiple hints use config prefix for header", () => {
    const config: BtwConfig = {
      ...DEFAULT_CONFIG,
      injection: { ...DEFAULT_CONFIG.injection, userMessagePrefix: "Hey, " },
    }
    const result = buildUserHint(
      [{ text: "a", pinned: false }, { text: "b", pinned: false }],
      config,
    )
    expect(result).toContain("Hey:")
    expect(result).toContain("1. a")
    expect(result).toContain("2. b")
  })
})

describe("isDebugEnabled with config", () => {
  test("returns true when config.debug is true", () => {
    const config = { ...DEFAULT_CONFIG, debug: true }
    expect(isDebugEnabled(config)).toBe(true)
  })

  test("config.debug false overrides marker file", () => {
    const config = { ...DEFAULT_CONFIG, debug: false }
    // Config explicitly set to false takes priority over marker file
    expect(isDebugEnabled(config)).toBe(false)
  })
})

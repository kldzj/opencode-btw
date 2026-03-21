import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdirSync, rmSync, existsSync, readFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

import {
  type HintEntry,
  BTW_HANDLED,
  BTW_SYSTEM_INSTRUCTIONS,
  projectHash,
  btwDir,
  hintPath,
  readHints,
  writeHints,
  addHint,
  clearHints,
  removeTransient,
  removeLast,
  parseCommand,
  buildSystemBlock,
  ensureDir,
} from "./core"

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
    // "clear something" is not a recognized clear variant, it's a hint
    // Actually no — "clear" exact match vs longer. Let me check.
    // parseCommand trims, checks exact "clear" or "reset", then "clear last".
    // "clear something" would not match any of those, so it falls through to set.
    expect(parseCommand("clear something")).toEqual({
      action: "set",
      text: "clear something",
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
    expect(block).toContain(BTW_SYSTEM_INSTRUCTIONS)
  })

  test("wraps single hint in btw-active-hint tags", () => {
    const block = buildSystemBlock([{ text: "use Edit tool", pinned: false }])
    expect(block).toContain("<btw-active-hint>")
    expect(block).toContain("use Edit tool")
    expect(block).toContain("</btw-active-hint>")
  })

  test("renders multiple hints as separate blocks", () => {
    const block = buildSystemBlock([
      { text: "hint one", pinned: false },
      { text: "hint two", pinned: true },
    ])
    // Match opening tags with newline (not the mention in instructions)
    const matches = block.match(/<btw-active-hint>\n/g)
    expect(matches?.length).toBe(2)
    expect(block).toContain("hint one")
    expect(block).toContain("hint two")
  })

  test("includes system instructions only once for multiple hints", () => {
    const block = buildSystemBlock([
      { text: "a", pinned: false },
      { text: "b", pinned: false },
    ])
    const matches = block.match(/<btw-hint-system>/g)
    expect(matches?.length).toBe(1)
  })
})

describe("BTW_SYSTEM_INSTRUCTIONS", () => {
  test("contains key behavioral directives", () => {
    expect(BTW_SYSTEM_INSTRUCTIONS).toContain("high-priority instruction")
    expect(BTW_SYSTEM_INSTRUCTIONS).toContain("IMMEDIATELY")
    expect(BTW_SYSTEM_INSTRUCTIONS).toContain("behavioral correction")
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

// ─── BTW_HANDLED sentinel ───────────────────────────────────────────

describe("BTW_HANDLED", () => {
  test("is a non-empty string", () => {
    expect(BTW_HANDLED).toBeTruthy()
    expect(typeof BTW_HANDLED).toBe("string")
  })
})

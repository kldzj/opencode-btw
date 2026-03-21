import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdirSync, rmSync, existsSync, readFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

import {
  type HintData,
  BTW_HANDLED,
  BTW_SYSTEM_INSTRUCTIONS,
  projectHash,
  btwDir,
  hintPath,
  readHint,
  writeHint,
  clearHint,
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
  test('returns clear action for "clear"', () => {
    expect(parseCommand("clear")).toEqual({ action: "clear" })
  })

  test('returns clear action for "reset"', () => {
    expect(parseCommand("reset")).toEqual({ action: "clear" })
  })

  test("trims whitespace before matching", () => {
    expect(parseCommand("  clear  ")).toEqual({ action: "clear" })
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
})

// ─── System Prompt Construction ──────────────────────────────────────

describe("buildSystemBlock", () => {
  test("includes system instructions", () => {
    const block = buildSystemBlock({ text: "test hint", pinned: false })
    expect(block).toContain(BTW_SYSTEM_INSTRUCTIONS)
  })

  test("wraps hint in btw-active-hint tags", () => {
    const block = buildSystemBlock({ text: "use Edit tool", pinned: false })
    expect(block).toContain("<btw-active-hint>")
    expect(block).toContain("use Edit tool")
    expect(block).toContain("</btw-active-hint>")
  })

  test("includes the exact hint text", () => {
    const block = buildSystemBlock({
      text: "focus on src/auth.ts",
      pinned: true,
    })
    expect(block).toContain("focus on src/auth.ts")
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

  test("writeHint creates a JSON file", async () => {
    const filePath = join(testDir, "session-1.json")
    await writeHint(filePath, { text: "test hint", pinned: false })

    const raw = readFileSync(filePath, "utf-8")
    const data = JSON.parse(raw)
    expect(data).toEqual({ text: "test hint", pinned: false })
  })

  test("readHint reads back written data", async () => {
    const filePath = join(testDir, "session-1.json")
    await writeHint(filePath, { text: "hello", pinned: true })

    const result = await readHint(filePath)
    expect(result).toEqual({ text: "hello", pinned: true })
  })

  test("readHint returns null for non-existent file", async () => {
    const result = await readHint(join(testDir, "missing.json"))
    expect(result).toBeNull()
  })

  test("readHint returns null for invalid JSON", async () => {
    const filePath = join(testDir, "bad.json")
    await Bun.write(filePath, "not valid json{{{")

    const result = await readHint(filePath)
    expect(result).toBeNull()
  })

  test("readHint returns null for JSON without text field", async () => {
    const filePath = join(testDir, "empty.json")
    await Bun.write(filePath, JSON.stringify({ pinned: true }))

    const result = await readHint(filePath)
    expect(result).toBeNull()
  })

  test("readHint returns null for empty text", async () => {
    const filePath = join(testDir, "empty-text.json")
    await Bun.write(filePath, JSON.stringify({ text: "", pinned: false }))

    const result = await readHint(filePath)
    expect(result).toBeNull()
  })

  test("clearHint removes the file", async () => {
    const filePath = join(testDir, "session-1.json")
    await writeHint(filePath, { text: "test", pinned: false })
    expect(existsSync(filePath)).toBe(true)

    await clearHint(filePath)
    expect(existsSync(filePath)).toBe(false)
  })

  test("clearHint is safe on non-existent file", async () => {
    // Should not throw
    await clearHint(join(testDir, "missing.json"))
  })

  test("writeHint overwrites existing hint", async () => {
    const filePath = join(testDir, "session-1.json")
    await writeHint(filePath, { text: "first", pinned: false })
    await writeHint(filePath, { text: "second", pinned: true })

    const result = await readHint(filePath)
    expect(result).toEqual({ text: "second", pinned: true })
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

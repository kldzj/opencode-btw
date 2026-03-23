import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

import {
  type BtwConfig,
  type ConfigContext,
  type ConfigWarning,
  DEFAULT_CONFIG,
  DEFAULT_SYSTEM_INSTRUCTIONS,
  validateConfig,
  globalConfigPath,
  findProjectConfig,
  getConfig,
} from "./config"

// ─── Helpers ─────────────────────────────────────────────────────────

function makeTempDir(): string {
  const dir = join(tmpdir(), `btw-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function makeCtx(dir: string): ConfigContext {
  return {
    directory: dir,
    client: {
      tui: {
        showToast: async () => {},
      },
    },
  }
}

function writeJsonc(filePath: string, content: string): void {
  mkdirSync(join(filePath, ".."), { recursive: true })
  writeFileSync(filePath, content)
}

// ─── DEFAULT_CONFIG ──────────────────────────────────────────────────

describe("DEFAULT_CONFIG", () => {
  test("has expected default values", () => {
    expect(DEFAULT_CONFIG.defaultPinned).toBe(false)
    expect(DEFAULT_CONFIG.debug).toBe(false)
    expect(DEFAULT_CONFIG.toastDuration).toBe(3000)
    expect(DEFAULT_CONFIG.autoClear.onIdle).toBe(true)
    expect(DEFAULT_CONFIG.autoClear.onQuestionTool).toBe(true)
    expect(DEFAULT_CONFIG.injection.target).toBe("both")
    expect(DEFAULT_CONFIG.injection.systemPromptPosition).toBe("prepend")
    expect(DEFAULT_CONFIG.injection.systemInstructions).toBeNull()
    expect(DEFAULT_CONFIG.injection.userMessagePrefix).toBe("BTW, ")
  })

  test("is marked as Readonly (TypeScript-level constraint)", () => {
    // DEFAULT_CONFIG uses Readonly<BtwConfig> at the type level
    // Verify it's a plain object with expected shape
    expect(typeof DEFAULT_CONFIG).toBe("object")
    expect(DEFAULT_CONFIG).not.toBeNull()
  })
})

// ─── DEFAULT_SYSTEM_INSTRUCTIONS ────────────────────────────────────

describe("DEFAULT_SYSTEM_INSTRUCTIONS", () => {
  test("contains key behavioral directives", () => {
    expect(DEFAULT_SYSTEM_INSTRUCTIONS).toContain("user preferences")
    expect(DEFAULT_SYSTEM_INSTRUCTIONS).toContain("apply them naturally")
    expect(DEFAULT_SYSTEM_INSTRUCTIONS).toContain("corrects your approach")
  })
})

// ─── validateConfig ──────────────────────────────────────────────────

describe("validateConfig", () => {
  test("returns no warnings for valid empty config", () => {
    const warnings = validateConfig({})
    expect(warnings).toEqual([])
  })

  test("returns no warnings for valid full config", () => {
    const warnings = validateConfig({
      "$schema": "...",
      defaultPinned: true,
      debug: false,
      toastDuration: 5000,
      autoClear: { onIdle: false, onQuestionTool: true },
      injection: {
        target: "system",
        systemPromptPosition: "append",
        systemInstructions: "custom",
        userMessagePrefix: "Hey, ",
      },
    })
    expect(warnings).toEqual([])
  })

  // ── Unknown keys ──

  test("warns on unknown top-level keys", () => {
    const warnings = validateConfig({ foo: "bar", baz: 123 })
    expect(warnings).toHaveLength(2)
    expect(warnings[0]!.key).toBe("foo")
    expect(warnings[1]!.key).toBe("baz")
  })

  test("warns on unknown autoClear keys", () => {
    const warnings = validateConfig({ autoClear: { onIdle: true, unknown: false } })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]!.key).toBe("autoClear.unknown")
  })

  test("warns on unknown injection keys", () => {
    const warnings = validateConfig({ injection: { target: "both", extra: true } })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]!.key).toBe("injection.extra")
  })

  // ── Type checks ──

  test("warns when defaultPinned is not boolean", () => {
    const warnings = validateConfig({ defaultPinned: "yes" })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]!.key).toBe("defaultPinned")
    expect(warnings[0]!.message).toContain("Expected boolean")
  })

  test("warns when debug is not boolean", () => {
    const warnings = validateConfig({ debug: 1 })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]!.key).toBe("debug")
  })

  test("warns when toastDuration is not a number >= 100", () => {
    const w1 = validateConfig({ toastDuration: "fast" })
    expect(w1).toHaveLength(1)
    expect(w1[0]!.key).toBe("toastDuration")

    const w2 = validateConfig({ toastDuration: 0 })
    expect(w2).toHaveLength(1)

    const w3 = validateConfig({ toastDuration: -100 })
    expect(w3).toHaveLength(1)

    const w4 = validateConfig({ toastDuration: 50 })
    expect(w4).toHaveLength(1)

    // 100 is the minimum — should be valid
    const w5 = validateConfig({ toastDuration: 100 })
    expect(w5).toHaveLength(0)
  })

  test("warns when autoClear is not an object", () => {
    const warnings = validateConfig({ autoClear: "yes" })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]!.key).toBe("autoClear")
    expect(warnings[0]!.message).toBe("Expected an object")
  })

  test("warns when autoClear.onIdle is not boolean", () => {
    const warnings = validateConfig({ autoClear: { onIdle: "yes" } })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]!.key).toBe("autoClear.onIdle")
  })

  test("warns when injection is not an object", () => {
    const warnings = validateConfig({ injection: [1, 2] })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]!.key).toBe("injection")
    expect(warnings[0]!.message).toBe("Expected an object")
  })

  test("warns on invalid injection.target", () => {
    const warnings = validateConfig({ injection: { target: "nowhere" } })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]!.key).toBe("injection.target")
    expect(warnings[0]!.message).toContain('"both"')
  })

  test("warns on invalid injection.systemPromptPosition", () => {
    const warnings = validateConfig({ injection: { systemPromptPosition: "middle" } })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]!.key).toBe("injection.systemPromptPosition")
    expect(warnings[0]!.message).toContain('"prepend"')
  })

  test("warns when injection.systemInstructions is wrong type", () => {
    const warnings = validateConfig({ injection: { systemInstructions: 42 } })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]!.key).toBe("injection.systemInstructions")
  })

  test("allows injection.systemInstructions to be null", () => {
    const warnings = validateConfig({ injection: { systemInstructions: null } })
    expect(warnings).toEqual([])
  })

  test("warns when injection.userMessagePrefix is wrong type", () => {
    const warnings = validateConfig({ injection: { userMessagePrefix: 123 } })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]!.key).toBe("injection.userMessagePrefix")
  })
})

// ─── findProjectConfig ──────────────────────────────────────────────

describe("findProjectConfig", () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = makeTempDir()
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test("returns null when no project config exists", () => {
    expect(findProjectConfig(tempDir)).toBeNull()
  })

  test("finds .opencode/btw.jsonc in the start directory", () => {
    const configPath = join(tempDir, ".opencode", "btw.jsonc")
    writeJsonc(configPath, "{}")
    expect(findProjectConfig(tempDir)).toBe(configPath)
  })

  test("finds .opencode/btw.json in the start directory", () => {
    const configPath = join(tempDir, ".opencode", "btw.json")
    writeJsonc(configPath, "{}")
    expect(findProjectConfig(tempDir)).toBe(configPath)
  })

  test("prefers btw.jsonc over btw.json", () => {
    writeJsonc(join(tempDir, ".opencode", "btw.jsonc"), "{}")
    writeJsonc(join(tempDir, ".opencode", "btw.json"), "{}")
    expect(findProjectConfig(tempDir)).toBe(join(tempDir, ".opencode", "btw.jsonc"))
  })

  test("walks up the directory tree to find config", () => {
    const subDir = join(tempDir, "a", "b", "c")
    mkdirSync(subDir, { recursive: true })
    const configPath = join(tempDir, ".opencode", "btw.jsonc")
    writeJsonc(configPath, "{}")
    expect(findProjectConfig(subDir)).toBe(configPath)
  })
})

// ─── getConfig (integration) ────────────────────────────────────────

describe("getConfig", () => {
  let tempDir: string
  let origHome: string | undefined
  let origXdg: string | undefined

  beforeEach(() => {
    tempDir = makeTempDir()
    origHome = process.env.HOME
    origXdg = process.env.XDG_CONFIG_HOME
    // Point HOME to temp dir so global config goes there
    process.env.HOME = tempDir
    delete process.env.XDG_CONFIG_HOME
  })

  afterEach(() => {
    process.env.HOME = origHome
    if (origXdg !== undefined) {
      process.env.XDG_CONFIG_HOME = origXdg
    } else {
      delete process.env.XDG_CONFIG_HOME
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  test("returns defaults when no config files exist", () => {
    const projectDir = join(tempDir, "project")
    mkdirSync(projectDir, { recursive: true })
    const config = getConfig(makeCtx(projectDir))

    expect(config.defaultPinned).toBe(false)
    expect(config.debug).toBe(false)
    expect(config.toastDuration).toBe(3000)
    expect(config.autoClear.onIdle).toBe(true)
    expect(config.autoClear.onQuestionTool).toBe(true)
    expect(config.injection.target).toBe("both")
    expect(config.injection.systemPromptPosition).toBe("prepend")
    expect(config.injection.systemInstructions).toBeNull()
    expect(config.injection.userMessagePrefix).toBe("BTW, ")
  })

  test("auto-creates global config with $schema", () => {
    const projectDir = join(tempDir, "project")
    mkdirSync(projectDir, { recursive: true })
    getConfig(makeCtx(projectDir))

    const globalPath = join(tempDir, ".config", "opencode", "btw.jsonc")
    expect(existsSync(globalPath)).toBe(true)
    const content = readFileSync(globalPath, "utf-8")
    expect(content).toContain("$schema")
    expect(content).toContain("opencode-btw")
  })

  test("does not overwrite existing global config", () => {
    const globalPath = join(tempDir, ".config", "opencode", "btw.jsonc")
    writeJsonc(globalPath, '{\n  "debug": true\n}\n')

    const projectDir = join(tempDir, "project")
    mkdirSync(projectDir, { recursive: true })
    const config = getConfig(makeCtx(projectDir))

    expect(config.debug).toBe(true)
    const content = readFileSync(globalPath, "utf-8")
    expect(content).not.toContain("$schema")
  })

  test("merges global config with defaults", () => {
    const globalPath = join(tempDir, ".config", "opencode", "btw.jsonc")
    writeJsonc(globalPath, JSON.stringify({
      defaultPinned: true,
      toastDuration: 5000,
    }))

    const projectDir = join(tempDir, "project")
    mkdirSync(projectDir, { recursive: true })
    const config = getConfig(makeCtx(projectDir))

    expect(config.defaultPinned).toBe(true)
    expect(config.toastDuration).toBe(5000)
    // Other values should remain defaults
    expect(config.debug).toBe(false)
    expect(config.autoClear.onIdle).toBe(true)
  })

  test("project config overrides global config", () => {
    const globalPath = join(tempDir, ".config", "opencode", "btw.jsonc")
    writeJsonc(globalPath, JSON.stringify({
      defaultPinned: true,
      debug: true,
    }))

    const projectDir = join(tempDir, "project")
    const projectConfig = join(projectDir, ".opencode", "btw.jsonc")
    writeJsonc(projectConfig, JSON.stringify({
      defaultPinned: false,  // Override global
    }))

    const config = getConfig(makeCtx(projectDir))
    expect(config.defaultPinned).toBe(false) // project override
    expect(config.debug).toBe(true) // from global, not overridden
  })

  test("merges nested autoClear config", () => {
    const globalPath = join(tempDir, ".config", "opencode", "btw.jsonc")
    writeJsonc(globalPath, JSON.stringify({
      autoClear: { onIdle: false },
    }))

    const projectDir = join(tempDir, "project")
    mkdirSync(projectDir, { recursive: true })
    const config = getConfig(makeCtx(projectDir))

    expect(config.autoClear.onIdle).toBe(false)
    expect(config.autoClear.onQuestionTool).toBe(true) // default preserved
  })

  test("merges nested injection config", () => {
    const globalPath = join(tempDir, ".config", "opencode", "btw.jsonc")
    writeJsonc(globalPath, JSON.stringify({
      injection: {
        target: "system",
        userMessagePrefix: "FYI, ",
      },
    }))

    const projectDir = join(tempDir, "project")
    mkdirSync(projectDir, { recursive: true })
    const config = getConfig(makeCtx(projectDir))

    expect(config.injection.target).toBe("system")
    expect(config.injection.userMessagePrefix).toBe("FYI, ")
    expect(config.injection.systemPromptPosition).toBe("prepend") // default preserved
  })

  test("handles JSONC comments and trailing commas", () => {
    const globalPath = join(tempDir, ".config", "opencode", "btw.jsonc")
    writeJsonc(globalPath, `{
  // This is a comment
  "debug": true,
  "toastDuration": 4000, // trailing comma ok
}`)

    const projectDir = join(tempDir, "project")
    mkdirSync(projectDir, { recursive: true })
    const config = getConfig(makeCtx(projectDir))

    expect(config.debug).toBe(true)
    expect(config.toastDuration).toBe(4000)
  })

  test("ignores invalid config files gracefully", () => {
    const globalPath = join(tempDir, ".config", "opencode", "btw.jsonc")
    writeJsonc(globalPath, "this is not valid json {{{")

    const projectDir = join(tempDir, "project")
    mkdirSync(projectDir, { recursive: true })
    const config = getConfig(makeCtx(projectDir))

    // Should fall back to all defaults
    expect(config).toEqual(DEFAULT_CONFIG)
  })

  test("ignores non-object config files", () => {
    const globalPath = join(tempDir, ".config", "opencode", "btw.jsonc")
    writeJsonc(globalPath, '"just a string"')

    const projectDir = join(tempDir, "project")
    mkdirSync(projectDir, { recursive: true })
    const config = getConfig(makeCtx(projectDir))

    expect(config).toEqual(DEFAULT_CONFIG)
  })

  test("ignores invalid field values but keeps valid ones", () => {
    const globalPath = join(tempDir, ".config", "opencode", "btw.jsonc")
    writeJsonc(globalPath, JSON.stringify({
      debug: true,         // valid
      toastDuration: -1,   // invalid (< 100) — should be ignored
    }))

    const projectDir = join(tempDir, "project")
    mkdirSync(projectDir, { recursive: true })
    const config = getConfig(makeCtx(projectDir))

    expect(config.debug).toBe(true)
    expect(config.toastDuration).toBe(3000) // default, invalid value ignored
  })

  test("respects XDG_CONFIG_HOME for global config", () => {
    const xdgDir = join(tempDir, "custom-xdg")
    process.env.XDG_CONFIG_HOME = xdgDir

    const globalPath = join(xdgDir, "opencode", "btw.jsonc")
    writeJsonc(globalPath, JSON.stringify({ debug: true }))

    const projectDir = join(tempDir, "project")
    mkdirSync(projectDir, { recursive: true })
    const config = getConfig(makeCtx(projectDir))

    expect(config.debug).toBe(true)
  })

  test("returns independent config objects (no shared references)", () => {
    const projectDir = join(tempDir, "project")
    mkdirSync(projectDir, { recursive: true })

    const config1 = getConfig(makeCtx(projectDir))
    const config2 = getConfig(makeCtx(projectDir))

    config1.autoClear.onIdle = false
    expect(config2.autoClear.onIdle).toBe(true) // should not be affected
  })

  test("empty config files return defaults", () => {
    const globalPath = join(tempDir, ".config", "opencode", "btw.jsonc")
    writeJsonc(globalPath, "")

    const projectDir = join(tempDir, "project")
    mkdirSync(projectDir, { recursive: true })
    const config = getConfig(makeCtx(projectDir))

    expect(config).toEqual(DEFAULT_CONFIG)
  })

  test("handles injection target enum values correctly", () => {
    for (const target of ["both", "system", "user"] as const) {
      const globalPath = join(tempDir, ".config", "opencode", "btw.jsonc")
      writeJsonc(globalPath, JSON.stringify({ injection: { target } }))

      const projectDir = join(tempDir, "project")
      mkdirSync(projectDir, { recursive: true })
      const config = getConfig(makeCtx(projectDir))
      expect(config.injection.target).toBe(target)
    }
  })

  test("handles systemPromptPosition enum values correctly", () => {
    for (const pos of ["prepend", "append"] as const) {
      const globalPath = join(tempDir, ".config", "opencode", "btw.jsonc")
      writeJsonc(globalPath, JSON.stringify({ injection: { systemPromptPosition: pos } }))

      const projectDir = join(tempDir, "project")
      mkdirSync(projectDir, { recursive: true })
      const config = getConfig(makeCtx(projectDir))
      expect(config.injection.systemPromptPosition).toBe(pos)
    }
  })

  test("ignores invalid injection.target values", () => {
    const globalPath = join(tempDir, ".config", "opencode", "btw.jsonc")
    writeJsonc(globalPath, JSON.stringify({ injection: { target: "nowhere" } }))

    const projectDir = join(tempDir, "project")
    mkdirSync(projectDir, { recursive: true })
    const config = getConfig(makeCtx(projectDir))

    expect(config.injection.target).toBe("both") // default
  })
})

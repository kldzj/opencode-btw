import { parse } from "jsonc-parser"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { homedir } from "os"
import { dirname, join, resolve } from "path"

// ─── Types ───────────────────────────────────────────────────────────

export type InjectionTarget = "both" | "system" | "user"
export type SystemPromptPosition = "prepend" | "append"

export interface AutoClearConfig {
  /** Auto-clear transient hints when the session goes idle */
  onIdle: boolean
  /** Auto-clear transient hints when the question tool fires */
  onQuestionTool: boolean
}

export interface InjectionConfig {
  /** Where to inject hints: system prompt, user message, or both */
  target: InjectionTarget
  /** System prompt injection position */
  systemPromptPosition: SystemPromptPosition
  /** Custom system prompt framing text (replaces the default BTW_SYSTEM_INSTRUCTIONS) */
  systemInstructions: string | null
  /** Prefix for user message hint injection (default: "BTW, ") */
  userMessagePrefix: string
}

export interface BtwConfig {
  /** Whether newly added hints are pinned by default */
  defaultPinned: boolean
  /** Auto-clear behavior for transient hints */
  autoClear: AutoClearConfig
  /** Hint injection behavior */
  injection: InjectionConfig
  /** Enable debug mode by default */
  debug: boolean
  /** Default toast notification duration in milliseconds */
  toastDuration: number
}

// ─── Defaults ────────────────────────────────────────────────────────

export const DEFAULT_SYSTEM_INSTRUCTIONS = `## Active User Preferences

This environment supports real-time user preferences via the /btw command.
When preferences are listed below, apply them naturally to your work:

- Each preference reflects the user's current intent and working style
- Apply preferences consistently across all actions and responses
- If a preference corrects your approach (e.g. "use Edit instead of sed"), adjust accordingly
- If a preference asks a question, answer it in your response
- If a preference changes your current direction, adapt smoothly
- Preferences remain active until the user removes them
- If a preference specifies files or areas to focus on, prioritize those`

export const DEFAULT_CONFIG: Readonly<BtwConfig> = {
  defaultPinned: false,
  autoClear: {
    onIdle: true,
    onQuestionTool: true,
  },
  injection: {
    target: "both",
    systemPromptPosition: "prepend",
    systemInstructions: null,
    userMessagePrefix: "BTW, ",
  },
  debug: false,
  toastDuration: 3000,
}

// ─── Schema reference ────────────────────────────────────────────────

const SCHEMA_URL =
  "https://raw.githubusercontent.com/kldzj/opencode-btw/main/btw.schema.json"

// ─── Config paths ────────────────────────────────────────────────────

function globalConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  return xdg ? join(xdg, "opencode") : join(process.env.HOME ?? homedir(), ".config", "opencode")
}

export function globalConfigPath(): string {
  return join(globalConfigDir(), "btw.jsonc")
}

/**
 * Walk up from `startDir` looking for `.opencode/btw.jsonc` or `.opencode/btw.json`.
 * Returns the first match, or null if none found.
 */
export function findProjectConfig(startDir: string): string | null {
  let dir = resolve(startDir)
  let depth = 0

  while (depth++ < 100) {
    for (const name of ["btw.jsonc", "btw.json"]) {
      const candidate = join(dir, ".opencode", name)
      if (existsSync(candidate)) return candidate
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

// ─── File loading ────────────────────────────────────────────────────

interface LoadResult {
  data: Record<string, unknown> | null
  parseError: string | null
}

function loadConfigFile(filePath: string): LoadResult {
  try {
    if (!existsSync(filePath)) return { data: null, parseError: null }

    const content = readFileSync(filePath, "utf-8")
    if (!content.trim()) return { data: null, parseError: null }

    const parsed = parse(content, undefined, { allowTrailingComma: true })
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { data: null, parseError: `Expected a JSON object in ${filePath}` }
    }
    return { data: parsed as Record<string, unknown>, parseError: null }
  } catch (err) {
    return { data: null, parseError: `Failed to read ${filePath}: ${err}` }
  }
}

// ─── Auto-create global config ──────────────────────────────────────

function ensureGlobalConfig(): void {
  const configPath = globalConfigPath()
  if (existsSync(configPath)) return

  // Also check for .json variant
  const jsonVariant = configPath.replace(/\.jsonc$/, ".json")
  if (existsSync(jsonVariant)) return

  try {
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(
      configPath,
      `{\n  "$schema": "${SCHEMA_URL}"\n}\n`,
    )
  } catch {
    // Non-critical — user can create it manually
  }
}

// ─── Deep clone ──────────────────────────────────────────────────────

function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj))
}

// ─── Merge ───────────────────────────────────────────────────────────

function mergeAutoClear(base: AutoClearConfig, override: Record<string, unknown>): AutoClearConfig {
  return {
    onIdle: typeof override.onIdle === "boolean" ? override.onIdle : base.onIdle,
    onQuestionTool:
      typeof override.onQuestionTool === "boolean" ? override.onQuestionTool : base.onQuestionTool,
  }
}

function mergeInjection(base: InjectionConfig, override: Record<string, unknown>): InjectionConfig {
  return {
    target: isInjectionTarget(override.target) ? override.target : base.target,
    systemPromptPosition: isSystemPromptPosition(override.systemPromptPosition)
      ? override.systemPromptPosition
      : base.systemPromptPosition,
    systemInstructions:
      override.systemInstructions === null
        ? null
        : typeof override.systemInstructions === "string"
          ? override.systemInstructions
          : base.systemInstructions,
    userMessagePrefix:
      typeof override.userMessagePrefix === "string"
        ? override.userMessagePrefix
        : base.userMessagePrefix,
  }
}

function mergeLayer(base: BtwConfig, override: Record<string, unknown>): BtwConfig {
  return {
    defaultPinned:
      typeof override.defaultPinned === "boolean" ? override.defaultPinned : base.defaultPinned,
    autoClear:
      override.autoClear && typeof override.autoClear === "object" && !Array.isArray(override.autoClear)
        ? mergeAutoClear(base.autoClear, override.autoClear as Record<string, unknown>)
        : base.autoClear,
    injection:
      override.injection && typeof override.injection === "object" && !Array.isArray(override.injection)
        ? mergeInjection(base.injection, override.injection as Record<string, unknown>)
        : base.injection,
    debug: typeof override.debug === "boolean" ? override.debug : base.debug,
    toastDuration:
      typeof override.toastDuration === "number" && override.toastDuration >= 100
        ? override.toastDuration
        : base.toastDuration,
  }
}

// ─── Type guards ─────────────────────────────────────────────────────

function isInjectionTarget(v: unknown): v is InjectionTarget {
  return v === "both" || v === "system" || v === "user"
}

function isSystemPromptPosition(v: unknown): v is SystemPromptPosition {
  return v === "prepend" || v === "append"
}

// ─── Validation ──────────────────────────────────────────────────────

const VALID_TOP_KEYS = new Set([
  "$schema",
  "defaultPinned",
  "autoClear",
  "injection",
  "debug",
  "toastDuration",
])

const VALID_AUTO_CLEAR_KEYS = new Set(["onIdle", "onQuestionTool"])

const VALID_INJECTION_KEYS = new Set([
  "target",
  "systemPromptPosition",
  "systemInstructions",
  "userMessagePrefix",
])

export interface ConfigWarning {
  key: string
  message: string
}

export function validateConfig(data: Record<string, unknown>): ConfigWarning[] {
  const warnings: ConfigWarning[] = []

  // Check unknown top-level keys
  for (const key of Object.keys(data)) {
    if (!VALID_TOP_KEYS.has(key)) {
      warnings.push({ key, message: `Unknown config key "${key}"` })
    }
  }

  // Type checks
  if ("defaultPinned" in data && typeof data.defaultPinned !== "boolean") {
    warnings.push({ key: "defaultPinned", message: `Expected boolean, got ${typeof data.defaultPinned}` })
  }

  if ("debug" in data && typeof data.debug !== "boolean") {
    warnings.push({ key: "debug", message: `Expected boolean, got ${typeof data.debug}` })
  }

  if ("toastDuration" in data) {
    if (typeof data.toastDuration !== "number" || data.toastDuration < 100) {
      warnings.push({
        key: "toastDuration",
        message: `Expected number >= 100, got ${JSON.stringify(data.toastDuration)}`,
      })
    }
  }

  // autoClear validation
  if ("autoClear" in data) {
    const ac = data.autoClear
    if (ac && typeof ac === "object" && !Array.isArray(ac)) {
      const acObj = ac as Record<string, unknown>
      for (const key of Object.keys(acObj)) {
        if (!VALID_AUTO_CLEAR_KEYS.has(key)) {
          warnings.push({ key: `autoClear.${key}`, message: `Unknown config key "autoClear.${key}"` })
        }
      }
      if ("onIdle" in acObj && typeof acObj.onIdle !== "boolean") {
        warnings.push({ key: "autoClear.onIdle", message: `Expected boolean, got ${typeof acObj.onIdle}` })
      }
      if ("onQuestionTool" in acObj && typeof acObj.onQuestionTool !== "boolean") {
        warnings.push({
          key: "autoClear.onQuestionTool",
          message: `Expected boolean, got ${typeof acObj.onQuestionTool}`,
        })
      }
    } else {
      warnings.push({ key: "autoClear", message: "Expected an object" })
    }
  }

  // injection validation
  if ("injection" in data) {
    const inj = data.injection
    if (inj && typeof inj === "object" && !Array.isArray(inj)) {
      const injObj = inj as Record<string, unknown>
      for (const key of Object.keys(injObj)) {
        if (!VALID_INJECTION_KEYS.has(key)) {
          warnings.push({ key: `injection.${key}`, message: `Unknown config key "injection.${key}"` })
        }
      }
      if ("target" in injObj && !isInjectionTarget(injObj.target)) {
        warnings.push({
          key: "injection.target",
          message: `Expected "both", "system", or "user", got ${JSON.stringify(injObj.target)}`,
        })
      }
      if ("systemPromptPosition" in injObj && !isSystemPromptPosition(injObj.systemPromptPosition)) {
        warnings.push({
          key: "injection.systemPromptPosition",
          message: `Expected "prepend" or "append", got ${JSON.stringify(injObj.systemPromptPosition)}`,
        })
      }
      if (
        "systemInstructions" in injObj &&
        injObj.systemInstructions !== null &&
        typeof injObj.systemInstructions !== "string"
      ) {
        warnings.push({
          key: "injection.systemInstructions",
          message: `Expected string or null, got ${typeof injObj.systemInstructions}`,
        })
      }
      if ("userMessagePrefix" in injObj && typeof injObj.userMessagePrefix !== "string") {
        warnings.push({
          key: "injection.userMessagePrefix",
          message: `Expected string, got ${typeof injObj.userMessagePrefix}`,
        })
      }
    } else {
      warnings.push({ key: "injection", message: "Expected an object" })
    }
  }

  return warnings
}

// ─── Main entry point ────────────────────────────────────────────────

export interface ConfigContext {
  directory: string
  client: {
    tui: {
      showToast: (opts: { body: { message: string; variant: string; duration: number } }) => Promise<void>
    }
  }
}

export function getConfig(ctx: ConfigContext): BtwConfig {
  let config = deepClone(DEFAULT_CONFIG) as BtwConfig

  ensureGlobalConfig()

  const layers: Array<{ path: string | null; name: string }> = [
    { path: globalConfigPath(), name: "global" },
    { path: findProjectConfig(ctx.directory), name: "project" },
  ]

  // Also check .json variants for global
  const globalJson = globalConfigPath().replace(/\.jsonc$/, ".json")
  if (!existsSync(globalConfigPath()) && existsSync(globalJson)) {
    layers[0] = { path: globalJson, name: "global" }
  }

  for (const layer of layers) {
    if (!layer.path) continue
    const result = loadConfigFile(layer.path)

    if (result.parseError) {
      scheduleWarning(ctx, `[btw] Config parse error in ${layer.name} config: ${result.parseError}`)
      continue
    }

    if (!result.data) continue

    const warnings = validateConfig(result.data)
    for (const w of warnings) {
      scheduleWarning(ctx, `[btw] ${layer.name} config: ${w.message}`)
    }

    config = mergeLayer(config, result.data)
  }

  return config
}

// ─── Scheduled warnings ─────────────────────────────────────────────

function scheduleWarning(ctx: ConfigContext, message: string): void {
  // Delay warnings so they don't fire during plugin initialization
  setTimeout(async () => {
    try {
      await ctx.client.tui.showToast({
        body: { message, variant: "info", duration: 7000 },
      })
    } catch {}
  }, 5000)
}

import { createHash } from "crypto"
import { existsSync, mkdirSync, unlinkSync } from "fs"

export interface HintEntry {
  text: string
  pinned: boolean
}

export interface HintFile {
  hints: HintEntry[]
}

export type ParsedCommand =
  | { action: "clear"; which: "all" | "last" | number }
  | { action: "status" }
  | { action: "help" }
  | { action: "debug" }
  | { action: "set"; text: string; pinned: boolean }
  | { action: "error"; message: string }

export const BTW_HANDLED = "__BTW_HANDLED__"

// Throws to prevent the LLM call after a /btw command.
// See https://github.com/anomalyco/opencode/issues/9306
export async function cancelCommand(): Promise<never> {
  throw new Error(BTW_HANDLED)
}

export const BTW_HELP = `[btw] Usage:
  /btw <hint>          Add a transient hint (auto-clears after model turn)
  /btw pin <hint>      Add a persistent hint (stays until cleared)
  /btw clear           Remove all hints
  /btw clear last      Remove the most recently added hint
  /btw clear <N>       Remove hint #N
  /btw                 Show all active hints
  /btw debug           Toggle debug mode (verbose toast logging)
  /btw help            Show this help message`

export const BTW_SYSTEM_INSTRUCTIONS = `## Active User Preferences

This environment supports real-time user preferences via the /btw command.
When preferences are listed below, apply them naturally to your work:

- Each preference reflects the user's current intent and working style
- Apply preferences consistently across all actions and responses
- If a preference corrects your approach (e.g. "use Edit instead of sed"), adjust accordingly
- If a preference asks a question, answer it in your response
- If a preference changes your current direction, adapt smoothly
- Preferences remain active until the user removes them
- If a preference specifies files or areas to focus on, prioritize those`

export function projectHash(directory: string): string {
  return createHash("md5").update(directory).digest("hex").slice(0, 12)
}

export function btwDir(directory: string): string {
  return `${process.env.HOME}/.cache/opencode/btw/${projectHash(directory)}`
}

export function hintPath(dir: string, sessionID: string): string {
  return `${dir}/${sessionID}.json`
}

export function ensureDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true })
  } catch {}
}

// ─── Debug Mode ──────────────────────────────────────────────────────

export function debugMarkerPath(): string {
  return `${process.env.HOME}/.cache/opencode/btw/.debug`
}

export function isDebugEnabled(): boolean {
  try {
    return existsSync(debugMarkerPath())
  } catch {
    return false
  }
}

export async function toggleDebug(): Promise<boolean> {
  const enabled = isDebugEnabled()
  if (enabled) {
    try {
      unlinkSync(debugMarkerPath())
    } catch {}
    return false
  } else {
    ensureDir(`${process.env.HOME}/.cache/opencode/btw`)
    await Bun.write(debugMarkerPath(), "")
    return true
  }
}

export async function readHints(filePath: string): Promise<HintEntry[]> {
  try {
    const file = Bun.file(filePath)
    if (await file.exists()) {
      const data = await file.json()
      // Handle new array format
      if (Array.isArray(data?.hints) && data.hints.length > 0) {
        return data.hints as HintEntry[]
      }
      // Handle legacy single-hint format
      if (data?.text) {
        return [{ text: data.text, pinned: data.pinned ?? false }]
      }
    }
  } catch {}
  return []
}

export async function writeHints(
  filePath: string,
  hints: HintEntry[],
): Promise<void> {
  if (hints.length === 0) {
    await clearHints(filePath)
    return
  }
  await Bun.write(filePath, JSON.stringify({ hints } satisfies HintFile))
}

export async function addHint(
  filePath: string,
  entry: HintEntry,
): Promise<void> {
  const existing = await readHints(filePath)
  existing.push(entry)
  await writeHints(filePath, existing)
}

export async function clearHints(filePath: string): Promise<void> {
  try {
    unlinkSync(filePath)
  } catch {}
}

export async function removeTransient(filePath: string): Promise<boolean> {
  const hints = await readHints(filePath)
  const pinned = hints.filter((h) => h.pinned)
  if (pinned.length === hints.length) return false // nothing removed
  await writeHints(filePath, pinned)
  return true
}

export async function removeLast(filePath: string): Promise<HintEntry | null> {
  const hints = await readHints(filePath)
  if (hints.length === 0) return null
  const removed = hints.pop()!
  await writeHints(filePath, hints)
  return removed
}

export async function removeAt(
  filePath: string,
  index: number,
): Promise<HintEntry | null> {
  const hints = await readHints(filePath)
  if (index < 0 || index >= hints.length) return null
  const [removed] = hints.splice(index, 1)
  await writeHints(filePath, hints)
  return removed
}

export function parseCommand(rawArgs: string): ParsedCommand {
  const args = rawArgs.trim()

  if (args === "clear" || args === "reset") {
    return { action: "clear", which: "all" }
  }

  if (args === "help") {
    return { action: "help" }
  }

  if (args === "debug") {
    return { action: "debug" }
  }

  if (args === "clear last") {
    return { action: "clear", which: "last" }
  }

  const clearNumMatch = args.match(/^clear\s+(\d+)$/)
  if (clearNumMatch) {
    const num = parseInt(clearNumMatch[1], 10)
    if (num < 1) {
      return { action: "error", message: "Hint numbers start at 1" }
    }
    return { action: "clear", which: num }
  }

  if (!args) {
    return { action: "status" }
  }

  if (args === "pin" || args.startsWith("pin ")) {
    const text = args.slice(3).trim()
    if (!text) {
      return { action: "error", message: "Usage: /btw pin <hint>" }
    }
    return { action: "set", text, pinned: true }
  }

  return { action: "set", text: args, pinned: false }
}

export function buildSystemBlock(hints: HintEntry[]): string {
  if (hints.length === 0) return ""
  const hintList = hints
    .map((h, i) => hints.length === 1 ? h.text : `${i + 1}. ${h.text}`)
    .join("\n")
  return [BTW_SYSTEM_INSTRUCTIONS, "", "### Current Preferences", hintList].join("\n")
}

export function buildUserHint(hints: HintEntry[]): string {
  if (hints.length === 0) return ""
  if (hints.length === 1) return `BTW, ${hints[0].text}`
  return `BTW:\n${hints.map((h, i) => `${i + 1}. ${h.text}`).join("\n")}`
}

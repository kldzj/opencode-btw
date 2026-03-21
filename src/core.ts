import { createHash } from "crypto"
import { mkdirSync, unlinkSync } from "fs"

export interface HintEntry {
  text: string
  pinned: boolean
}

export interface HintFile {
  hints: HintEntry[]
}

export type ParsedCommand =
  | { action: "clear"; which: "all" | "last" }
  | { action: "status" }
  | { action: "set"; text: string; pinned: boolean }
  | { action: "error"; message: string }

export const BTW_HANDLED = "__BTW_HANDLED__"

export const BTW_SYSTEM_INSTRUCTIONS = `<btw-hint-system>
The user may inject real-time hints via the /btw command. These hints appear below as <btw-active-hint> blocks.
When a hint is present:
- Treat it as a direct, high-priority instruction from the user — equivalent to them telling you something face-to-face
- Apply it IMMEDIATELY to your current and future actions — do not wait for a "good moment"
- If the hint is a behavioral correction (e.g. "use Edit instead of sed"), adjust silently without calling attention to the change
- If the hint is a direct request or question (e.g. "explain what you're doing"), respond to it naturally
- If the hint contradicts your current approach, change course
- The hint persists until the user clears it — apply it to every action, not just the next one
- If the hint says to focus on specific files/areas, prioritize those and deprioritize others
</btw-hint-system>`

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

export function parseCommand(rawArgs: string): ParsedCommand {
  const args = rawArgs.trim()

  if (args === "clear" || args === "reset") {
    return { action: "clear", which: "all" }
  }

  if (args === "clear last") {
    return { action: "clear", which: "last" }
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
  const hintBlocks = hints
    .map((h) => `<btw-active-hint>\n${h.text}\n</btw-active-hint>`)
    .join("\n\n")
  return [BTW_SYSTEM_INSTRUCTIONS, "", hintBlocks].join("\n")
}

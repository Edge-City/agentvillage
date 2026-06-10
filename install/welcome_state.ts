import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const WELCOME_STATE_RELATIVE_PATH = join("memory", "welcome-state.json");

export interface WelcomeStateSnapshot {
  path: string;
  content: string;
  suppressesWelcome: boolean;
}

/** Return true when marker content should suppress the first-install welcome. */
export function recordsWelcomeSent(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as { welcomeSent?: unknown };
    return parsed.welcomeSent === true;
  } catch {
    return false;
  }
}

/** Capture the local welcome marker before installer/update work can touch it. */
export function captureWelcomeState(targetHome: string): WelcomeStateSnapshot | null {
  const markerPath = join(targetHome, WELCOME_STATE_RELATIVE_PATH);
  if (!existsSync(markerPath)) return null;

  try {
    const content = readFileSync(markerPath, "utf8");
    return {
      path: markerPath,
      content,
      suppressesWelcome: recordsWelcomeSent(content),
    };
  } catch {
    console.warn(`  warning: could not read ${WELCOME_STATE_RELATIVE_PATH} before update`);
    return null;
  }
}

/**
 * Restore a captured welcome marker if a normal install/update deleted it, or
 * repair clobbered content when the previous marker suppressed the welcome.
 */
export function restoreWelcomeState(snapshot: WelcomeStateSnapshot | null): boolean {
  if (!snapshot) return false;

  let shouldRestore = !existsSync(snapshot.path);
  if (!shouldRestore && snapshot.suppressesWelcome) {
    try {
      const current = readFileSync(snapshot.path, "utf8");
      shouldRestore = !recordsWelcomeSent(current);
    } catch {
      shouldRestore = true;
    }
  }

  if (!shouldRestore) return false;

  try {
    mkdirSync(dirname(snapshot.path), { recursive: true });
    writeFileSync(snapshot.path, snapshot.content);
    console.log(`→ restored ${WELCOME_STATE_RELATIVE_PATH} after update`);
    return true;
  } catch {
    console.warn(`  warning: could not restore ${WELCOME_STATE_RELATIVE_PATH} after update`);
    return false;
  }
}

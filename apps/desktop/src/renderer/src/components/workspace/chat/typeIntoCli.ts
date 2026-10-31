import { terminalRuntime } from '@/lib/terminal/terminalRuntime';

/** Gives the CLI a moment to take the paste in before Enter submits it, as Relay does. */
export const SUBMIT_DELAY_MS = 150;

/**
 * Pastes text into the CLI running under a chat tab and submits it, exactly as if it had been
 * typed there. False when the CLI isn't waiting for input yet, and nothing was typed.
 */
export function typeIntoCli(sessionId: string, text: string): boolean {
  if (!terminalRuntime.insertText(sessionId, text)) return false;
  setTimeout(() => void window.runova.terminal.write(sessionId, '\r'), SUBMIT_DELAY_MS);
  return true;
}

import { Effect } from "effect";

/**
 * Best-effort OS notification for an alert crossing: `osascript` on macOS,
 * `notify-send` on Linux. Never fails the caller — a
 * missing binary or a failed spawn just means no popup fired; the in-TUI alert
 * coloring is the ground truth either way, so callers fork this and move on
 * rather than waiting on or reacting to its result.
 */

/** Escape `"` and `\` so `text` embeds safely inside an AppleScript string literal. */
export const escapeAppleScript = (text: string): string =>
  text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

export const sendNotification = (title: string, message: string): Effect.Effect<void> =>
  Effect.tryPromise(() => {
    if (process.platform === "darwin") {
      const script = `display notification "${escapeAppleScript(message)}" with title "${escapeAppleScript(title)}"`;
      // `${script}` is one auto-escaped shell argument to `-e` — safe regardless
      // of `message`/`title` content; the AppleScript-level escaping above keeps
      // the *script text itself* well-formed.
      return Bun.$`osascript -e ${script}`.quiet();
    }
    return Bun.$`notify-send ${title} ${message}`.quiet();
  }).pipe(Effect.catchAll(() => Effect.void));

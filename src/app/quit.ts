import type { CliRenderer } from "@opentui/core";
import { Effect } from "effect";

/** The parsed-key fields we need to decide whether a keypress quits. */
export interface QuitKey {
  readonly name: string;
  readonly ctrl: boolean;
}

/**
 * Whether a parsed keypress should quit the app: `q`, or Ctrl+C.
 *
 * Matching the *parsed* key (`name`/`ctrl`) rather than raw bytes is what makes
 * this hold under the Kitty keyboard protocol, which encodes Ctrl+C as a CSI-u
 * escape (e.g. `\x1b[99;5u`) rather than a bare `\x03`. The renderer's key
 * parser normalizes both encodings into the same `{ name, ctrl }` shape.
 */
export const isQuitKey = (key: QuitKey): boolean =>
  key.name === "q" || (key.ctrl && key.name === "c");

/**
 * Completes the first time the user presses a quit key (see {@link isQuitKey}).
 *
 * Listens on the renderer's parsed-key input (`keyInput`), not raw bytes, so it
 * quits on Ctrl+C in any terminal regardless of the keyboard protocol. The
 * `keypress` listener is removed via the finalizer on completion or interruption.
 */
export const awaitQuit = (renderer: CliRenderer): Effect.Effect<void> =>
  Effect.async<void>((resume) => {
    const onKey = (key: QuitKey) => {
      if (isQuitKey(key)) resume(Effect.void);
    };
    renderer.keyInput.on("keypress", onKey);
    return Effect.sync(() => renderer.keyInput.off("keypress", onKey));
  });

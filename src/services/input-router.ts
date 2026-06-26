import { Context, Deferred, Effect, Layer, Ref, Runtime } from "effect";
import { Renderer } from "./renderer.ts";

/**
 * Single owner of terminal input. Today `awaitQuit` owned the sole keypress
 * listener and unconditionally treated `q`/Ctrl+C as quit; interactive features
 * (process table, filter, focus, modals) need more keys, and a second listener
 * would race the first. The `InputRouter` is the one keypress subscription: it
 * holds the current {@link InputMode} in a `Ref`, dispatches each parsed key to
 * the active mode's registered handler, and resolves a quit signal under a
 * mode-aware rule. Each downstream feature registers its own mode's handlers;
 * Foundation ships the mechanism with `Normal`-mode quit wired.
 */

/** The four interaction modes. Features register handlers per mode; the router dispatches by the active one. */
export type InputMode = "Normal" | "Filter" | "Focus" | "Modal";

/**
 * The parsed-key fields handlers consume. Structurally a subset of OpenTUI's
 * `ParsedKey`/`KeyEvent` (which isn't re-exported from the package root), matched
 * on the *parsed* key — never raw bytes — so it holds under the Kitty keyboard
 * protocol (see {@link isQuitForMode}).
 */
export interface InputKey {
  readonly name: string;
  readonly ctrl: boolean;
  readonly shift: boolean;
  readonly meta: boolean;
  readonly option: boolean;
  readonly sequence: string;
}

/**
 * A mode's key handler. Run synchronously inside the keypress callback (Bun is
 * single-threaded, so a handler and the render-tick fiber interleave but never
 * truly race), so handlers must not suspend — mutate UI state and call
 * `renderer.requestRender()` for an immediate repaint, and fork any async work.
 */
export type KeyHandler = (key: InputKey) => Effect.Effect<void>;

/**
 * Mode-aware quit rule. Ctrl+C always quits (in every mode); bare `q` quits only
 * in `Normal`/`Focus` — in `Filter` it's a literal character and in `Modal` it's
 * swallowed. Matching the parsed `{ name, ctrl }` (not raw bytes) is what keeps
 * Ctrl+C working under the Kitty protocol, which encodes it as a CSI-u escape.
 * Pure and exported for unit testing.
 */
export const isQuitForMode = (
  key: Pick<InputKey, "name" | "ctrl">,
  mode: InputMode,
): boolean => {
  if (key.ctrl && key.name === "c") return true;
  if (key.name === "q") return mode === "Normal" || mode === "Focus";
  return false;
};

export class InputRouter extends Context.Tag("InputRouter")<
  InputRouter,
  {
    /** Register (or replace) the key handler for a mode. */
    readonly register: (mode: InputMode, handler: KeyHandler) => Effect.Effect<void>;
    /** Switch the active input mode. */
    readonly setMode: (mode: InputMode) => Effect.Effect<void>;
    /** The active input mode. */
    readonly mode: Effect.Effect<InputMode>;
    /** Completes when the user requests quit (mode-aware). Block the program on this. */
    readonly awaitQuit: Effect.Effect<void>;
  }
>() {}

/**
 * Live router. Owns one `keypress` listener (removed via the scope finalizer),
 * runs the per-key dispatch synchronously through the captured runtime for an
 * immediate repaint, and completes a `Deferred` on quit so `main.ts` can block on
 * a single signal regardless of which mode the user quit from.
 */
export const InputRouterLive = Layer.scoped(
  InputRouter,
  Effect.gen(function* () {
    const renderer = yield* Renderer;
    const modeRef = yield* Ref.make<InputMode>("Normal");
    const handlers = yield* Ref.make(new Map<InputMode, KeyHandler>());
    const quit = yield* Deferred.make<void>();
    const runtime = yield* Effect.runtime<never>();

    const dispatch = (key: InputKey): Effect.Effect<void> =>
      Effect.gen(function* () {
        const mode = yield* Ref.get(modeRef);
        if (isQuitForMode(key, mode)) {
          yield* Deferred.succeed(quit, undefined);
          return;
        }
        const handler = (yield* Ref.get(handlers)).get(mode);
        if (handler !== undefined) yield* handler(key);
        // Unhandled keys are ignored.
      }).pipe(
        // A buggy handler must never take down the input listener.
        Effect.catchAllCause(() => Effect.void),
      );

    const onKey = (key: InputKey): void => {
      Runtime.runSync(runtime)(dispatch(key));
    };

    yield* Effect.acquireRelease(
      Effect.sync(() => renderer.keyInput.on("keypress", onKey)),
      () => Effect.sync(() => renderer.keyInput.off("keypress", onKey)),
    );

    return InputRouter.of({
      register: (mode, handler) =>
        Ref.update(handlers, (m) => new Map(m).set(mode, handler)),
      setMode: (mode) => Ref.set(modeRef, mode),
      mode: Ref.get(modeRef),
      awaitQuit: Deferred.await(quit),
    });
  }),
);

import { type CliRenderer, createCliRenderer } from "@opentui/core";
import { Context, Effect, Layer } from "effect";

/**
 * The OpenTUI renderer as an Effect service. Owning it as a scoped Layer (rather
 * than an inline `acquireRelease` in `main.ts`) lets other services depend on it
 * — notably the {@link InputRouter}, which needs the renderer's `keyInput` to own
 * the single keypress subscription. The renderer is created when the layer is
 * built and `destroy()`d when its scope closes, so it tears down *after* the
 * scope-bound collector/render fibers are interrupted.
 */
export class Renderer extends Context.Tag("Renderer")<Renderer, CliRenderer>() {}

/** Live renderer, acquired/released with the enclosing scope. */
export const RendererLive = Layer.scoped(
  Renderer,
  Effect.acquireRelease(
    Effect.promise(() =>
      createCliRenderer({
        // Effect owns the lifecycle: the InputRouter catches Ctrl+C via its
        // parsed-key handler and completes the quit signal, so the renderer must
        // not exit on its own.
        exitOnCtrlC: false,
        exitSignals: [],
        targetFps: 30,
      }),
    ),
    (renderer) => Effect.sync(() => renderer.destroy()),
  ),
);

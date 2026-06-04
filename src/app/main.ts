import { BunRuntime } from "@effect/platform-bun";
import { createCliRenderer } from "@opentui/core";
import { Duration, Effect, Layer, Schedule, Stream } from "effect";
import { CpuCollectorMacOSLive } from "../collectors/cpu-macos.ts";
import { CpuCollector } from "../services/cpu-collector.ts";
import { MetricsStore, MetricsStoreLive } from "../services/metrics-store.ts";
import { RenderError } from "../types/errors.ts";
import { makeCpuGauge } from "../ui/components/cpu-gauge.ts";

/**
 * App root. Composes the collector + store Layers, owns the OpenTUI renderer as a
 * managed resource, runs the collector and a render-tick loop as scope-bound
 * fibers, and waits for a quit key. On quit/SIGINT the scope closes: fibers are
 * interrupted and the renderer is destroyed, restoring the terminal.
 */

/** Lifetime is bound to the enclosing scope — `destroy()` runs on shutdown. */
const acquireRenderer = Effect.acquireRelease(
  Effect.promise(() =>
    createCliRenderer({
      // Effect owns the lifecycle: SIGINT is handled by BunRuntime, and the
      // Ctrl+C byte is caught by our input handler below.
      exitOnCtrlC: false,
      exitSignals: [],
      targetFps: 30,
    }),
  ),
  (renderer) => Effect.sync(() => renderer.destroy()),
);

const program = Effect.gen(function* () {
  const store = yield* MetricsStore;
  const cpu = yield* CpuCollector;

  const renderer = yield* acquireRenderer;
  const gauge = makeCpuGauge(renderer);
  renderer.root.add(gauge.root);

  // Collector fiber: drain the stream into the store. Scope-bound, so it is
  // interrupted automatically on shutdown.
  yield* cpu.stream.pipe(
    Stream.runForEach((state) => store.set(state)),
    Effect.forkScoped,
  );

  // Render-tick fiber: pull the latest state and update the view. A RenderError
  // degrades to a debug line instead of crashing the loop.
  yield* store.get("cpu").pipe(
    Effect.flatMap((state) =>
      Effect.try({
        try: () => {
          gauge.update(state);
          // Mutating renderable content marks it dirty; ask the renderer to
          // repaint this frame (throttled by maxFps).
          renderer.requestRender();
        },
        catch: (cause) =>
          new RenderError({
            component: "cpu-gauge",
            reason: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      }),
    ),
    Effect.catchTag("RenderError", (error) =>
      Effect.sync(() => gauge.showDebug(`render error: ${error.reason}`)),
    ),
    Effect.repeat(Schedule.spaced(Duration.millis(250))),
    Effect.forkScoped,
  );

  // Block until the user quits; returning closes the scope and tears everything
  // down in reverse order (fibers interrupted, then renderer destroyed).
  yield* Effect.async<void>((resume) => {
    renderer.addInputHandler((seq) => {
      if (seq === "q" || seq === "\x03") {
        resume(Effect.void);
        return true;
      }
      return false;
    });
  });
});

const AppLive = Layer.merge(MetricsStoreLive, CpuCollectorMacOSLive);

BunRuntime.runMain(Effect.scoped(Effect.provide(program, AppLive)));

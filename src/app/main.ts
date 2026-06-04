import { BunRuntime } from "@effect/platform-bun";
import { createCliRenderer } from "@opentui/core";
import { Duration, Effect, Layer, Option, Schedule, Stream } from "effect";
import { CpuCollectorMacOSLive } from "../collectors/cpu-macos.ts";
import { MemoryCollectorMacOSLive } from "../collectors/memory-macos.ts";
import { CpuCollector } from "../services/cpu-collector.ts";
import { MemoryCollector } from "../services/memory-collector.ts";
import { MetricsStore, MetricsStoreLive } from "../services/metrics-store.ts";
import { RenderError } from "../types/errors.ts";
import { makeCpuGauge } from "../ui/components/cpu-gauge.ts";
import { makeCpuSparkline } from "../ui/components/cpu-sparkline.ts";
import { makeMemoryGauge } from "../ui/components/memory-gauge.ts";
import type { MetricState, MetricTag } from "../types/metrics.ts";

/**
 * A stable signature for a state: identical signatures mean nothing visible
 * changed, so we can skip the redraw. New samples carry a fresh `at` timestamp.
 */
const signatureOf = (state: Option.Option<MetricState>): string =>
  Option.match(state, {
    onNone: () => "none",
    onSome: (s) => (s._tag === "ok" ? `ok:${s.at}` : `unavailable:${s.at}`),
  });

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
  const memory = yield* MemoryCollector;

  const renderer = yield* acquireRenderer;
  const cpuGauge = makeCpuGauge(renderer);
  const sparkline = makeCpuSparkline(renderer);
  const memGauge = makeMemoryGauge(renderer);
  renderer.root.add(cpuGauge.root);
  renderer.root.add(sparkline.root);
  renderer.root.add(memGauge.root);

  // One independent collector fiber per source. Because each stream recovers its
  // own errors into `unavailable`, a failure in one never affects the others.
  yield* cpu.stream.pipe(
    Stream.runForEach((state) => store.set(state)),
    Effect.forkScoped,
  );
  yield* memory.stream.pipe(
    Stream.runForEach((state) => store.set(state)),
    Effect.forkScoped,
  );

  // Each panel binds a store tag to the views it drives.
  const panels: ReadonlyArray<{
    readonly tag: MetricTag;
    readonly apply: (state: Option.Option<MetricState>) => void;
  }> = [
    {
      tag: "cpu",
      apply: (state) => {
        cpuGauge.update(state);
        sparkline.push(state);
      },
    },
    { tag: "memory", apply: (state) => memGauge.update(state) },
  ];

  // Render-tick fiber: for each panel, read its latest state and re-apply only
  // when the sample changed (redraw-on-change), then request a single repaint.
  // A RenderError degrades to a debug line instead of crashing the loop.
  const lastSignature = new Map<MetricTag, string>();
  yield* Effect.forEach(panels, (panel) =>
    store
      .get(panel.tag)
      .pipe(Effect.map((state) => ({ panel, state }))),
  ).pipe(
    Effect.flatMap((entries) =>
      Effect.try({
        try: () => {
          let dirty = false;
          for (const { panel, state } of entries) {
            const signature = signatureOf(state);
            if (lastSignature.get(panel.tag) === signature) continue;
            lastSignature.set(panel.tag, signature);
            panel.apply(state);
            dirty = true;
          }
          if (dirty) renderer.requestRender();
        },
        catch: (cause) =>
          new RenderError({
            component: "render-tick",
            reason: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      }),
    ),
    Effect.catchTag("RenderError", (error) =>
      Effect.sync(() => cpuGauge.showDebug(`render error: ${error.reason}`)),
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

const AppLive = Layer.mergeAll(
  MetricsStoreLive,
  CpuCollectorMacOSLive,
  MemoryCollectorMacOSLive,
);

BunRuntime.runMain(Effect.scoped(Effect.provide(program, AppLive)));

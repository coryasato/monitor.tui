import { BunRuntime } from "@effect/platform-bun";
import { createCliRenderer, TextRenderable } from "@opentui/core";
import { Duration, Effect, Layer, Option, Schedule, Stream } from "effect";
import { CpuCollectorMacOSLive } from "../collectors/cpu-macos.ts";
import { MemoryCollectorMacOSLive } from "../collectors/memory-macos.ts";
import { NetworkCollectorMacOSLive } from "../collectors/network-macos.ts";
import { Config, ConfigLive } from "../services/config.ts";
import { CpuCollector } from "../services/cpu-collector.ts";
import { MemoryCollector } from "../services/memory-collector.ts";
import { MetricsStore, MetricsStoreLive } from "../services/metrics-store.ts";
import { NetworkCollector } from "../services/network-collector.ts";
import { RenderError } from "../types/errors.ts";
import type { MetricState, MetricTag } from "../types/metrics.ts";
import { makeCpuGauge } from "../ui/components/cpu-gauge.ts";
import { makeCpuSparkline } from "../ui/components/cpu-sparkline.ts";
import { makeMemoryGauge } from "../ui/components/memory-gauge.ts";
import { makeNetworkReadout } from "../ui/components/network-readout.ts";

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
 * App root. Resolves config, composes the collector + store Layers, owns the
 * OpenTUI renderer as a managed resource, runs the enabled collectors and a
 * render-tick loop as scope-bound fibers, and waits for a quit key. On quit the
 * scope closes: fibers are interrupted and the renderer is destroyed.
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

/** A configured metric panel: a store tag, its stream, and the views it drives. */
interface Panel {
  readonly tag: MetricTag;
  readonly stream: Stream.Stream<MetricState>;
  readonly apply: (state: Option.Option<MetricState>) => void;
}

const program = Effect.gen(function* () {
  const config = yield* Config;
  const store = yield* MetricsStore;
  const cpu = yield* CpuCollector;
  const memory = yield* MemoryCollector;
  const network = yield* NetworkCollector;

  const renderer = yield* acquireRenderer;

  // Build only the panels enabled by config (config-driven widgets).
  const panels: Panel[] = [];

  if (config.cpu.enabled) {
    const cpuGauge = makeCpuGauge(renderer);
    const sparkline = makeCpuSparkline(renderer, config.sparkline.width);
    renderer.root.add(cpuGauge.root);
    renderer.root.add(sparkline.root);
    panels.push({
      tag: "cpu",
      stream: cpu.stream,
      apply: (state) => {
        cpuGauge.update(state);
        sparkline.push(state);
      },
    });
  }

  if (config.memory.enabled) {
    const memGauge = makeMemoryGauge(renderer);
    renderer.root.add(memGauge.root);
    panels.push({
      tag: "memory",
      stream: memory.stream,
      apply: (state) => memGauge.update(state),
    });
  }

  if (config.network.enabled) {
    const netReadout = makeNetworkReadout(renderer);
    renderer.root.add(netReadout.root);
    panels.push({
      tag: "network",
      stream: network.stream,
      apply: (state) => netReadout.update(state),
    });
  }

  // App-level debug line for RenderErrors (independent of which panels exist).
  const debugLine = new TextRenderable(renderer, {
    id: "app-debug",
    content: "",
    fg: "#FF5555",
  });
  renderer.root.add(debugLine);

  // One independent collector fiber per enabled source. Each stream recovers its
  // own errors into `unavailable`, so a failure in one never affects the others.
  yield* Effect.forEach(
    panels,
    (panel) =>
      panel.stream.pipe(
        Stream.runForEach((state) => store.set(state)),
        Effect.forkScoped,
      ),
    { discard: true },
  );

  // Render-tick fiber: for each panel, read its latest state and re-apply only
  // when the sample changed (redraw-on-change), then request a single repaint.
  // A RenderError degrades to the debug line instead of crashing the loop.
  const lastSignature = new Map<MetricTag, string>();
  yield* Effect.forEach(panels, (panel) =>
    store.get(panel.tag).pipe(Effect.map((state) => ({ panel, state }))),
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
      Effect.sync(() => {
        debugLine.content = `render error: ${error.reason}`;
      }),
    ),
    Effect.repeat(Schedule.spaced(Duration.millis(config.refreshMs))),
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
  ConfigLive,
  MetricsStoreLive,
  CpuCollectorMacOSLive,
  MemoryCollectorMacOSLive,
  NetworkCollectorMacOSLive,
);

BunRuntime.runMain(
  Effect.scoped(Effect.provide(program, AppLive)).pipe(
    // ConfigError is fatal at startup: print a clear message and exit non-zero
    // before the TUI ever starts.
    Effect.catchTag("ConfigError", (error) =>
      Effect.sync(() => {
        process.stderr.write(`\nConfiguration error: ${error.reason}\n`);
        process.exitCode = 1;
      }),
    ),
  ),
);

import { BunRuntime } from "@effect/platform-bun";
import {
  BoxRenderable,
  createCliRenderer,
  type Renderable,
  TextRenderable,
} from "@opentui/core";
import { Duration, Effect, Layer, Option, Schedule, Stream } from "effect";
import { CpuCollectorMacOSLive } from "../collectors/cpu-macos.ts";
import { DiskCollectorMacOSLive } from "../collectors/disk-macos.ts";
import { MemoryCollectorMacOSLive } from "../collectors/memory-macos.ts";
import { NetworkCollectorMacOSLive } from "../collectors/network-macos.ts";
import { Config, ConfigLive } from "../services/config.ts";
import { CpuCollector } from "../services/cpu-collector.ts";
import { DiskCollector } from "../services/disk-collector.ts";
import { MemoryCollector } from "../services/memory-collector.ts";
import { MetricsStore, MetricsStoreLive } from "../services/metrics-store.ts";
import { NetworkCollector } from "../services/network-collector.ts";
import { RenderError } from "../types/errors.ts";
import type { MetricState, MetricTag } from "../types/metrics.ts";
import { makeCpuGauge } from "../ui/components/cpu-gauge.ts";
import { makeCpuSparkline } from "../ui/components/cpu-sparkline.ts";
import { makeDiskReadout } from "../ui/components/disk-readout.ts";
import { makeMemoryGauge } from "../ui/components/memory-gauge.ts";
import { makeNetworkReadout } from "../ui/components/network-readout.ts";
import { awaitQuit } from "./quit.ts";

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
      // Effect owns the lifecycle: SIGINT is handled by BunRuntime, and Ctrl+C
      // is caught by our parsed-key handler below (see the quit listener).
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
  const disk = yield* DiskCollector;

  const renderer = yield* acquireRenderer;

  // Build only the panels enabled by config (config-driven widgets). `cells` holds
  // the panel boxes in display order; `panels` drives the render tick.
  const panels: Panel[] = [];
  const cells: Renderable[] = [];

  if (config.cpu.enabled) {
    const cpuGauge = makeCpuGauge(renderer);
    const sparkline = makeCpuSparkline(renderer, config.sparkline.width);
    cells.push(cpuGauge.root, sparkline.root);
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
    cells.push(memGauge.root);
    panels.push({
      tag: "memory",
      stream: memory.stream,
      apply: (state) => memGauge.update(state),
    });
  }

  if (config.network.enabled) {
    const netReadout = makeNetworkReadout(renderer);
    cells.push(netReadout.root);
    panels.push({
      tag: "network",
      stream: network.stream,
      apply: (state) => netReadout.update(state),
    });
  }

  if (config.disk.enabled) {
    const diskReadout = makeDiskReadout(renderer);
    cells.push(diskReadout.root);
    panels.push({
      tag: "disk",
      stream: disk.stream,
      apply: (state) => diskReadout.update(state),
    });
  }

  // Responsive grid: a wrapping row of half-width cells. Panels flow
  // left-to-right and wrap to the next line (Yoga `flexWrap`, which OpenTUI
  // forwards), roughly halving the stack height so it fits short terminals
  // (~24 rows). Items in each wrapped line share the line's height via the
  // default `alignItems: "stretch"`.
  const grid = new BoxRenderable(renderer, {
    id: "grid",
    flexDirection: "row",
    flexWrap: "wrap",
    width: "100%",
  });
  for (const cell of cells) {
    cell.width = "50%";
    grid.add(cell);
  }
  renderer.root.add(grid);

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

  // Block until the user presses `q` or Ctrl+C; returning closes the scope and
  // tears everything down in reverse order (fibers interrupted, then renderer
  // destroyed). See `awaitQuit` for why this matches parsed keys, not raw bytes.
  yield* awaitQuit(renderer);
});

const AppLive = Layer.mergeAll(
  ConfigLive,
  MetricsStoreLive,
  CpuCollectorMacOSLive,
  MemoryCollectorMacOSLive,
  NetworkCollectorMacOSLive,
  DiskCollectorMacOSLive,
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

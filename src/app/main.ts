import { BunRuntime } from "@effect/platform-bun";
import {
  BoxRenderable,
  type Renderable,
  TextRenderable,
} from "@opentui/core";
import { Duration, Effect, Layer, Option, Schedule, Stream } from "effect";
import { Config, ConfigLive } from "../services/config.ts";
import { CpuCoresCollector } from "../services/cpu-cores-collector.ts";
import { CpuCollector } from "../services/cpu-collector.ts";
import { DiskCollector } from "../services/disk-collector.ts";
import { InputRouter, InputRouterLive } from "../services/input-router.ts";
import { MemoryCollector } from "../services/memory-collector.ts";
import { MetricsStore, MetricsStoreLive } from "../services/metrics-store.ts";
import { NetworkCollector } from "../services/network-collector.ts";
import { ProcessCollector } from "../services/process-collector.ts";
import { Renderer, RendererLive } from "../services/renderer.ts";
import { RenderError } from "../types/errors.ts";
import type { MetricState, MetricTag } from "../types/metrics.ts";
import { makeCpuCores } from "../ui/components/cpu-cores.ts";
import { makeCpuGauge } from "../ui/components/cpu-gauge.ts";
import { makeCpuSparkline } from "../ui/components/cpu-sparkline.ts";
import { makeDiskReadout } from "../ui/components/disk-readout.ts";
import { makeMemoryGauge } from "../ui/components/memory-gauge.ts";
import { makeNetworkReadout } from "../ui/components/network-readout.ts";
import { makeProcessTable } from "../ui/components/process-table.ts";
import { CollectorsLive } from "./layers.ts";

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
 * App root. Resolves config, composes the collector + store + renderer + input
 * Layers, runs the enabled collectors and a render-tick loop as scope-bound
 * fibers, and blocks on the InputRouter's quit signal. On quit the scope closes:
 * fibers are interrupted and the renderer is destroyed.
 */

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
  const cpuCores = yield* CpuCoresCollector;
  const memory = yield* MemoryCollector;
  const network = yield* NetworkCollector;
  const disk = yield* DiskCollector;
  const processes = yield* ProcessCollector;

  const renderer = yield* Renderer;
  const router = yield* InputRouter;

  // Build only the panels enabled by config (config-driven widgets). `cells` holds
  // the metric-widget boxes in display order; `panels` drives the render tick.
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

  if (config.cpuCores.enabled) {
    const cpuCoresPanel = makeCpuCores(renderer);
    cells.push(cpuCoresPanel.root);
    panels.push({
      tag: "cpu-cores",
      stream: cpuCores.stream,
      apply: (state) => cpuCoresPanel.update(state),
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
  // forwards), roughly halving the stack height so it fits short terminals.
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

  // Layout. With the process panel enabled we split into two columns — the
  // process table on the left, the widget grid on the right. Disabled → the
  // original full-width grid.
  if (config.process.enabled) {
    // `flexGrow: 1` (not `height: "100%"`) so the split fills the space left after
    // the debug line. Yoga's default `flexShrink` is 0, so a `height: "100%"`
    // child in this column root would overflow and push the debug line off-screen.
    const split = new BoxRenderable(renderer, {
      id: "split",
      flexDirection: "row",
      width: "100%",
      flexGrow: 1,
    });
    const table = makeProcessTable(renderer);
    table.root.width = "50%";
    const rightPane = new BoxRenderable(renderer, {
      id: "right-pane",
      width: "50%",
      flexDirection: "column",
    });
    rightPane.add(grid);
    split.add(table.root);
    split.add(rightPane);
    renderer.root.add(split);

    // The table is a render-tick panel like the widgets (data tick → update);
    // its Normal-mode key handlers route through the InputRouter.
    panels.push({
      tag: "process",
      stream: processes.stream,
      apply: (state) => table.update(state),
    });
    yield* router.register("Normal", (key) =>
      Effect.sync(() => table.onKey(key)),
    );
  } else {
    renderer.root.add(grid);
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

  // Block until the InputRouter resolves its quit signal (mode-aware: Ctrl+C in
  // any mode, bare `q` in Normal/Focus). Returning closes the scope and tears
  // everything down in reverse order — fibers interrupted, then renderer destroyed.
  yield* router.awaitQuit;
});

const AppLive = Layer.mergeAll(
  ConfigLive,
  MetricsStoreLive,
  CollectorsLive,
  // One renderer instance, shared by the program and the InputRouter.
  InputRouterLive.pipe(Layer.provideMerge(RendererLive)),
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

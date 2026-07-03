import { BunRuntime } from "@effect/platform-bun";
import {
  BoxRenderable,
  type Renderable,
  TextRenderable,
} from "@opentui/core";
import {
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Ref,
  Schedule,
  Scope,
  Stream,
} from "effect";
import { Config, ConfigLive } from "../services/config.ts";
import { CpuCoresCollector } from "../services/cpu-cores-collector.ts";
import { CpuCollector } from "../services/cpu-collector.ts";
import { DiskCollector } from "../services/disk-collector.ts";
import { InputRouter, InputRouterLive } from "../services/input-router.ts";
import { launchProcess } from "../services/launched-process.ts";
import { MemoryCollector } from "../services/memory-collector.ts";
import { MetricsStore, MetricsStoreLive } from "../services/metrics-store.ts";
import { NetworkCollector } from "../services/network-collector.ts";
import { ProcessCollector } from "../services/process-collector.ts";
import { Renderer, RendererLive } from "../services/renderer.ts";
import { RenderError } from "../types/errors.ts";
import type {
  MetricState,
  MetricTag,
  ProcessId,
  ProcessRecord,
} from "../types/metrics.ts";
import { makeCpuCores } from "../ui/components/cpu-cores.ts";
import { makeCpuGauge } from "../ui/components/cpu-gauge.ts";
import { makeCpuSparkline } from "../ui/components/cpu-sparkline.ts";
import { makeDiskReadout } from "../ui/components/disk-readout.ts";
import { makeMemoryGauge } from "../ui/components/memory-gauge.ts";
import { makeNetworkReadout } from "../ui/components/network-readout.ts";
import { makeProcessFocusPanel } from "../ui/components/process-focus-panel.ts";
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

  // Per-tick focus-exit check, wired below only when the process panel exists.
  // Default no-op so the render-tick loop can call it unconditionally.
  let checkFocusExit: Effect.Effect<void> = Effect.void;

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
    const focusPanel = makeProcessFocusPanel(renderer, config.sparkline.width);
    const rightPane = new BoxRenderable(renderer, {
      id: "right-pane",
      width: "50%",
      flexDirection: "column",
    });
    // Both right-pane children live in the tree; we swap which is shown by
    // toggling `visible` (Yoga `display:none` excludes the hidden one from
    // layout), rather than churning the tree on every pin/unpin.
    rightPane.add(grid);
    rightPane.add(focusPanel.root);
    focusPanel.root.visible = false;
    const showWidgets = (): void => {
      grid.visible = true;
      focusPanel.root.visible = false;
    };
    const showFocus = (): void => {
      grid.visible = false;
      focusPanel.root.visible = true;
    };
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

    // --- Focus view lifecycle (Feature 2) -----------------------------------
    // The pinned PID and the PID-scoped focus collector fiber live in UI state.
    // The collector is forked into a single closeable scope opened here and
    // closed on program teardown, so a clean quit always interrupts it.
    const pinnedRef = yield* Ref.make<Option.Option<ProcessId>>(Option.none());
    // The PID of a launched child (Feature 4), if any. Its exit is detected
    // precisely via the subprocess handle, so the ps-absence check below skips it.
    const launchedPidRef =
      yield* Ref.make<Option.Option<ProcessId>>(Option.none());
    const focusFiberRef =
      yield* Ref.make<Option.Option<Fiber.RuntimeFiber<void>>>(Option.none());
    const focusScope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(focusScope, Exit.void));

    const stopFocus = Effect.gen(function* () {
      const prev = yield* Ref.getAndSet(focusFiberRef, Option.none());
      // `interruptFork` (not `interrupt`) so this stays synchronously runnable
      // inside the keypress handler — we don't block on the fiber's teardown.
      if (Option.isSome(prev)) yield* Fiber.interruptFork(prev.value);
    });

    const unpin = Effect.gen(function* () {
      yield* stopFocus;
      yield* Ref.set(pinnedRef, Option.none());
      showWidgets();
      yield* router.setMode("Normal");
      renderer.requestRender();
    });

    // Pin `pid` to the focus view, driving the panel from `stream` (a per-PID
    // focus stream for an attached process, or a subtree stream for a launched
    // command). Forks the stream into `focusScope` so unpin/quit interrupts it.
    const pinStream = (
      pid: ProcessId,
      name: string,
      stream: Stream.Stream<MetricState>,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* stopFocus; // replace any prior pin
        focusPanel.prime(pid, name);
        yield* Ref.set(pinnedRef, Option.some(pid));
        const fiber = yield* stream.pipe(
          Stream.runForEach((state) =>
            Effect.sync(() => {
              focusPanel.update(Option.some(state));
              renderer.requestRender();
            }),
          ),
          Effect.forkIn(focusScope),
        );
        yield* Ref.set(focusFiberRef, Option.some(fiber));
        showFocus();
        yield* router.setMode("Focus");
        renderer.requestRender();
      });

    const pin = (sel: ProcessRecord): Effect.Effect<void> =>
      pinStream(sel.pid, sel.name, processes.focusStream(sel.pid));

    // Normal mode: `Enter` pins the highlighted row, `/` enters Filter mode
    // (Feature 3) — both suppressed while a kill confirm is open; every other
    // key drives the table.
    yield* router.register("Normal", (key) => {
      if (key.name === "return") {
        return Effect.suspend(() => {
          if (table.isAwaitingConfirm()) return Effect.void;
          const sel = table.getSelection();
          return sel === null ? Effect.void : pin(sel);
        });
      }
      if (key.name === "/") {
        return Effect.suspend(() => {
          if (table.isAwaitingConfirm()) return Effect.void;
          table.startFilter();
          return router.setMode("Filter");
        });
      }
      return Effect.sync(() => table.onKey(key));
    });
    // Focus mode: `Escape` unpins; quit keys are handled by the router itself.
    yield* router.register("Focus", (key) =>
      key.name === "escape" ? unpin : Effect.void,
    );
    // Filter mode (Feature 3): `Enter` locks the query and returns to Normal
    // (table stays filtered, `/` re-edits); `Escape` clears the query and
    // returns to Normal; every other key edits the query text. `q`/`k` are
    // literal here — only Ctrl+C quits (InputRouter's mode-aware quit rule).
    yield* router.register("Filter", (key) => {
      if (key.name === "return") {
        return Effect.sync(() => table.lockFilter()).pipe(
          Effect.zipRight(router.setMode("Normal")),
        );
      }
      if (key.name === "escape") {
        return Effect.sync(() => table.clearFilter()).pipe(
          Effect.zipRight(router.setMode("Normal")),
        );
      }
      return Effect.sync(() => table.onFilterKey(key));
    });

    // Exit detection (attached PID): when the pinned process disappears from the
    // process list, auto-unpin and toast. Runs once per render tick (≤ one poll
    // interval of latency — the best-effort path the plan describes). A launched
    // child (Feature 4) will instead signal exit precisely via its handle.
    checkFocusExit = Effect.gen(function* () {
      const pinned = yield* Ref.get(pinnedRef);
      if (Option.isNone(pinned)) return;
      // A launched child's exit is handled precisely by its `child.exited`
      // watcher (with the real exit code), so don't also detect it by ps-absence.
      const launched = yield* Ref.get(launchedPidRef);
      if (Option.isSome(launched) && launched.value === pinned.value) return;
      const state = yield* store.get("process");
      if (Option.isNone(state)) return;
      const s = state.value;
      if (s._tag !== "ok" || s.snapshot._tag !== "process") return;
      const present = s.snapshot.processes.some((p) => p.pid === pinned.value);
      if (!present) {
        table.notify(`PID ${pinned.value as number} exited`);
        yield* unpin;
      }
    });

    // --- Launched command (Feature 4) ----------------------------------------
    // `monitor -- <command…>`: spawn the command as our child (a scope-bound
    // resource — killed with its subtree on quit unless `--no-kill-on-exit`),
    // auto-pin its aggregated subtree in the focus view, and watch its precise
    // exit via the subprocess handle. A failed launch is a toast, not a crash.
    if (config.launch !== null) {
      const launch = config.launch;
      yield* launchProcess(launch.command, {
        killOnExit: launch.killOnExit,
        stderrLines: launch.stderrLines,
      }).pipe(
        Effect.flatMap((handle) =>
          Effect.gen(function* () {
            yield* Ref.set(launchedPidRef, Option.some(handle.pid));
            yield* pinStream(
              handle.pid,
              handle.command,
              processes.subtreeFocusStream(handle.pid),
            );
            // Precise exit: toast the real code/signal, auto-unpin if it's still
            // the pinned process. Forked so it never blocks startup.
            yield* handle.awaitExit.pipe(
              Effect.flatMap((info) =>
                Effect.gen(function* () {
                  const detail =
                    info.exitCode !== null
                      ? `code ${info.exitCode}`
                      : info.signalCode !== null
                        ? `signal ${info.signalCode}`
                        : "unknown";
                  table.notify(
                    `PID ${handle.pid as number} exited (${detail})`,
                  );
                  const pinned = yield* Ref.get(pinnedRef);
                  if (Option.isSome(pinned) && pinned.value === handle.pid) {
                    yield* unpin;
                  }
                }),
              ),
              Effect.forkIn(focusScope),
            );
          }),
        ),
        Effect.catchTag("CollectorError", (error) =>
          Effect.sync(() => table.notify(error.reason)),
        ),
      );
    }
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
    // After painting, detect a pinned process that has exited (Feature 2).
    Effect.zipRight(checkFocusExit),
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

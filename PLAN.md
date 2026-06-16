# PLAN.md — monitor.tui

## Context

Greenfield system/container observability TUI. This is a **learning project**: the
goal is to internalize Effect.ts (Services, Layers, Streams, typed errors, fibers)
and OpenTUI while building something genuinely useful. Architecture correctness
matters more than feature breadth, so we move in **small, milestone-gated phases**,
starting with a single CPU collector and growing the pattern outward.

Key constraints:
- **macOS has no `/proc`.** CLAUDE.md's procfs design can't run here. We abstract
  collection behind a Service interface and ship a **macOS Layer** now; a Linux
  Layer drops in later with no call-site changes.
- **UI:** vanilla `@opentui/core` (reuse the pattern in `index.ts`); React deferred.
- **Docker isn't running** → container observability is a late phase.

Locked decisions: *abstract now / macOS only*, *vanilla OpenTUI*, *full Service +
Layer + Stream from Phase 1*.

---

## Phase 0 — Foundation ✅ DONE
**Goal:** project skeleton, dependencies, shared types compile.

- [x] `bun add effect`.
- [x] Create `/src` tree (`services`, `collectors`, `ui`, `app`, `types`).
- [x] `/src/types/errors.ts` — error taxonomy as `Data.TaggedError`:
  `CollectorError` (recoverable), `ConfigError` (fatal), `RenderError` (degrade).
- [x] `/src/types/metrics.ts` — `MetricSnapshot` value type + branded types
  (`Percent`, `Timestamp`). Discriminated union keyed by `_tag`.

**Milestone:** `bun run typecheck` passes; `bun index.ts` still renders. ✅

---

## Phase 1 — CPU collector (the Effect core lesson) ✅ DONE
**Goal:** read real CPU usage once, through a Service + Layer, with typed errors.

- `/src/services/cpu-collector.ts` — `CpuCollector` `Context.Tag`; `read: Effect<CpuSnapshot, CollectorError>`.
- `/src/collectors/cpu-macos.ts` — `CpuCollectorMacOSLive` Layer:
  - Source: `top -l 2 -n 0`, parse the **second** "CPU usage:" line (first sample is
    meaningless). Pure `parseCpuUsage(raw)`, unit-testable.
  - **Valibot validates parsed shape at the boundary**; failure → `CollectorError`.
  - Wrap `Bun.$` in `Effect.tryPromise`, map failure → `CollectorError`.
- Unit test `parseCpuUsage` against a captured `top` fixture.

**Milestone:** a small Effect program provides the Layer and prints a real CPU %.

---

## Phase 2 — Streaming + MetricsStore ✅ DONE
**Goal:** continuous, cancellable, resource-managed metric flow.

> Implemented: recovery/cadence logic extracted into the reusable
> `src/collectors/collector-stream.ts` (`collectorStream(tag, read, gap)`), which
> every future collector should reuse. `top` is spawned via `Bun.spawn` and killed
> on the interrupt `AbortSignal` so SIGINT leaves no orphaned subprocess.

- `read` → `Stream<CpuSnapshot, CollectorError>` (`Stream.repeatEffect` + `Schedule`).
  Collector owns interval + recovery (`catchTag` → "unavailable" snapshot, keep going).
- `/src/services/metrics-store.ts` — `Ref`-backed map keyed by collector tag.
  Writes from the collector fiber; reads are pull-based.
- Collector runs as a fiber via `acquireRelease`; Ctrl+C tears it down cleanly.

**Milestone:** CPU value updates every N ms in console; clean Ctrl+C shutdown.

---

## Phase 3 — TUI wiring (vanilla OpenTUI) ✅ DONE
**Goal:** live CPU gauge on screen, pull-based reads.

- `/src/app/main.ts` — `BunRuntime.runMain`, compose Layers, start renderer.
- `/src/ui/components/cpu-gauge.ts` — CPU gauge (% text + colored bar); read latest
  snapshot from `MetricsStore` each render tick (never push fiber→component).
- `RenderError` → debug line via `gauge.showDebug`, never crash the loop.

**Milestone:** a live, updating CPU gauge in the terminal. ✅

> Notes for later: (1) mutating renderable `.content` does **not** auto-repaint —
> `main.ts` calls `renderer.requestRender()` each tick; (2) verifying a TUI needs a
> real PTY (`script -q out.txt timeout -s INT --preserve-status 8 bun src/app/main.ts`),
> piping to a non-TTY only shows the first frame; (3) component tests use
> `@opentui/core/testing` `createTestRenderer` + `captureCharFrame()`.

---

## Phase 4 — CPU history graph (rescoped) ✅ DONE
**Goal:** a scrolling sparkline of recent CPU load beneath the gauge.

> **Scope decision (2026-06-03):** per-core was dropped from this phase. macOS
> exposes **no** per-core CPU% via unprivileged CLI (`top`, `iostat -c`, `ps` all
> give aggregate only). Per-core needs `host_processor_info` via Bun FFI or
> `sudo powermetrics` — moved to *Future Work* below. This phase ships the history
> graph for **aggregate** CPU, which has no such blocker.

- Rolling history of recent `used` (= user + system) samples. **Decide:** keep the
  ring buffer in the **UI component** (simplest — store stays "latest only") vs. in
  the store. Recommended: component-owned ring buffer; the store contract stays
  pull-based and unchanged.
- New `src/ui/components/cpu-sparkline.ts` — render history with block glyphs
  (`▁▂▃▄▅▆▇█`) scaled to 0–100%. `push(state)` + `render()`.
- **Redraw-on-change optimization:** the render tick currently calls
  `renderer.requestRender()` every tick. Change to request a render only when the
  rendered content actually changed (compare to last-rendered value), honoring the
  "minimize redraws" goal in CLAUDE.md.

**Milestone:** a live scrolling CPU history sparkline under the gauge; redraws only
on change.

---

## Phase 5 — Collectors ✅ DONE
Each reuses the Phase 1–3 pattern (Service → Layer → Stream → Store → component).
1. ✅ **Memory** via `vm_stat` / `sysctl`. Added `Bytes` brand, `MemorySnapshot`,
   `MemoryCollector` + macOS Layer, `MemoryGauge`. Extracted the shared `spawnText`
   helper (`src/collectors/spawn.ts`) and generalized `main.ts`'s render tick to a
   list of panels. The store is now genuinely multi-tag.
2. ✅ **Config loading.** `src/types/config.ts` (`AppConfig` + defaults),
   `src/services/config.ts` (`Config` tag, pure `parseArgs`/`mergeConfig`, Valibot
   schemas, `loadConfigFrom` → `Effect<AppConfig, ConfigError>`, `ConfigLive`).
   Precedence: defaults < `monitor.config.json` < CLI flags (`--config`, `--refresh`,
   `--[no-]cpu`, `--[no-]memory`, `--[no-]network`, `--[no-]disk`, `--sparkline-width`).
   `main.ts` gates panels on `enabled` (config-driven widgets) and treats `ConfigError`
   as fatal (clean message + exit 1, before the TUI starts) — exercises the last
   unused error category.
3. ✅ **Network** via `netstat -ib`. Added `BytesPerSec` brand, `NetworkSnapshot`,
   `NetworkCollector` + macOS Layer (samples `netstat -ib` twice ~1s apart via
   `Effect.sleep`, diffs cumulative counters → rx/tx bytes/sec), `NetworkReadout`
   (rate text, no bar), `network.enabled` flag. First rate-based metric + first
   stateful (two-sample) collector.
4. ✅ **Disk** via `iostat -d -c 2 -w 1`. `DiskSnapshot` (combined bytes/sec),
   `DiskCollector` + macOS Layer (pure `parseDiskThroughput` sums the MB/s columns of
   the last interval row), `DiskReadout`, `disk.enabled` flag. Extracted shared
   `formatRate` to `src/ui/format.ts` (used by net + disk readouts). Five panels now
   wrap cleanly in the flexWrap grid with no layout changes.

> **Docker** and **Linux Layers** were originally listed here but are deferred to
> other sessions — see **Future Work** below.

---

## Future Work (deferred to other sessions)

> Each item below is self-contained: a future session starts cold with only the repo
> (code + CLAUDE.md + this file + git history) — no prior chat. Everything needed to
> start is in the item; no earlier conversation context is required.

---

## Verification

**Every phase:** `bun run typecheck` (`tsc --noEmit`) and `bun test` stay green.

**TUI smoke test (needs a real PTY).** Piping the TUI to a non-TTY shows only the
first frame, so drive it through a pty and capture the output:

```sh
script -q /tmp/tui.out timeout -s INT --preserve-status 10 bun src/app/main.ts >/dev/null 2>/tmp/tui.err
# then assert against /tmp/tui.out (rendered frames) and /tmp/tui.err (should be empty)
```

After it exits, confirm no collector subprocess was orphaned by interruption:

```sh
pgrep -fl "top -l 2|vm_stat|hw.memsize|netstat -ib|iostat" || echo "NONE — clean"
```

**Quitting:** press `q` or Ctrl+C for a clean shutdown (renderer destroyed,
fibers interrupted). The harness `timeout -s INT` above also exits cleanly via
BunRuntime's signal handling.

**Per-phase checks:**
- **Phase 1:** scratch program (`bun src/app/cpu-demo.ts`) prints a plausible CPU %
  matching Activity Monitor.
- **Phase 2:** `bun src/app/stream-demo.ts` — value changes on the interval; clean
  exit, no orphaned subprocess.
- **Phase 3:** live CPU gauge renders real readings (grep `idle` in the pty capture).
- **Phase 4:** History panel renders; sparkline glyphs (`▁`–`█`) appear and scroll;
  redraws only on sample change.
- **Phase 5 (collectors):** all panels render in the flexWrap grid — `CPU` + history,
  `MEM` (`GiB`, ≈ Activity Monitor's "Memory Used"), `NET` (`↓/↑` rates), `DISK`
  (`I/O` rate). One collector going `unavailable` leaves the others updating
  (cross-tag isolation). Feature flags (`--no-memory`, `--no-disk`, …) drop the
  corresponding panel + collector.

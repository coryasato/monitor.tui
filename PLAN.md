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

## Phase 5+ — Next collectors (named, not specced)
Each reuses the Phase 1–3 pattern (Service → Layer → Stream → Store → component):
1. ✅ **Memory** via `vm_stat` / `sysctl` — DONE. Added `Bytes` brand,
   `MemorySnapshot`, `MemoryCollector` + macOS Layer, `MemoryGauge`. Extracted the
   shared `spawnText` helper (`src/collectors/spawn.ts`) and generalized `main.ts`'s
   render tick to a list of panels. The store is now genuinely multi-tag.
2. ✅ **Config loading** — DONE. `src/types/config.ts` (`AppConfig` + defaults),
   `src/services/config.ts` (`Config` tag, pure `parseArgs`/`mergeConfig`, Valibot
   schemas, `loadConfigFrom` → `Effect<AppConfig, ConfigError>`, `ConfigLive`).
   Precedence: defaults < `monitor.config.json` < CLI flags
   (`--config/--refresh/--[no-]cpu/--[no-]memory/--sparkline-width`). `main.ts` gates
   panels on `enabled` (config-driven widgets) and treats `ConfigError` as fatal
   (clean message + exit 1, before the TUI starts) — exercises the last unused error
   category.
3. **Network** via `netstat -ib` — DONE ✅. Added `BytesPerSec` brand,
   `NetworkSnapshot`, `NetworkCollector` + macOS Layer (samples `netstat -ib` twice
   ~1s apart via `Effect.sleep`, diffs cumulative counters → rx/tx bytes/sec),
   `NetworkReadout` (rate text, no bar), and a `network.enabled` config flag.
   First rate-based metric + first stateful (two-sample) collector. **Disk** (`iostat`)
   still TODO.
4. **Docker** containers (once the daemon is available).
5. **Linux Layers** for existing collectors (proves the abstraction).

---

## Bugs

- **Ctrl+C does not quit the app (`q` works).** `src/app/main.ts` quits via an
  `addInputHandler` matching the raw bytes `"q"` and `"\x03"` (Ctrl+C), with
  `exitOnCtrlC: false` and `exitSignals: []` so Effect owns the lifecycle.
  Suspected cause: the **Kitty keyboard protocol** (`useKittyKeyboard` defaults on)
  encodes Ctrl+C as a CSI-u escape (e.g. `\x1b[99;5u`), not a bare `\x03`, so the
  `seq === "\x03"` check never matches; and because the terminal is in raw mode,
  no SIGINT fires for BunRuntime to catch either. Workaround: press `q`.
  Likely fixes (verify which): parse the key via `renderer.keyInput` and match
  `key.ctrl && key.name === "c"` instead of raw bytes; and/or also match the CSI-u
  sequence; and/or re-enable `exitOnCtrlC` and bridge its exit into the Effect
  shutdown. **Status: deferred** — low impact since `q` quits cleanly.

- **Panels overflow short terminals (≤ ~24 rows).** The four panels (CPU gauge,
  CPU history, MEM gauge, NET readout) stack vertically as full-bordered boxes
  needing ~28 rows total; on a 24-row terminal the layout overflows and the bottom
  content overlaps. Content is all correct — it just doesn't fit. Likely fixes: a
  responsive/grid layout (two columns), drop per-box `padding`, a scrollable
  container, or hide panels that don't fit. **Status: deferred** — renders fine in a
  normal-height terminal. (Verify visual layout in a tall window, not a 24-row pty.)

---

## Future Work — Per-core CPU via Bun FFI (deferred from Phase 4)

> **This note is self-contained.** A future session starts cold with only the repo
> (code + CLAUDE.md + this file + git history) — no prior chat. Everything needed to
> start is below; no earlier conversation context is required.

**Why deferred:** macOS exposes no per-core CPU% to unprivileged CLI tools. Probed
2026-06-03: `top -l 1` has no per-cpu lines, `iostat -c` is aggregate, `ps -o %cpu`
is per-process. The kernel source is the Mach call `host_processor_info(...,
PROCESSOR_CPU_LOAD_INFO, ...)`, which returns per-core cumulative tick counters
(`CPU_STATE_USER`, `SYSTEM`, `IDLE`, `NICE`). `sudo powermetrics` also works but
needs root every run — rejected for a daily-usable tool.

**Recommended approach — compile a tiny C helper with Bun FFI `cc`** (simpler than
marshalling Mach out-params/pointers from JS, and avoids a separate build step):
- Use `import { cc } from "bun:ffi"` to compile inline C that calls
  `host_processor_info(mach_host_self(), PROCESSOR_CPU_LOAD_INFO, &n, &info, &cnt)`,
  writes per-core ticks into a caller-provided `uint64_t*` buffer, then
  `vm_deallocate`s the returned array (**required — leaks otherwise**). Mach symbols
  live in libSystem (linked automatically). Return the logical core count.
- `host_processor_info` gives **cumulative** ticks (instantaneous), unlike
  `top -l 2`. So the collector must diff two samples. Simplest: take two samples
  ~250ms apart **inside one `read`** (mirrors current `read` shape) and compute
  `busy% = (Δuser+Δsystem+Δnice) / (Δuser+Δsystem+Δnice+Δidle) * 100` per core.

**Integration points (reuse existing patterns):**
- `src/types/metrics.ts`: add `PerCoreCpuSnapshot { _tag: "cpu-cores"; at: Timestamp;
  cores: ReadonlyArray<Percent> }` to the `MetricSnapshot` union (this auto-extends
  `MetricTag` with `"cpu-cores"` and lets the store hold it with no store changes).
- `src/services/cpu-cores-collector.ts`: new `Context.Tag` service (`read` + `stream`),
  mirroring `cpu-collector.ts`.
- `src/collectors/cpu-cores-macos.ts`: FFI layer; pure `ticksToPercents(prev, next)`
  helper (unit-testable); validate core count with Valibot; build the stream with the
  existing `collectorStream("cpu-cores", read, gap)` from `collector-stream.ts`.
- `src/ui/components/cpu-cores.ts`: N horizontal bars (reuse `renderBar`/`loadColor`
  exported from `cpu-gauge.ts`).
- `src/app/main.ts`: merge the new Layer, fork its stream into the store, mount the
  component, update it on the render tick alongside the gauge.

**Tests:** unit-test `ticksToPercents` with fixture prev/next tick arrays (incl. a
zero-delta core → 0%); FFI integration test asserts `cores.length === hw.logicalcpu`
and every value ∈ [0, 100].

**Verification:** `sysctl -n hw.logicalcpu` (expect 8 on this machine) should equal
the bar count; compare bars to Activity Monitor's per-core view; confirm no FFI
memory growth over time (the `vm_deallocate`).

**Kickoff prompt for a future session:** *"Implement the deferred per-core CPU
feature described under 'Future Work' in PLAN.md: Bun FFI `host_processor_info`
collector + per-core bars, reusing collectorStream and the existing patterns."*

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
pgrep -fl "top -l 2|vm_stat|hw.memsize" || echo "NONE — clean"
```

**Quitting:** press `q` for a clean shutdown (renderer destroyed, fibers
interrupted). The harness `timeout -s INT` above also exits cleanly via
BunRuntime's signal handling. In-terminal **Ctrl+C does not quit yet** — see Bugs.

**Per-phase checks:**
- **Phase 1:** scratch program (`bun src/app/cpu-demo.ts`) prints a plausible CPU %
  matching Activity Monitor.
- **Phase 2:** `bun src/app/stream-demo.ts` — value changes on the interval; clean
  exit, no orphaned subprocess.
- **Phase 3:** live CPU gauge renders real readings (grep `idle` in the pty capture).
- **Phase 4:** History panel renders; sparkline glyphs (`▁`–`█`) appear and scroll;
  redraws only on sample change.
- **Phase 5 (memory):** both `CPU` and `MEM` panels render; memory shows `GiB` and
  ≈ Activity Monitor's "Memory Used"; one collector going `unavailable` leaves the
  other updating (cross-tag isolation).

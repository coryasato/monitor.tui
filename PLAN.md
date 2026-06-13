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

### 1. Per-core CPU via Bun FFI (deferred from Phase 4) ✅ DONE

**Shipped (2026-06-12):** Bun FFI `host_processor_info` collector + per-core bars,
exactly as planned below. `src/collectors/cpu-cores.c` (hand-declared Mach
prototypes — TinyCC chokes on `<mach/mach.h>`; `vm_deallocate`s the kernel array),
compiled at load via `cc` in `src/collectors/cpu-cores-macos.ts` with pure
`ticksToPercents` (handles 32-bit counter wrap + zero-delta cores). New
`CpuCoresCollector` service, `PerCoreCpuSnapshot` (`_tag: "cpu-cores"`), `makeCpuCores`
component (lazy per-core bar rows reusing `renderBar`/`loadColor`), `cpuCores.enabled`
config + `--[no-]cpu-cores`, wired into `main.ts`. Tests in `tests/cpu-cores-macos.test.ts`
(+ wrap/zero-delta units) and `tests/cpu-cores.test.ts`. Verified: 8 bars =
`hw.logicalcpu`, no FFI RSS growth over 200k calls, app boots/tears down clean.
Also added a `*.c` ambient module decl (`src/types/c-module.d.ts`) for `tsc`.

The original plan is kept below for reference.

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
- Bun's `cc` compiles with TinyCC, which can fail on the full `<mach/mach.h>`
  include tree. Fallback if it does: skip the include and declare the few needed
  prototypes (`mach_host_self`, `host_processor_info`, `vm_deallocate`) and
  constants (`PROCESSOR_CPU_LOAD_INFO = 2`, `CPU_STATE_MAX = 4`, the four state
  indices) manually in the inline C — the symbols still resolve from libSystem.
- The tick counters are `natural_t` (**unsigned 32-bit**) and can wrap. Widen to
  `uint64_t` in the output buffer, but `ticksToPercents` must still handle a
  negative per-counter delta (wrap): either add `2**32` or clamp that core to 0
  for the sample and let the next tick recover. Unit-test this case.
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
- `src/types/config.ts` + `src/services/config.ts`: add a `cpuCores.enabled` flag
  (`--[no-]cpu-cores`), like the other panels — `main.ts` gates panels on config.
- `src/app/main.ts`: merge the new Layer into `AppLive` and add a `Panel` entry
  (tag `"cpu-cores"`, the collector's stream, an `apply` that updates the
  component) inside the new config gate — the existing fork/render-tick loops
  pick it up automatically.

**Tests:** unit-test `ticksToPercents` with fixture prev/next tick arrays (incl. a
zero-delta core → 0%); FFI integration test asserts `cores.length === hw.logicalcpu`
and every value ∈ [0, 100].

**Verification:** `sysctl -n hw.logicalcpu` (expect 8 on this machine) should equal
the bar count; compare bars to Activity Monitor's per-core view; confirm no FFI
memory growth over time (the `vm_deallocate`).

**Kickoff prompt for a future session:** *"Implement the deferred per-core CPU
feature described under 'Future Work' in PLAN.md: Bun FFI `host_processor_info`
collector + per-core bars, reusing collectorStream and the existing patterns."*

### 2. Docker container stats

**Goal:** a panel listing running containers with per-container CPU% and memory
usage (plus name/status), updating live like the other metrics.

**Why deferred:** needs a running Docker daemon, which wasn't available during the
initial build. Not required for the core system dashboard.

**Data source (pick one):**
- **`docker stats --no-stream --format "{{json .}}"`** — simplest; one JSON object
  per container per line. Shell out via the existing `spawnText` helper. Each line:
  `{ "Name", "CPUPerc": "12.34%", "MemUsage": "1.2GiB / 16GiB", "MemPerc", … }` —
  strings that need parsing (strip `%`, parse the `used / total` byte sizes).
- **Docker Engine API** over the unix socket `/var/run/docker.sock`
  (`GET /containers/json`, `GET /containers/{id}/stats?stream=false`) via
  `@effect/platform` `HttpClient`. More robust and matches CLAUDE.md's remote/HTTP
  direction, but more setup (socket transport, compute CPU% from the stats deltas).
  Recommended once remote features are on the table; otherwise start with `docker stats`.

**Integration points (reuse existing patterns):**
- `src/types/metrics.ts`: add `DockerSnapshot { _tag: "docker"; at: Timestamp;
  containers: ReadonlyArray<{ name: string; cpu: Percent; memUsed: Bytes;
  memTotal: Bytes; status?: string }> }` to the `MetricSnapshot` union.
- `src/services/docker-collector.ts`: `Context.Tag` service (`read` + `stream`).
- `src/collectors/docker-macos.ts` (or `-cli.ts`, platform-neutral): pure parser over
  `docker stats` output (unit-testable with a captured fixture), Valibot-validate the
  rows, brand, build with `collectorStream("docker", read, gap)`.
- `src/ui/components/docker-table.ts`: a table/list of containers (consider
  `TextTableRenderable` — exported by `@opentui/core`).
- Handle "daemon not running": the collector's `read` should map that failure to a
  `CollectorError`, so the panel shows `unavailable (...)` (graceful degradation) when
  Docker is down — never a crash.
- `src/types/config.ts` + `src/services/config.ts`: add a `docker.enabled` flag
  (`--[no-]docker`); wire a panel in `src/app/main.ts`.

**Kickoff prompt:** *"Implement the deferred Docker collector from PLAN.md Future
Work: a DockerCollector reading `docker stats`, a container table panel, and a
`docker.enabled` config flag — reuse collectorStream/spawnText and degrade to
'unavailable' when the daemon is down."*

### 3. Linux platform Layers

**Goal:** make the app run on Linux, not just macOS — by adding Linux implementations
of the *existing* collector service interfaces and selecting them at runtime.

**Context / what this means:** the architecture was deliberately built "abstract now,
macOS only" (Phase 0 decision). Every collector is an Effect **Service**
(`Context.Tag`) — `CpuCollector`, `MemoryCollector`, `NetworkCollector`,
`DiskCollector` — and the only platform-specific code lives in the macOS **Layer**
implementations (`src/collectors/*-macos.ts`, which parse `top`/`vm_stat`/`netstat`/
`iostat`). "Linux Layers" = add sibling `*-linux.ts` Layers implementing the **same**
service interfaces from Linux data sources, then pick the right Layer per platform.
Because the app depends only on the Service Tags, **nothing else changes** — this is
the concrete payoff that validates the whole abstraction.

**Linux data sources (all in procfs; mostly cumulative → diff two samples):**
- **CPU** → `/proc/stat` first line `cpu  user nice system idle iowait irq softirq …`.
  Read twice; `busy% = 1 − Δidle / Δtotal`. (macOS used `top`'s precomputed delta;
  here you compute it — like the network collector already does.)
- **Memory** → `/proc/meminfo` (`MemTotal`, `MemAvailable`; `used = total − available`).
  Instantaneous, no diff.
- **Network** → `/proc/net/dev` (per-interface cumulative rx/tx bytes). Diff two
  samples — can **reuse `computeRates`** from `network-macos.ts` (extract it to a
  shared module if so).
- **Disk** → `/proc/diskstats` (sectors read/written; bytes = sectors × 512). Diff two
  samples for bytes/sec.

**Implementation notes:**
- Read procfs with `Bun.file("/proc/stat").text()` (no subprocess) — consider a small
  `readProcFile` helper analogous to `spawnText`, still interruptible-friendly.
- Keep parsers **pure** (`parseProcStat`, `parseMeminfo`, …) and unit-test with
  captured `/proc/*` fixtures (these tests run anywhere; the live integration tests
  only run on Linux — gate with `process.platform === "linux"` or run in Linux CI).
- **Platform selection:** in `src/app/main.ts` (or a small `layers.ts`), choose per
  service, e.g. `const CpuLive = process.platform === "linux" ? CpuCollectorLinuxLive
  : CpuCollectorMacOSLive;` then `Layer.mergeAll(...)` as today. Snapshot types,
  `collectorStream`, the store, components, and config are all reused unchanged.

**Kickoff prompt:** *"Implement the deferred Linux Layers from PLAN.md Future Work:
add `*-linux.ts` Layers for the CPU/memory/network/disk services reading from procfs,
with pure fixture-tested parsers, and select macOS vs Linux Layers by
`process.platform` in main.ts."*

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

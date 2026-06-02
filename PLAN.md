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

## Phase 0 — Foundation ✅ (in progress)
**Goal:** project skeleton, dependencies, shared types compile.

- [x] `bun add effect`.
- [ ] Create `/src` tree (`services`, `collectors`, `ui`, `app`, `types`).
- [ ] `/src/types/errors.ts` — error taxonomy as `Data.TaggedError`:
  `CollectorError` (recoverable), `ConfigError` (fatal), `RenderError` (degrade).
- [ ] `/src/types/metrics.ts` — `MetricSnapshot` value type + branded types
  (`Percent`, `Timestamp`). Discriminated union keyed by `_tag`.

**Milestone:** `bun run typecheck` passes; `bun index.ts` still renders.

---

## Phase 1 — CPU collector (the Effect core lesson)
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

## Phase 2 — Streaming + MetricsStore
**Goal:** continuous, cancellable, resource-managed metric flow.

- `read` → `Stream<CpuSnapshot, CollectorError>` (`Stream.repeatEffect` + `Schedule`).
  Collector owns interval + recovery (`catchTag` → "unavailable" snapshot, keep going).
- `/src/services/metrics-store.ts` — `Ref`-backed map keyed by collector tag.
  Writes from the collector fiber; reads are pull-based.
- Collector runs as a fiber via `acquireRelease`; Ctrl+C tears it down cleanly.

**Milestone:** CPU value updates every N ms in console; clean Ctrl+C shutdown.

---

## Phase 3 — TUI wiring (vanilla OpenTUI)
**Goal:** live CPU gauge on screen, pull-based reads.

- `/src/app/main.ts` — `BunRuntime.runMain`, compose Layers, start renderer
  (reuse `createCliRenderer` config from `index.ts`).
- `/src/ui/components/` — CPU gauge (% text + bar); read latest snapshot from
  `MetricsStore` each render tick (never push fiber→component).
- `RenderError` → log to a debug line, never crash the loop.

**Milestone:** a live, updating CPU gauge in the terminal.

---

## Phase 4 — Per-core + history graph
- Per-core breakdown; rolling history ring buffer → sparkline/graph component.

**Milestone:** per-core bars + a scrolling CPU history graph.

---

## Phase 5+ — Next collectors (named, not specced)
Each reuses the Phase 1–3 pattern (Service → Layer → Stream → Store → component):
1. **Memory** via `vm_stat` / `sysctl`.
2. **Config loading** (`ConfigError`, Valibot-validated file + CLI flags).
3. **Disk / Network** via `iostat` / `netstat`.
4. **Docker** containers (once the daemon is available).
5. **Linux Layers** for existing collectors (proves the abstraction).

---

## Verification
- **Per phase:** `bun run typecheck` (`tsc --noEmit`) and `bun test` stay green.
- **Phase 1:** scratch program prints a plausible CPU % matching Activity Monitor.
- **Phase 2:** value changes on the interval; Ctrl+C exits clean, no orphaned fiber.
- **Phase 3+:** `bun src/app/main.ts` shows a live gauge vs Activity Monitor.

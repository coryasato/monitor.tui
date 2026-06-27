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

Process-feature decisions (from review): *per-process data via libproc Bun FFI*
(not `top` parsing), *launched commands aggregate the process subtree*, *launched
children are killed on monitor quit by default* (`--no-kill-on-exit` to detach).

---

## Status — Features 0 & 1 complete; next up: Feature 2

Both shipped with `tsc --noEmit` + `bun test` green and a PTY smoke test
(boots, renders, clean SIGINT, no orphaned collectors). This section is the
warm-start summary of the seams Features 2–6 consume — read it before the specs
below so you don't re-derive what already exists.

**Data / types** (`src/types/metrics.ts`)
- `MetricSnapshot` union includes `"process"` (`ProcessListSnapshot`). Brands:
  `ProcessId`, `Percent`, `Bytes`; `ProcessStatus` union; `ProcessRecord`
  (`pid`, `name` = full path, `cpuPercent`, `memBytes`, `status`).

**Process collector** (data source for Features 2 & 4)
- `ProcessCollector` service (`src/services/process-collector.ts`); macOS Layer
  = libproc FFI (`collectors/proc-macos.c` + `process-macos.ts`), Linux Layer
  (`process-linux.ts`); shared pure diff/validate in `process-common.ts`.
- CPU% is **instantaneous** (two-sample diff) normalized to share-of-machine, so
  it stays in `[0,100]`.
- **The C already emits `ppid` (field 1) and `threadnum` (field 4)**; TS only
  reads pid/cpu/rss/status/name today. Feature 2 (thread count) and Feature 4
  (ppid→subtree walk) can read those existing fields with **no C change**. For
  Feature 2 FDs you must add a `PROC_PIDLISTFDS` call (macOS) / `/proc/<pid>/fd`
  count (Linux) — MVP may return `null` (type allows it), never per-tick `lsof`.

**Renderer + input** (`src/services/renderer.ts`, `src/services/input-router.ts`)
- `Renderer` service/Layer owns `createCliRenderer`/`destroy`; get it via
  `yield* Renderer`. `RendererLive` is shared with the router via
  `InputRouterLive.pipe(Layer.provideMerge(RendererLive))` in `main.ts`.
- `InputRouter`: one keypress subscription. API: `register(mode, handler)`,
  `setMode(mode)`, `mode`, `awaitQuit`. Modes: `Normal | Filter | Focus | Modal`.
  Quit is mode-aware (`isQuitForMode`: Ctrl+C always; bare `q` only Normal/Focus).
  Handlers are `(InputKey) => Effect<void>` run **synchronously** in the keypress
  callback — must not suspend; mutate UI state then call `renderer.requestRender()`.
- Feature 2 registers `Focus`-mode handlers and calls `setMode("Focus")` on pin /
  `setMode("Normal")` on unpin; Feature 3 uses `Filter`; Feature 5 uses `Modal`.

**Redraw contract** (proven by `ui/components/process-table.ts`)
- Component shape: `update(state)` (data tick — caches snapshot, repaints, **no**
  paint request) + UI-state mutators (input — mutate + **immediate**
  `renderer.requestRender()`). The render-tick `panels` array in `main.ts` calls
  `apply: (s) => component.update(s)` on signature change.

**UI seams**
- `ProcessTable.getSelection(): ProcessRecord | null` — **Feature 2 pins this on
  `Enter`** (register an `Enter`/`"return"` handler in Normal mode).
- Layout: `split` (`flexGrow:1`, row) → left `table.root` (50%) + `rightPane`
  (50%, holds the widget `grid`). **Feature 2 swaps `rightPane`'s content**
  (widgets ↔ `ProcessFocusPanel`) driven by a `Ref<Option<ProcessId>>` pin state.
- Sparklines: reuse `ui/components/cpu-sparkline.ts` (`makeCpuSparkline`,
  `appendCapped`, `renderSparkline`, `sparkGlyph`) for Feature 2's per-PID graphs.
- Formatters: `formatBytes`, `formatRate` in `ui/format.ts`. New collectors reuse
  `collectors/collector-stream.ts` `collectorStream(tag, read, gap)`.

**Gotchas discovered (save yourself the debugging)**
- Yoga default `flexShrink` is **0** → a `height:"100%"` child overflows siblings;
  use `flexGrow:1` to fill remaining space.
- `Renderable.visible = false` sets Yoga `display:none` (excluded from layout) —
  this is how the table windows rows (a pool + toggling visibility).
- OpenTUI does **not** re-export `ParsedKey`/`KeyEvent` from the package root and
  its `exports` map blocks deep imports → use the local `InputKey` structural type.
- Parsed key names: Enter = `"return"`, Esc = `"escape"`, arrows
  `up/down/left/right`; printable text is in `key.sequence` (for Filter mode).
- Only import from `@opentui/core` and `@opentui/core/testing`.
- Tests: a table/panel root needs an explicit `height` under `createTestRenderer`
  (no `flexGrow` parent there); drive keys via `mockInput` + parsed `KeyEvent`.
- libproc skips processes whose taskinfo is unreadable (other users without
  privilege) — the table shows what the current user can read.

**Model recommendation for Feature 2:** prefer **Opus**. The UI work (right-pane
swap, sparklines, stats row) is straightforward on the seams above, but the
collector lifecycle is the risk: a PID-scoped `collectorStream` forked into a
scope opened on pin / closed on unpin (`acquireRelease` finalizer), exit
detection (attached PID vanishing from a sample → auto-unpin + toast), and a new
libproc FD call. That Effect-scope + FFI nuance is safer on Opus. If you do use
Sonnet, start FDs at the `null` MVP and lean on the acquireRelease pattern in the
existing collectors. **Feature 3 (Search/Filter)** is far more self-contained
(pure filtering + the existing `Filter` mode seam) and is a good Sonnet candidate.

---

## Next Features

Each item is self-contained: a future session starts cold with only the repo
(code + CLAUDE.md + this file + git history) — no prior chat. Everything needed to
start is in the item.

---

### 0 — Foundation ✅ COMPLETE

**Goal:** the shared infrastructure every interactive feature builds on — split
layout, input routing, the redraw model, and the libproc process collector. This
is the keystone Features 1–5 consume; it ships no user-facing feature on its own.
Build it (and validate it against its first consumer, Feature 1) before the rest.

**Split layout.** Restructure the top-level layout in `main.ts` into two vertical halves:
- **Left 50%** — an (initially empty) container that Feature 1 fills with the process table.
- **Right 50%** — the existing widget stack (CPU gauge + sparkline, MEM, NET, DISK), unchanged — the split just moves it to the right column.

When a process is pinned (Feature 2) the right half swaps from widgets to the focus
panel, so both panes are addressable from the start.

**Process types + libproc collector** (data source shared by Features 1, 2, 4):
- Types (`src/types/metrics.ts`): `ProcessId` brand; `ProcessRecord` (`pid`, `name`,
  `cpuPercent`, `memBytes`, `status`); `ProcessListSnapshot` with `_tag: "process"`
  carrying `processes: ReadonlyArray<ProcessRecord>` — one snapshot holds the whole
  table. Add it to the `MetricSnapshot` union; `MetricTag` gains `"process"` and
  `MetricsStore` is unchanged.
- `ProcessCollector` service + platform Layers. **CPU% must be instantaneous, not
  a lifetime average** (`ps aux` reports CPU-time÷wall-time-since-start). Source
  per-process data via **libproc Bun FFI on macOS** — mirroring the existing
  `cpu-cores.c` harness (hand-declared symbols, compiled with `cc`) — rather than
  spawning `top` (which `cpu-macos.ts` already does once; a second `top -l 2`
  would be wasteful and ~1Hz):
  - **macOS (`proc-macos.c` + `process-macos.ts`):** `proc_listpids(PROC_ALL_PIDS)`
    for the PID set; per PID `proc_pidinfo(PROC_PIDTASKINFO)` → cumulative CPU time
    (`pti_total_user + pti_total_system`), RSS (`pti_resident_size`), threads
    (`pti_threadnum`); `proc_pidinfo(PROC_PIDTBSDINFO)` → `pbi_ppid`; `proc_pidpath`
    → full command. Instantaneous CPU% = diff two samples of cumulative CPU time
    over elapsed wall time (× normalize by core count), reusing the `cpu-cores.c`
    two-sample diff idiom. No subprocess, sub-second, full (untruncated) names.
  - **Linux (`process-linux.ts`):** enumerate `/proc/<pid>/stat`, diff
    `utime + stime` (jiffies) across two samples against total CPU jiffies from
    `/proc/stat` — canonical instantaneous method, same two-sample shape as net/disk.
  - Pure parse/diff helpers, unit-testable. Valibot validates the FFI / `/proc`
    output at the boundary.
- Long-lived collector writing the `"process"` tag via `collectorStream`
  (`src/collectors/collector-stream.ts`) — drops into the existing startup fork
  loop in `main.ts` exactly like cpu/mem/etc.

**Input model — `InputRouter`** (reused by Features 1/2/3/5):
Today the only key consumer is `awaitQuit`, which owns the sole
`renderer.keyInput.on("keypress")` subscription and unconditionally treats bare
`q`/Ctrl+C as quit. Interactive features need more keys, and a second listener
would race the first — so introduce a single **`InputRouter`**.

- One keypress subscription, owned by the `InputRouter` service/Layer — this
  **replaces** `awaitQuit`'s standalone listener. Match the *parsed* key
  `{ name, ctrl }` (reuse `isQuitKey`'s Kitty-protocol-safe approach), never raw bytes.
- **Input mode** — a discriminated union in a `Ref`:
  - `Normal` — arrows scroll, `c`/`m` sort, `k` kill, `Enter` pin, `/` → Filter,
    `q`/Ctrl+C quit. (Table handlers registered by Feature 1.)
  - `Filter` (Feature 3) — printable chars + Backspace edit the query; `Enter`
    locks (→ Normal, query retained); `Escape` clears + exits. `q`/`k` are
    **literal** here; only **Ctrl+C** quits.
  - `Focus` (Feature 2) — a PID is pinned; `Escape` unpins, `q`/Ctrl+C quit.
  - `Modal` (Feature 5) — overlay open; `Escape`/`d` dismiss, all else swallowed
    except Ctrl+C.
- **Mode-aware quit** resolves the `q`-in-text-field conflict: Ctrl+C always quits;
  bare `q` quits only in `Normal`/`Focus`. The program blocks on a quit signal
  (e.g. a `Deferred<void>` the router completes) instead of `awaitQuit`, so scoped
  teardown is unchanged.
- The active mode's handler receives the key; unhandled keys are ignored. Handlers
  that mutate UI state set a dirty flag → `requestRender()` (see "Interactive
  redraws").
- Ship the router with `Normal`-mode quit wired and the mode/dispatch mechanism in
  place; each downstream feature registers its own mode's handlers — leave those
  seams explicit.

**Interactive redraws** (reused by Features 1/2/3/5):
Today the render tick repaints only when a snapshot's signature changes —
`signatureOf` in `main.ts` is `` `${_tag}:${at}` ``. Interactive state (scroll
offset, sort key, selection, filter query, pin/unpin, modal open) doesn't touch
any snapshot's `at`, so under today's model it would never repaint, or only lag
until the next data sample (up to `refreshMs`). Decouple repaint from snapshot
change with two triggers feeding one render path:

- **Data tick** (existing fiber) — snapshot signature changed → re-apply that
  panel. Keep the signature dedup; still valuable.
- **Input events** (new) — `InputRouter` handlers mutate UI state, then re-render.
  No dedup (a keypress is always a change).
- **Interactive component contract** so both triggers share one path without
  duplicating logic:
  - `update(state)` — called by the data tick; the component **caches the latest
    snapshot** internally and re-renders.
  - UI-state mutators (`scrollBy`, `setSort`, `select`, `setFilter`, …) — called
    by input handlers; mutate internal state and re-render using the **cached**
    snapshot + new UI state.
- **Responsiveness:** an input-driven change re-renders and calls
  `renderer.requestRender()` **immediately**, independent of the `refreshMs`
  schedule, so navigation feels instant.
- **No locking:** Bun is single-threaded — the keypress callback and the
  render-tick fiber share one thread, so the two triggers interleave but never
  truly race.

**Milestone:** two-column layout renders (widgets right, empty left pane); the
`InputRouter` owns all input and quit works via the new signal in every mode's
quit rule; the process collector populates the store (assert via unit test / debug
print); the redraw contract is proven (a forced UI-state change repaints with no
data tick). **Recommended:** build Feature 0 and Feature 1 in one session so the
router + redraw contracts are validated by a real consumer while their design is fresh.

---

### 1 — Process List Panel ✅ COMPLETE

**Goal:** the scrollable process table that fills the left pane, on top of the Feature 0 foundation.

- `ProcessTableComponent` — reads the `"process"` snapshot (Feature 0 collector)
  from the store and renders it in the left pane: columns `PID`, `NAME`, `CPU%`,
  `MEM`. Scrollable (up/down arrows), sortable by CPU or MEM (toggle `c`/`m`), kill
  focused process with `k` (confirm prompt). Renders only the rows that fit the
  viewport (windowed); the rest scroll into view — no row-count config needed.
- **Selection is PID-anchored** — it follows the process across live re-sorts, not
  a fixed row index — so `k` always targets what you see; the confirm shows PID +
  name. Killing a process you don't own (EPERM) surfaces an error toast, never a
  crash (default signal SIGTERM).
- Registers its `Normal`-mode key handlers (arrows / `c` / `m` / `k`) with the
  Feature 0 `InputRouter`, and follows the interactive-redraw contract
  (`update(state)` + UI-state mutators).
- Full command names (from the Feature 0 collector's `proc_pidpath`) feed Feature 3's search.
- Config flag: `--[no-]process`, `process.enabled` in `AppConfig`. When disabled,
  the collector + table are skipped and the layout reverts to the original
  full-width widget stack.

**Milestone:** the process table renders live in the left pane, scrolls, sorts, and
a process can be killed interactively (PID-anchored selection, EPERM toast).

---

### 2 — Process Focus View

**Goal:** pin a process from the table; the right half of the layout switches from the widget stack to a dedicated live view for that PID.

- **Selection:** press `Enter` on a highlighted row. The right 50% of the layout (established in Feature 0) swaps from the metric widget stack to `ProcessFocusPanel`. Press `Escape` to unpin — right side reverts to widgets. Uses the `InputRouter`'s `Focus` mode (Feature 0).
- `ProcessFocusSnapshot` — `_tag: "process-focus"`, per-sample record for the single pinned PID: `pid`, `name`, `cpuPercent`, `memBytes`, `threadCount`, `openFds` (`number | null`), `status`. **CPU% must be instantaneous** (same reasoning as Feature 0): on macOS, source CPU **and** threads from one `proc_pidinfo(PROC_PIDTASKINFO)` call diffed across two samples — the same libproc collector as Feature 0, scoped to the pinned PID; on Linux, diff `/proc/<pid>/stat` — not `ps`/`top`. FD count comes separately via `proc_pidinfo(PROC_PIDLISTFDS)` (macOS) / `/proc/<pid>/fd` count (Linux) and **must not use per-tick `lsof`** (slow, sometimes privileged). FDs change slowly — sample at a reduced cadence (~2s) and cache between the fast CPU/mem samples so they never gate the sparkline. MVP fallback: FD count may start `null` on macOS (type already allows it) with a TODO, but never the slow `lsof` path. Add it to the `MetricSnapshot` union — `MetricTag` gains `"process-focus"`, store unchanged.
- **PID-scoped collector** — reuses `collectorStream("process-focus", readProcessFocus(pid), gap)` verbatim, forked into a **scope opened on pin and closed on unpin** (`acquireRelease`). Because only one PID is ever pinned, the tag is **stable** (`"process-focus"`), so each sample overwrites the last — no per-PID store growth, no `MetricsStore` changes. The pinned PID lives in UI interaction state (`Ref<Option<ProcessId>>`); the right-pane swap is driven by that, not by store presence. No collector runs when nothing is pinned.
- `ProcessFocusPanel` component:
  - Header: `PID 1234 — bun src/app/main.ts`
  - CPU sparkline (reuse `CpuSparkline` pattern) — rolling history for this PID only.
  - Memory sparkline — same rolling window; scaled to **% of system memory** (comparable with the MEM gauge).
  - Stats row: `Threads: 8   Open FDs: 42   Status: running`
- **PID exit handling:** when the pinned process exits, auto-unpin immediately and emit a toast: `"PID 1234 exited — See Logs / Dismiss"` ("See Logs" opens Feature 5; until 5 lands it just dismisses). Detection differs by origin: a **launched** child (Feature 4) signals exit precisely via its subprocess handle; an **attached** PID is detected best-effort when it disappears from `ps` (≤ one poll interval of latency). Either way the collector tears down cleanly via the `acquireRelease` finalizer.
- No new config flag — focus is always available when the process panel is enabled.

**Milestone:** pin a `bun` process, watch live CPU + memory sparklines in the right panel; unpin cleanly; kill the process externally and see the exit toast.

---

### 3 — Process Search & Filter

**Goal:** type to filter the process table by name so the user can find a specific process fast without scrolling 200 rows.

- Press `/` to enter the `InputRouter`'s `Filter` mode (Feature 0). A search bar appears at the top of the panel: `Filter: █`.
- Typing filters rows in real time (case-insensitive substring match on process name). Match count shown: `12 / 204`.
- `Escape` clears the filter and exits filter mode. `Enter` locks the filter in place (table stays filtered, `/` to edit again).
- Filter persists across collector refresh cycles — new processes appearing or disappearing don't reset the filter. Match count updates live: `3 / 204`.
- Filter state lives in the `ProcessTableComponent` — no new service or collector needed.
- Filtered view feeds directly into the focus/pin flow: filter to `bun`, arrow to the row, press `Enter` to pin it.

**Milestone:** press `/`, type `bun`, table narrows to matching processes; `Escape` restores the full list.

---

### 4 — Run a Command Under the Monitor

**Goal:** launch a command as a child of the TUI so it can be watched live and produce a real crash report — the "test my program and watch its resources" workflow.

**Why this exists:** the app otherwise only *attaches* to existing PIDs. On macOS you cannot `wait()` on a non-child or read its stderr, so for attached PIDs there's no exit code, signal, or output — only "it vanished from `ps`." Launching the command as a **child** unlocks all of it.

- **CLI form (MVP):** `monitor -- <command…>` — everything after `--` is the command + args. `parseArgs` (`src/services/config.ts`) currently routes unrecognized args to a fatal `ConfigError`, so it must be extended to **stop flag parsing at `--`** and collect the remainder as `launch.command`; thread a `launch` field through `CliOverrides`, `mergeConfig`, `AppConfigSchema`, and `AppConfig` (`e.g. launch: { command: ReadonlyArray<string> } | null`). (A later in-TUI launcher can reuse the Filter mode's text-input infra.)
- `LaunchedProcess` — spawn via `Bun.spawn` with `stdout`/`stderr` piped (no implicit shell — exec is direct; use `sh -c '…'` for shell features). Holds the child handle, its `ProcessId` (`proc.pid`), the command string, and a **bounded stderr ring buffer** (last N lines, default 200, `launch.stderrLines`). Managed as an `acquireRelease` resource.
- **On launch:** auto-pin the focus view (Feature 2) to the child's PID — enters `Focus` mode immediately so you watch its resource use from the first sample, no hunting in the table.
- **Subtree aggregation:** the launched program's resource view sums the child **+ all descendants** each sample (walk PID→ppid via `pbi_ppid` from the libproc snapshot). Wrapper commands (`bun run …`, `cargo`, `make`, `python -m`, `sh -c`) run the real work in grandchildren, so direct-child-only would under-report. The focus header notes the count, e.g. `PID 1234 bun run build (+3 descendants)`.
- **Stderr capture:** stream the child's stderr into the ring buffer (drop oldest). This feeds Feature 5's `stderrTail`. stdout is discarded for the MVP.
- **Exit detection:** wrap Bun's `child.exited` in an Effect — it resolves with the real `exitCode`/`signalCode`. This is the precise exit event Feature 2's toast and Feature 5's full report consume (no `ps`-polling needed for children).
- **Quit behavior:** on monitor quit, the `acquireRelease` finalizer **kills the child (and its subtree) by default** — we launched it for monitoring and own its piped stdio (leaving it running would break its stderr pipe with EPIPE anyway). `--no-kill-on-exit` detaches instead (stderr capture then stops).

**Milestone:** `monitor -- sleep 5` launches `sleep`, auto-pins it, shows its (tiny) resource use, and fires a real exit toast with code 0; `monitor -- sh -c 'echo boom >&2; exit 3'` ends with a crash report carrying exit code 3 and `boom` in the stderr tail (verified via Feature 5); `monitor -- bun run build` shows **aggregate subtree** CPU/mem (the `bun run` parent + its tsc/esbuild children), and quitting the monitor kills the child (`pgrep` clean).

---

### 5 — Process Exit Report (two tiers)

**Goal:** when a pinned process exits, surface what we can — a full crash report for processes we launched, an honest degraded notice for attached PIDs.

- Triggered by the exit toast from Feature 2 ("See Logs" action).
- `ProcessExitRecord` carries an `origin: "launched" | "attached"` discriminator so the modal renders the right tier:
  - **`launched`** (child via Feature 4) — full report: `pid`, `name`, `exitCode`, `exitSignal` (from `child.exited`), `finalCpuPercent`, `finalMemBytes` (last *observed* subtree sample — may be ≤1 cycle stale, or null for a fast-exiting process), `stderrTail` (from the ring buffer).
  - **`attached`** (existing PID from the table) — degraded notice: `pid`, `name`, `finalCpuPercent`, `finalMemBytes`, plus a stated limitation ("attached process — exit code and output unavailable"). `exitCode`/`exitSignal`/`stderrTail` are `null`.
- **Modal overlay** — full-width drawer or centered modal showing the record in a readable format. Uses the `InputRouter`'s `Modal` mode (Feature 0); `Modal` mode also handles **arrow-scroll** (a 200-line `stderrTail` won't fit on screen); dismiss with `Escape` or `d`. First interactive overlay in the app.
- **Detection source:** `launched` → precise `child.exited`; `attached` → focus collector observes the PID gone from `ps` (best-effort, ≤ one poll interval).
- No collector changes — data is captured once at exit and held in a `Ref<Option<ProcessExitRecord>>`.

**Milestone:** `monitor -- sh -c 'echo boom >&2; exit 3'`, watch it, "See Logs" on exit shows exit code 3 + `boom`; separately, pin an attached PID, kill it externally, "See Logs" shows the degraded notice (final resources, no code/stderr).

---

### 6 — Alerts & Thresholds

**Goal:** configurable high-watermark alerts that flash a panel red and optionally emit a system notification.

- `AlertConfig` — per-metric thresholds in `AppConfig`:
  ```json
  {
    "alerts": {
      "cpu": { "warn": 75, "critical": 90 },
      "memory": { "warn": 80, "critical": 95 },
      "disk": { "warn": 80, "critical": 95 }
    }
  }
  ```
- `AlertState` discriminated union: `"ok" | "warn" | "critical"`.
- A shared `resolveAlert(value, thresholds): AlertState` helper (avoids per-panel
  duplication); each panel resolves its current snapshot through it and the
  gauge/bar takes an **alert-color override** (green → yellow → red). **Network is
  excluded** — rates have no natural 0–100 ceiling.
- Optional: `osascript` (macOS) or `notify-send` (Linux) system notification on
  first crossing into `critical` (debounced — one notification per crossing, not
  per sample), with the previous `AlertState` per metric held in a `Ref` for
  crossing detection. Config flag `alerts.notify`.
- No new collector — purely a UI + config layer concern.

**Milestone:** CPU gauge turns yellow at warn and red at critical thresholds from config; system notification fires once on first critical crossing.

---

## UI Polish & Layout (Backlog)

Deferred until core features (0–6) are solid. No specs yet — pick an item, flesh it out, and move it into Next Features when ready.

- Resizable split panes (left/right via keyboard or drag)
- Widget pin/unpin with persisted layout state (written to config file — builds on existing `AppConfig` pipeline)
- Redesigned widget visuals (better gauges, richer sparklines, borders/headers)
- Theming / color scheme config

---

## Verification

**Every feature:** `bun run typecheck` (`tsc --noEmit`) and `bun test` stay green.

**Interactive features** (process table, focus, search, modals): simulate parsed
keypresses into `renderer.keyInput` via `@opentui/core/testing`'s
`createTestRenderer`; unit-test `InputRouter` mode transitions, `resolveAlert`, and
the subtree/parse/diff helpers as pure functions.

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

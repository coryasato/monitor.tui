# ARCHITECTURE.md — monitor.tui

Implementation seams and shipped-feature history for `PLAN.md`'s completed
Features 0–6. Read this before starting a Backlog item that touches the
process table, input routing, redraw contract, focus/launch/exit flow, or
alerts — it's the warm-start reference so you don't re-derive architecture
that already exists. Not needed for Backlog work that's unrelated to that
code (e.g. a pure theming pass may not touch any of it).

---

## Architecture Reference — seams consumed across Features 0–6

All shipped with `tsc --noEmit` + `bun test` green and a PTY smoke test
(boots, renders, clean SIGINT, no orphaned collectors). This section is the
warm-start summary of the seams the codebase now provides. **Feature
2's own seams (focus snapshot, `focusStream`, the macOS multi-libproc-module
FFI gotcha, exit detection) are summarized under "### 2 — Process Focus View
✅ COMPLETE" below, not repeated here.**

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
- Every printable single-char key (letters/digits/symbols) has a
  **one-character `name`** (`key.name.length === 1 && !ctrl && !meta` = typed
  text, no denylist needed); named/control keys (`return`, `escape`,
  `backspace`, `tab`, `space`, arrows, function keys) always have a
  multi-character `name`. Trap: `backspace`'s *sequence* is also length 1, so
  check `name === "backspace"` before the generic length-1 branch.
- Only import from `@opentui/core` and `@opentui/core/testing`.
- Tests: a table/panel root needs an explicit `height` under `createTestRenderer`
  (no `flexGrow` parent there); drive keys via `mockInput` + parsed `KeyEvent`.
- libproc skips processes whose taskinfo is unreadable (other users without
  privilege) — the table shows what the current user can read.

---

## Completed Features (0–6)

All seven milestones below are implemented, tested, and merged. Kept as the
historical record of what shipped, plus feature-specific gotchas not already
covered in the Architecture Reference above (notably Feature 2's macOS FFI
dual-module bug). A future session touching this code can start here cold —
no prior chat needed.

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
data tick).

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

### 2 — Process Focus View ✅ COMPLETE

Shipped green (`tsc --noEmit` + `bun test`, plus a real-pty smoke: boot → `Enter`
pins → Focus panel with live CPU/MEM sparklines + stats → `Escape` unpins →
external kill fires the exit toast). Seams Features 4 & 5 consume:

- **Types** (`src/types/metrics.ts`): `ProcessFocusSnapshot` (`_tag:
  "process-focus"`; `pid`, `name`, `cpuPercent`, `memBytes`, `memPercent`,
  `threadCount`, `openFds: number | null`, `status`) in the `MetricSnapshot`
  union. The PID-scoped focus stream writes it to the store under the single
  stable `"process-focus"` tag — each sample overwrites the last.
- **Collector**: `ProcessCollector.focusStream(pid)` (`process-{macos,linux}.ts`),
  forked into a `Scope.make()` opened on pin / closed on unpin via
  `Effect.forkIn` + `Fiber.interruptFork` (see `main.ts` focus-lifecycle block).
  Pure assembly in `process-common.ts` (`toFocusSnapshot`, `memPercentOf` using
  `os.totalmem()`). CPU% is the same two-sample instantaneous diff as the table.
- **⚠️ macOS FFI gotcha (cost me hours — read before touching the C):** you
  **cannot** run a *second* libproc TinyCC module alongside `read_processes`.
  A dedicated per-PID `read_process_focus` (its own `proc_pidinfo`) **permanently**
  starts returning -1 for even a live PID once `read_processes` has run — across
  separate `cc()` calls *and* separate `.c` files, and it stays broken after the
  list stops. Two callers of the *one* `read_processes` module are fine. So macOS
  focus reuses `read_processes` filtered to the PID (threads = field 4, already
  emitted). **Consequence: `openFds` is `null` on macOS** (the sanctioned MVP
  fallback — never `lsof`); see `TODO(macos-fds)` in `process-macos.ts`. **Linux**
  uses a dedicated `/proc/<pid>` reader with **real** `openFds` (no FFI, no
  interference). (Also saved in [[opentui-gotchas]].)
- **Exit detection** (attached PID): the render-tick `checkFocusExit` in `main.ts`
  unpins + toasts (`table.notify`) when the pinned PID vanishes from the
  `"process"` snapshot (≤ one poll interval). Feature 4's launched child will
  instead use its precise `child.exited` handle.
- **UI**: `ProcessFocusPanel` (`ui/components/process-focus-panel.ts`) —
  `prime(pid, name)` on pin (resets history), `update(state)` per redraw contract.
  Right pane swaps grid↔panel via `visible` toggle (no tree churn). Table gained
  `getSelection()` consumer + `isAwaitingConfirm()` / `notify()`.

**Milestone:** pin a `bun` process, watch live CPU + memory sparklines in the
right panel; unpin cleanly; kill the process externally and see the exit toast.

---

### 3 — Process Search & Filter ✅ COMPLETE

Shipped green (`tsc --noEmit` + `bun test`, plus a real-pty boot/quit smoke:
clean render, no stderr, no orphaned collectors). Purely a `ProcessTable` +
`InputRouter` consumer — no new service, collector, or store tag. Seams later
features consume:

- **Filter state lives in `ProcessTable`** (`ui/components/process-table.ts`):
  `filterMode` (editing, cursor shown) + `filterQuery` (persists once locked)
  are private closure state, not exposed as store/service state. New table
  methods: `startFilter()`, `onFilterKey(key)` (text edit only), `lockFilter()`
  (Enter), `clearFilter()` (Escape). `sorted()` now runs `filterProcesses` (pure,
  case-insensitive substring against the **full name/command**, not just the
  display basename — exported for unit testing) before `sortProcesses`, so
  selection/sort/scroll/kill/pin all transparently operate on the filtered set
  with no changes to that logic.
- **Mode transitions live in `main.ts`**, mirroring Feature 2's pin/unpin
  split: the table owns text-edit state, `main.ts` owns `router.setMode`. `/`
  in `Normal` (guarded by `table.isAwaitingConfirm()`, like `Enter`) calls
  `table.startFilter()` then `setMode("Filter")`; the `Filter`-mode handler
  routes `return`→`lockFilter`+`setMode("Normal")`, `escape`→`clearFilter`+
  `setMode("Normal")`, everything else→`onFilterKey`.
- **Key-parsing gotcha (also in [[opentui-gotchas]]):** OpenTUI's parser gives
  every printable single-char key (letters, digits, symbols) a **one-character
  `name`** (uppercase letters are lowercased in `name`, with `shift: true`) —
  named/control keys (`return`, `escape`, `backspace`, `tab`, `space`, arrows,
  function keys, ...) always have a **multi-character `name`**. So
  `key.name.length === 1 && !key.ctrl && !key.meta` cleanly selects "this is
  typed text" with no denylist — but a same-length-1 trap exists: `backspace`'s
  *sequence* (`\x7F`/`\b`) is also length 1, so it must be checked by `name`
  **before** the generic branch, not folded into it. Use `key.sequence` (not
  `key.name`) to append the character so typed case is preserved.
- **UI:** a `Filter:` bar (new `TextRenderable`, first child of `root` so it
  sits above the header) is visible whenever `filterMode || filterQuery.length
  > 0` — shows a `█` cursor only while `filterMode` is true, and always shows
  the live match count `N / total`. Locking (Enter) keeps the bar (query
  retained, cursor gone); clearing (Escape) hides it and restores the full
  list. Zero matches replaces the row-pool placeholder with `no matches for
  "<query>"` instead of the generic `no processes` message.
- **Mode-aware quit already covered this for free:** `isQuitForMode` (Feature
  0) already treats bare `q`/`k` as literal outside `Normal`/`Focus`, so typing
  "quick" into the filter query doesn't quit or open a kill confirm — no new
  logic needed, just a regression test proving it.

**Milestone:** press `/`, type `bun`, table narrows to matching processes;
`Escape` restores the full list.

---

### 4 — Run a Command Under the Monitor ✅ COMPLETE

Shipped green (`tsc --noEmit` + `bun test`, plus a real-PTY smoke driving all four
milestone forms: `-- sleep 2` auto-pins + exits code 0; `-- sh -c 'echo boom >&2;
exit 3'` exits code 3; `-- sleep 30` quit-early leaves no orphan; `-- sh -c 'sleep
6 & sleep 6 & wait'` shows `(+2 descendants)` and the subtree is group-killed on
quit). Seams Feature 5 consumes:

- **CLI (`src/services/config.ts`):** `AppConfig.launch` is
  `{ command, killOnExit, stderrLines } | null`. `parseArgs` collects the command
  from a `--` **or from the first bare positional token** — because **Bun strips a
  leading `--`** before the script sees it (`bun main.ts -- sleep 2` arrives as
  `["sleep","2"]`), so the bare-positional path is what actually fires in practice
  (`monitor sleep 2` works too — also saved in [[bun-dashdash-argv-quirk]]).
  `--no-kill-on-exit` clears `killOnExit`. Launch requires the process panel
  (cross-validated → `ConfigError`); a bare `--` with no command is a `ConfigError`.
- **`LaunchedProcess` (`src/services/launched-process.ts`):** `launchProcess(cmd,
  {killOnExit, stderrLines})` is a scope-bound resource. Spawns **detached**
  (`setsid`, own process group) with `stdout:"ignore"`, `stderr:"pipe"`. Finalizer
  group-kills (`process.kill(-pid, …)`) unless `killOnExit` is false. Exposes
  `pid`, `command`, `awaitExit` (wraps `child.exited` → real `{exitCode,
  signalCode}` — the precise event, no ps-polling), and `stderrTail()` (a bounded
  **`LineRing`**, exported + unit-tested, fed by a scoped stderr pump). **Feature 5's
  `launched` report reads `awaitExit` + `stderrTail()`.**
- **Subtree aggregation:** `ProcessCollector.subtreeFocusStream(pid)` (both
  platforms) sums the child **+ all descendants** each sample — pure
  `collectDescendants` / `aggregateSubtree` in `process-common.ts` (ppid-walk;
  CPU delta only over pids in both samples so fresh forks don't spike). The macOS
  reader adds `F_PPID`/threads decoding to the existing `read_processes` module (no
  C change). `ProcessFocusSnapshot.descendantCount` is `number` for a subtree, `null`
  for a single attached PID; the focus panel appends `(+N descendants)` and keeps
  the primed command string (not the resolved exe path) for the subtree view.
- **main.ts wiring:** `pin` refactored to `pinStream(pid, name, stream)`; the
  launched child auto-pins via `subtreeFocusStream` into `Focus` mode. A forked
  watcher on `awaitExit` toasts `PID N exited (code C / signal S)` and auto-unpins.
  `launchedPidRef` makes the attached-PID `checkFocusExit` (ps-absence) skip the
  launched child, so its exit is handled solely by the precise watcher.

**Milestone:** `monitor -- sleep 5` launches `sleep`, auto-pins it, shows its
(tiny) resource use, and fires a real exit toast with code 0; `monitor -- sh -c
'echo boom >&2; exit 3'` ends with a crash report carrying exit code 3 and
`boom` in the stderr tail (verified via Feature 5); `monitor -- bun run build`
shows **aggregate subtree** CPU/mem (the `bun run` parent + its tsc/esbuild
children), and quitting the monitor kills the child (`pgrep` clean).

---

### 5 — Process Exit Report (two tiers) ✅ COMPLETE

Shipped green (`tsc --noEmit` + `bun test`, plus real-PTY smokes: `monitor --
sh -c 'echo boom >&2; exit 3'` then `l` shows `exit code 3` + `boom` in the
stderr tail; separately, filtering to and pinning an attached `sleep`, killing
it externally, then `l` shows `attached process — exit code and output
unavailable` with the last-observed final CPU/MEM). No seams noted for later
features — Feature 6 doesn't consume this one.

- **Types** (`src/types/process-exit.ts`, new file — deliberately *not* added to
  `types/metrics.ts`, since a `ProcessExitRecord` never flows through the
  `MetricsStore`): `LaunchedExitRecord | AttachedExitRecord`, discriminated on
  `origin`, both carrying `pid`, `name`, `finalCpuPercent: Percent | null`,
  `finalMemBytes: Bytes | null`. Only `launched` carries `exitCode`,
  `exitSignal`, `stderrTail`; `attached` types those `null`.
- **Capture (`main.ts`, no collector changes)**: a `lastFocusSampleRef` is reset
  on every fresh pin and updated on every **`ok`** sample from the pinned
  process/subtree's focus stream (inside `pinStream`'s `Stream.runForEach`) —
  this is the source of `finalCpuPercent`/`finalMemBytes` for *either* origin,
  since by the time exit is detected the focus stream has usually already gone
  `unavailable`. A `pinnedNameRef` tracks the display name (attached exit has no
  other source once the PID is gone from `ps`). `exitRecordRef` holds the most
  recently captured record — `attached` built in `checkFocusExit`'s ps-absence
  branch (before `unpin`), `launched` built in the `handle.awaitExit` watcher
  (using `handle.stderrTail()` + the real `exitCode`/`signalCode`).
- **UI (`src/ui/components/process-exit-modal.ts`)**: a **full-pane
  visible-toggle overlay**, not a z-index overlay (OpenTUI has none) — `main.ts`
  toggles `split.visible` / `exitModal.root.visible` exactly like the Feature 2
  grid↔focus swap. `show(record)` primes content + resets scroll; `onKey` only
  moves the stderr scroll cursor (Escape/`d` are intercepted by `main.ts`, not
  passed through). Stderr scrolling **reuses `clampScroll` + the row-pool
  windowing pattern from `process-table.ts`** verbatim (a `cursor` index moved
  by arrows/pageup/pagedown, clamped into `[0, total-1]`, then `clampScroll`
  derives the minimal-adjustment `offset` — the same mechanics as table
  selection, not a bespoke scrollbar).
- **Input wiring**: `l` in `Normal` mode opens the modal (only if
  `exitRecordRef` is `Some` — the toast that announced it may have already
  faded, so `l` works independently of toast visibility) via a new
  `InputRouter.register("Modal", …)` handler; dismiss returns to `Focus` if a
  process is still pinned, else `Normal`.

**Milestone:** `monitor -- sh -c 'echo boom >&2; exit 3'`, watch it, "See Logs"
on exit shows exit code 3 + `boom`; separately, pin an attached PID, kill it
externally, "See Logs" shows the degraded notice (final resources, no
code/stderr).

---

### 6 — Alerts & Thresholds ✅ COMPLETE

Shipped green (`tsc --noEmit` + `bun test`), plus a real-PTY smoke: a config
file pinning `alerts.cpu.warn`/`critical` to `0` turns the CPU bar red
(`#FF5555`) on the very first real sample. No seams noted for later features —
this closes out the original feature list; only Backlog items (no specs yet)
remain.

- **Config** (`src/types/config.ts` + `src/services/config.ts`): `AppConfig.alerts`
  — `cpu`/`memory` thresholds as `usedPercent` in `[0,100]`; **`disk` is MB/s
  throughput** (binary MiB, matching `formatRate`), not a percentage — disk has
  no natural 0–100 ceiling and this feature adds no new collector, so it
  thresholds the existing `bytesPerSec` instead of capacity. `notify: boolean`
  (default `false`). Thresholds are **file-only** (six numbers is too many CLI
  flags, mirroring `launch.stderrLines`); `notify` also has `--notify`/
  `--no-notify`. Valibot's `v.check` enforces `warn <= critical` per pair
  (fatal `ConfigError` otherwise, same as any other invalid config).
- **`src/ui/alerts.ts`** (new, pure): `AlertState = "ok" | "warn" | "critical"`,
  `resolveAlert(value, thresholds)`, `alertColor(state)` (green/amber/red — the
  same three hexes `loadColor` already used), and `crossedIntoCritical(prev,
  next)` — the notification debounce predicate. `cpu-gauge.ts`,
  `memory-gauge.ts`, and `disk-readout.ts` each now take an `AlertThresholds`
  constructor arg and color their bar/value text through these instead of the
  old hardcoded `loadColor`. **`loadColor` itself is untouched** — `cpu-cores.ts`
  still uses it for per-core bars, which this feature deliberately doesn't
  bring under config (no per-core thresholds in scope).
- **Notification** (`src/services/notify.ts`, new): `sendNotification(title,
  message)` shells out to `osascript` (macOS) / `notify-send` (Linux) via
  `Bun.$`, **never fails** (`Effect.catchAll` swallows a missing binary or a
  bad spawn — the in-TUI color is the ground truth either way). `main.ts`
  forks it (`Effect.forkScoped`) rather than awaiting it, so a slow/missing
  notifier can't stall the render tick.
- **Crossing detection** (`main.ts`, gated on `config.alerts.notify`): a
  `checkAlerts` effect (same per-tick shape as Feature 2's `checkFocusExit`)
  reads `cpu`/`memory`/`disk` from the `MetricsStore`, resolves each through
  `resolveAlert`, and compares against a `Map<MetricTag, AlertState>` of the
  previous tick's state to fire `crossedIntoCritical` exactly once per
  crossing — not once per sample while a metric stays critical.

**Milestone:** CPU gauge turns yellow at warn and red at critical thresholds
from config; system notification fires once on first critical crossing.

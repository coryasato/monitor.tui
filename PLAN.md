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

## Next Features

Each item is self-contained: a future session starts cold with only the repo
(code + CLAUDE.md + this file + git history) — no prior chat. Everything needed to
start is in the item.

---

### 1 — Process List Panel

**Goal:** a 50/50 split layout — process table on the left, existing metric widgets on the right.

**Layout redesign:** this feature restructures the top-level layout. The terminal is divided into two vertical halves:
- **Left 50%** — `ProcessTableComponent`, scrollable, fills available height.
- **Right 50%** — the existing widget stack (CPU gauge + sparkline, MEM, NET, DISK). This side is unchanged from today; the split just moves it to the right column.

This layout is the foundation for Feature 2: when a process is pinned, the right half swaps from widgets to the focus panel.

- `ProcessSnapshot` — per-process record: `pid`, `name`, `cpuPercent`, `memBytes`,
  `status`. Branded types for pid (`ProcessId`).
- `ProcessCollector` service + macOS Layer: source `ps aux` (or on Linux, `/proc`
  enumeration via the existing procfs Layer). Pure `parseProcessList(raw)`,
  unit-testable. Valibot validates at the boundary.
- `ProcessTableComponent` — scrollable list (up/down arrow keys), columns: `PID`,
  `NAME`, `CPU%`, `MEM`. Sortable by CPU or MEM (toggle with `c`/`m`). Kill
  focused process with `k` (confirm prompt).
- Reuse `collectorStream` from `src/collectors/collector-stream.ts`.
- Config flag: `--[no-]process`, `process.enabled` in `AppConfig`. When disabled, layout reverts to the original full-width widget stack.
- `process.maxRows` config option (default: fill available height).

**Milestone:** 50/50 layout renders — process table live on the left, metric widgets on the right. Table scrolls, sorts, and a process can be killed interactively.

---

### 2 — Process Focus View

**Goal:** pin a process from the table; the right half of the layout switches from the widget stack to a dedicated live view for that PID.

- **Selection:** press `Enter` on a highlighted row. The right 50% of the layout (established in Feature 1) swaps from the metric widget stack to `ProcessFocusPanel`. Press `Escape` to unpin — right side reverts to widgets.
- `ProcessFocusSnapshot` — per-sample record for a single PID: `cpuPercent`, `memBytes`, `threadCount`, `openFds`, `status`. Sourced from `ps -p <pid> -o ...` (macOS) or `/proc/<pid>/status` + `/proc/<pid>/fd` (Linux).
- **PID-scoped collector** — dynamically created on pin, torn down on unpin via `acquireRelease`. Registers in `MetricsStore` under a `pid:<n>` tag. No collector runs when nothing is pinned.
- `ProcessFocusPanel` component:
  - Header: `PID 1234 — bun src/app/main.ts`
  - CPU sparkline (reuse `CpuSparkline` pattern) — rolling history for this PID only.
  - Memory sparkline — same rolling window.
  - Stats row: `Threads: 8   Open FDs: 42   Status: running`
- **PID exit handling:** if the pinned process exits, auto-unpin immediately and emit a toast notification: `"PID 1234 exited — See Logs / Dismiss"`. "See Logs" is a stub for Feature 6; for now it dismisses. The collector tears down cleanly via the `acquireRelease` finalizer.
- No new config flag — focus is always available when the process panel is enabled.

**Milestone:** pin a `bun` process, watch live CPU + memory sparklines in the right panel; unpin cleanly; kill the process externally and see the exit toast.

---

### 6 — Process Crash / Log Viewer

**Goal:** when a pinned process exits unexpectedly, surface a modal or drawer with available diagnostic data — exit code, stderr tail, resource usage at exit.

- Triggered by the exit toast from Feature 2 ("See Logs" action).
- `ProcessExitRecord` — captured at the moment of exit: `pid`, `name`, `exitCode`, `exitSignal`, `finalCpuPercent`, `finalMemBytes`, `stderrTail` (last N lines if the process was launched from this TUI; `null` if attached to an existing PID).
- **Modal overlay** — full-width drawer slides up from the bottom or a centered modal: shows the exit record in a readable format. Dismiss with `Escape` or `d`.
- **Constraint:** if the process was not launched by this TUI (i.e., we attached to an existing PID), stderr is unavailable — show what we have (exit code, signal, final resource snapshot) and note the limitation.
- Adds the concept of a modal/overlay layer to the OpenTUI layout — the first interactive overlay in the app.
- No collector changes — data is captured once at exit and held in a `Ref<Option<ProcessExitRecord>>`.

**Milestone:** kill a pinned process; "See Logs" opens a modal showing exit code and final resource stats; `Escape` dismisses.

---

### 3 — Process Search & Filter

**Goal:** type to filter the process table by name so the user can find a specific process fast without scrolling 200 rows.

- Press `/` in the process table to enter filter mode. A search bar appears at the top of the panel: `Filter: █`.
- Typing filters rows in real time (case-insensitive substring match on process name). Match count shown: `12 / 204`.
- `Escape` clears the filter and exits filter mode. `Enter` locks the filter in place (table stays filtered, `/` to edit again).
- Filter persists across collector refresh cycles — new processes appearing or disappearing don't reset the filter. Match count updates live: `3 / 204`.
- Filter state lives in the `ProcessTableComponent` — no new service or collector needed.
- Filtered view feeds directly into the focus/pin flow: filter to `bun`, arrow to the row, press `Enter` to pin it.

**Milestone:** press `/`, type `bun`, table narrows to matching processes; `Escape` restores the full list.

---

### 4 — Thermal & Battery Panel

**Goal:** CPU temperature and battery stats for laptops; graceful no-op on desktops/Linux.

- `ThermalSnapshot` — `cpuTempCelsius: number | null` (null when unavailable).
- `BatterySnapshot` — `percent: number`, `charging: boolean`, `timeRemaining: number | null`.
- macOS Layer:
  - Thermal: `ioreg -rn AppleSmartBattery` or `sudo powermetrics --samplers smc -n 1`
    (prefer `ioreg` — no sudo). Fall back gracefully to `null` if unavailable.
  - Battery: `pmset -g batt`. Pure `parseBattery(raw)`, unit-testable.
- `ThermalBatteryReadout` component — single compact row: `CPU 42°C  🔋 87% (2h 14m)`.
  Hidden entirely when both snapshots are unavailable (desktop/Linux).
- Config flag: `--[no-]thermal`.

**Milestone:** thermal + battery row renders on a MacBook; missing on a desktop with no battery.

---

### 5 — Alerts & Thresholds

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
- Each panel component reads its current snapshot and resolves `AlertState`; the
  gauge/bar renders in the matching color (green → yellow → red).
- Optional: `osascript` (macOS) or `notify-send` (Linux) system notification on
  first crossing into `critical` (debounced — one notification per crossing, not
  per sample). Config flag `alerts.notify`.
- No new collector — purely a UI + config layer concern.

**Milestone:** CPU gauge turns yellow at warn and red at critical thresholds from config; system notification fires once on first critical crossing.

---

## UI Polish & Layout (Backlog)

Deferred until core features (1–6) are solid. No specs yet — pick an item, flesh it out, and move it into Next Features when ready.

- Resizable split panes (left/right via keyboard or drag)
- Widget pin/unpin with persisted layout state (written to config file — builds on existing `AppConfig` pipeline)
- Redesigned widget visuals (better gauges, richer sparklines, borders/headers)
- Theming / color scheme config

---

## Verification

**Every feature:** `bun run typecheck` (`tsc --noEmit`) and `bun test` stay green.

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

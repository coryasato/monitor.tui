import {
  BoxRenderable,
  type CliRenderer,
  type Renderable,
  TextAttributes,
  TextRenderable,
} from "@opentui/core";
import { Option } from "effect";
import type { InputKey } from "../../services/input-router.ts";
import type {
  MetricState,
  ProcessId,
  ProcessRecord,
} from "../../types/metrics.ts";
import { formatBytes } from "../format.ts";

/**
 * The scrollable process table that fills the left pane. It follows the Feature 0
 * interactive-redraw contract: `update(state)` caches the latest snapshot and
 * repaints (driven by the data tick), while the UI-state mutators — invoked from
 * the InputRouter's `Normal`-mode handler via {@link ProcessTable.onKey} — mutate
 * selection/sort/scroll and repaint immediately. Only the rows that fit the
 * viewport are built (windowed); the rest scroll into view.
 *
 * Selection is **PID-anchored**: it tracks a `ProcessId`, not a row index, so it
 * follows a process across live re-sorts and table churn — `k` always targets the
 * highlighted row. Killing a process you can't signal (EPERM) surfaces a toast
 * rather than crashing.
 */

export type SortKey = "cpu" | "mem";

/** A side-effecting kill, injected so tests don't signal real processes. */
export type KillFn = (pid: number, signal: NodeJS.Signals) => void;

export interface ProcessTableOptions {
  /** Override the kill syscall (defaults to `process.kill`). */
  readonly kill?: KillFn;
}

export interface ProcessTable {
  readonly root: Renderable;
  /** Data tick: cache the latest store state and repaint (no immediate paint request). */
  readonly update: (state: Option.Option<MetricState>) => void;
  /** Feed a parsed key from the InputRouter's `Normal`-mode handler. */
  readonly onKey: (key: InputKey) => void;
  /** The currently highlighted process, or `null` if the table is empty. Feature 2 pins this. */
  readonly getSelection: () => ProcessRecord | null;
  /** The active sort column. */
  readonly getSortKey: () => SortKey;
  /** Whether a kill confirm is open — Feature 2 suppresses `Enter`-to-pin while it is. */
  readonly isAwaitingConfirm: () => boolean;
  /** Show a transient toast in the footer (e.g. Feature 2's "PID exited" notice). */
  readonly notify: (message: string) => void;
  /** Enter Filter mode (the `/` handler in Normal mode calls this, then sets the InputRouter's mode). */
  readonly startFilter: () => void;
  /** Feed a parsed key from the InputRouter's `Filter`-mode handler (text edit only — Enter/Escape are mode transitions the caller handles). */
  readonly onFilterKey: (key: InputKey) => void;
  /** `Enter` in Filter mode: stop editing, keep the query applied (`/` re-enters to edit). */
  readonly lockFilter: () => void;
  /** `Escape` in Filter mode: clear the query and stop editing. */
  readonly clearFilter: () => void;
}

const clamp = (n: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, n));

/**
 * Pure: case-insensitive substring match against the full process name/command
 * (not just the display basename — `Full command names ... feed Feature 3's
 * search`), so `bun` also matches a path like `/usr/local/bin/bun`. An empty
 * query is a no-op. Exported for unit testing.
 */
export function filterProcesses(
  procs: ReadonlyArray<ProcessRecord>,
  query: string,
): ProcessRecord[] {
  if (query.length === 0) return [...procs];
  const q = query.toLowerCase();
  return procs.filter((p) => p.name.toLowerCase().includes(q));
}

/**
 * Pure: sort a copy of the process list by the active column, descending, with a
 * stable pid tie-break so equal-metric rows keep a deterministic order across
 * samples. Exported for unit testing.
 */
export function sortProcesses(
  procs: ReadonlyArray<ProcessRecord>,
  key: SortKey,
): ProcessRecord[] {
  const metric =
    key === "cpu"
      ? (p: ProcessRecord) => p.cpuPercent
      : (p: ProcessRecord) => p.memBytes;
  return [...procs].sort(
    (a, b) => metric(b) - metric(a) || (a.pid as number) - (b.pid as number),
  );
}

/**
 * Pure: resolve the selected row index. When the anchored pid is still present
 * (`foundIndex >= 0`) it wins; otherwise the selection falls back to the same
 * position it last held (clamped), so a vanished process moves selection to
 * whatever now occupies that slot rather than jumping to the top. Exported for
 * unit testing.
 */
export function resolveSelectedIndex(
  total: number,
  foundIndex: number,
  fallbackIndex: number,
): number {
  if (total === 0) return -1;
  if (foundIndex >= 0) return foundIndex;
  return clamp(fallbackIndex, 0, total - 1);
}

/**
 * Pure: the scroll offset that keeps `selIndex` visible within a `viewport`-row
 * window over `total` rows, minimally adjusting the previous `offset`. Exported
 * for unit testing.
 */
export function clampScroll(
  selIndex: number,
  offset: number,
  viewport: number,
  total: number,
): number {
  if (viewport <= 0 || total <= 0) return 0;
  let next = offset;
  if (selIndex < next) next = selIndex;
  else if (selIndex >= next + viewport) next = selIndex - viewport + 1;
  const maxOffset = Math.max(0, total - viewport);
  return clamp(next, 0, maxOffset);
}

/** Display name: the path basename (the informative tail), or the raw name. */
export function displayName(name: string): string {
  const slash = name.lastIndexOf("/");
  const base = slash >= 0 ? name.slice(slash + 1) : name;
  return base.length > 0 ? base : name;
}

const PID_W = 6;
const CPU_W = 6;
const MEM_W = 9;
/** Column gaps: PID·NAME·CPU·MEM → 3 single spaces of separation. */
const FIXED_W = PID_W + CPU_W + MEM_W + 3;
const MIN_NAME_W = 6;

/** Name column width for a given body width (what's left after the fixed columns). */
export function nameWidthFor(bodyWidth: number): number {
  return Math.max(MIN_NAME_W, bodyWidth - FIXED_W);
}

const padStart = (s: string, w: number): string =>
  s.length >= w ? s.slice(0, w) : s.padStart(w);
const fitName = (s: string, w: number): string =>
  s.length > w ? s.slice(0, w) : s.padEnd(w);

/**
 * Pure: format one process row to `PID  NAME  CPU%  MEM`, padded to `bodyWidth`
 * so a selection-highlight background spans the full row. Exported for unit testing.
 */
export function formatProcessRow(p: ProcessRecord, bodyWidth: number): string {
  const nameW = nameWidthFor(bodyWidth);
  const pid = padStart(String(p.pid as number), PID_W);
  const name = fitName(displayName(p.name), nameW);
  const cpu = padStart(`${(p.cpuPercent as number).toFixed(1)}%`, CPU_W);
  const mem = padStart(formatBytes(p.memBytes as number), MEM_W);
  return `${pid} ${name} ${cpu} ${mem}`.padEnd(bodyWidth);
}

/** Pure: the header row, marking the active sort column with a ▼. Exported for testing. */
export function formatHeader(bodyWidth: number, sortKey: SortKey): string {
  const nameW = nameWidthFor(bodyWidth);
  const pid = "PID".padStart(PID_W);
  const name = fitName("NAME", nameW);
  const cpu = padStart(sortKey === "cpu" ? "CPU%▼" : "CPU%", CPU_W);
  const mem = padStart(sortKey === "mem" ? "MEM▼" : "MEM", MEM_W);
  return `${pid} ${name} ${cpu} ${mem}`;
}

const HINT = "↑↓ move · c/m sort · k kill · / filter";
const SELECTED_BG = "#44475A";
const SELECTED_FG = "#F8F8F2";
const ROW_FG = "#BFBFBF";
const FILTER_FG = "#F1FA8C";

const TOAST_MS = 4000;

const defaultKill: KillFn = (pid, signal) => {
  process.kill(pid, signal);
};

export function makeProcessTable(
  renderer: CliRenderer,
  options: ProcessTableOptions = {},
): ProcessTable {
  const kill = options.kill ?? defaultKill;

  // --- UI state -------------------------------------------------------------
  let cached: Option.Option<MetricState> = Option.none();
  let sortKey: SortKey = "cpu";
  let selectedPid: ProcessId | null = null;
  let fallbackIndex = 0;
  let scrollOffset = 0;
  let pendingKill: ProcessRecord | null = null;
  let toast: string | null = null;
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  // Filter mode is editing (cursor shown); the query itself persists once locked
  // (Enter → filterMode false, query retained) so the table stays filtered until
  // `/` re-enters edit or Escape clears it.
  let filterMode = false;
  let filterQuery = "";

  // --- Renderables ----------------------------------------------------------
  const filterBar = new TextRenderable(renderer, {
    id: "proc-filter",
    content: "",
    fg: FILTER_FG,
    visible: false,
  });
  const header = new TextRenderable(renderer, {
    id: "proc-header",
    content: "",
    fg: "#8BE9FD",
    attributes: TextAttributes.BOLD,
  });
  const body = new BoxRenderable(renderer, {
    id: "proc-body",
    flexGrow: 1,
    flexDirection: "column",
  });
  const footer = new TextRenderable(renderer, {
    id: "proc-footer",
    content: HINT,
    fg: "#6272A4",
  });
  const root = new BoxRenderable(renderer, {
    id: "proc-table",
    borderStyle: "rounded",
    padding: 1,
    flexDirection: "column",
    title: "Processes",
  });
  root.add(filterBar);
  root.add(header);
  root.add(body);
  root.add(footer);

  // A reusable pool of row renderables — windowing updates content/visibility
  // rather than churning the tree each frame.
  const rowPool: TextRenderable[] = [];
  const ensureRows = (n: number): void => {
    while (rowPool.length < n) {
      const row = new TextRenderable(renderer, {
        id: `proc-row-${rowPool.length}`,
        content: "",
        fg: ROW_FG,
      });
      body.add(row);
      rowPool.push(row);
    }
  };

  /** All processes in the cached snapshot, unfiltered (for the match-count denominator). */
  const totalProcessCount = (): number => {
    if (Option.isNone(cached)) return 0;
    const s = cached.value;
    if (s._tag !== "ok" || s.snapshot._tag !== "process") return 0;
    return s.snapshot.processes.length;
  };

  /** Current filtered + sorted process list from the cached snapshot (empty if unavailable). */
  const sorted = (): ProcessRecord[] => {
    if (Option.isNone(cached)) return [];
    const s = cached.value;
    if (s._tag !== "ok" || s.snapshot._tag !== "process") return [];
    return sortProcesses(filterProcesses(s.snapshot.processes, filterQuery), sortKey);
  };

  /** A short status line for the cached state when there are no rows to show. */
  const emptyMessage = (): { text: string; fg: string } | null => {
    if (Option.isNone(cached)) {
      return { text: "waiting for first reading…", fg: "#888888" };
    }
    const s = cached.value;
    if (s._tag === "unavailable") {
      return { text: `unavailable (${s.reason})`, fg: "#FF5555" };
    }
    return null;
  };

  const bodyWidth = (): number => {
    const w = body.width;
    return w > 0 ? w : Math.max(MIN_NAME_W + FIXED_W, Math.floor(renderer.width / 2) - 4);
  };
  const viewportRows = (): number => {
    const h = body.height;
    return h > 0 ? h : Math.max(1, Math.floor(renderer.height) - 7);
  };

  const setToast = (message: string): void => {
    toast = message;
    if (toastTimer !== null) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast = null;
      toastTimer = null;
      if (!renderer.isDestroyed) draw(true);
    }, TOAST_MS);
    // Don't let a pending toast keep the process alive past a clean quit.
    toastTimer.unref?.();
  };

  /** Rebuild all renderable content from current state. Repaints when `paint`. */
  const draw = (paint: boolean): void => {
    const width = bodyWidth();
    header.content = formatHeader(width, sortKey);

    const rows = sorted();

    // The bar stays visible while editing (cursor shown) or once a query is
    // locked in (query retained, table stays filtered until `/` or Escape).
    const showFilterBar = filterMode || filterQuery.length > 0;
    filterBar.visible = showFilterBar;
    filterBar.content = showFilterBar
      ? `Filter: ${filterQuery}${filterMode ? "█" : ""}   ${rows.length} / ${totalProcessCount()}`
      : "";

    footer.content =
      pendingKill !== null
        ? `Kill PID ${pendingKill.pid as number} ${displayName(pendingKill.name)}?  (y/n)`
        : (toast ?? `${HINT}   ${rows.length} shown`);
    footer.fg =
      pendingKill !== null ? "#FFB86C" : toast !== null ? "#FF5555" : "#6272A4";

    const empty = emptyMessage();
    if (empty !== null || rows.length === 0) {
      ensureRows(1);
      rowPool[0]!.content =
        empty?.text ??
        (filterQuery.length > 0 ? `no matches for "${filterQuery}"` : "no processes");
      rowPool[0]!.fg = empty?.fg ?? "#888888";
      rowPool[0]!.bg = undefined;
      rowPool[0]!.visible = true;
      for (let i = 1; i < rowPool.length; i++) rowPool[i]!.visible = false;
      selectedPid = null;
      if (paint && !renderer.isDestroyed) renderer.requestRender();
      return;
    }

    // Resolve PID-anchored selection, then the scroll window around it.
    const found = selectedPid === null ? -1 : rows.findIndex((p) => p.pid === selectedPid);
    const selIndex = resolveSelectedIndex(rows.length, found, fallbackIndex);
    selectedPid = rows[selIndex]!.pid;
    fallbackIndex = selIndex;

    const viewport = viewportRows();
    scrollOffset = clampScroll(selIndex, scrollOffset, viewport, rows.length);

    ensureRows(viewport);
    for (let i = 0; i < rowPool.length; i++) {
      const rowIndex = scrollOffset + i;
      const row = rowPool[i]!;
      if (i >= viewport || rowIndex >= rows.length) {
        row.visible = false;
        continue;
      }
      const p = rows[rowIndex]!;
      const isSelected = rowIndex === selIndex;
      row.visible = true;
      row.content = formatProcessRow(p, width);
      row.fg = isSelected ? SELECTED_FG : ROW_FG;
      row.bg = isSelected ? SELECTED_BG : undefined;
      row.attributes = isSelected ? TextAttributes.BOLD : 0;
    }

    if (paint && !renderer.isDestroyed) renderer.requestRender();
  };

  // --- Mutators (input path) ------------------------------------------------
  const moveSelection = (delta: number): void => {
    const rows = sorted();
    if (rows.length === 0) return;
    const found = selectedPid === null ? -1 : rows.findIndex((p) => p.pid === selectedPid);
    const selIndex = resolveSelectedIndex(rows.length, found, fallbackIndex);
    const next = clamp(selIndex + delta, 0, rows.length - 1);
    selectedPid = rows[next]!.pid;
    fallbackIndex = next;
    draw(true);
  };

  const setSort = (key: SortKey): void => {
    if (key === sortKey) return;
    sortKey = key; // selection is PID-anchored, so it follows across the re-sort
    draw(true);
  };

  const requestKill = (): void => {
    const sel = getSelection();
    if (sel === null) return;
    pendingKill = sel;
    draw(true);
  };

  const confirmKill = (): void => {
    if (pendingKill === null) return;
    const { pid, name } = pendingKill;
    pendingKill = null;
    try {
      kill(pid as number, "SIGTERM");
    } catch (cause) {
      const code = (cause as { code?: string } | null)?.code;
      setToast(
        code === "ESRCH"
          ? `PID ${pid as number} already gone`
          : `cannot kill ${displayName(name)} (PID ${pid as number}): ${code ?? "error"}`,
      );
    }
    draw(true);
  };

  const cancelKill = (): void => {
    if (pendingKill === null) return;
    pendingKill = null;
    draw(true);
  };

  // --- Filter mutators (Filter-mode input path) ------------------------------
  const startFilter = (): void => {
    filterMode = true;
    draw(true);
  };

  const onFilterKey = (key: InputKey): void => {
    if (key.name === "backspace") {
      if (filterQuery.length > 0) filterQuery = filterQuery.slice(0, -1);
      draw(true);
      return;
    }
    if (key.name === "space") {
      filterQuery += " ";
      draw(true);
      return;
    }
    // Printable single-char keys (letters/digits/symbols) have a one-character
    // `name` (see the OpenTUI key-parsing gotcha); named/control keys (arrows,
    // return, escape, function keys, ...) don't, so this excludes them without an
    // explicit denylist. `sequence` (not `name`) preserves the typed case.
    if (key.name.length === 1 && !key.ctrl && !key.meta) {
      filterQuery += key.sequence;
      draw(true);
    }
  };

  const lockFilter = (): void => {
    filterMode = false;
    draw(true);
  };

  const clearFilter = (): void => {
    filterMode = false;
    filterQuery = "";
    draw(true);
  };

  const getSelection = (): ProcessRecord | null => {
    const rows = sorted();
    if (rows.length === 0) return null;
    const found = selectedPid === null ? -1 : rows.findIndex((p) => p.pid === selectedPid);
    const selIndex = resolveSelectedIndex(rows.length, found, fallbackIndex);
    return rows[selIndex] ?? null;
  };

  const onKey = (key: InputKey): void => {
    // While a kill confirm is open, only y/n/escape are meaningful.
    if (pendingKill !== null) {
      if (key.name === "y") confirmKill();
      else if (key.name === "n" || key.name === "escape") cancelKill();
      return;
    }
    switch (key.name) {
      case "up":
        moveSelection(-1);
        break;
      case "down":
        moveSelection(1);
        break;
      case "pageup":
        moveSelection(-Math.max(1, viewportRows() - 1));
        break;
      case "pagedown":
        moveSelection(Math.max(1, viewportRows() - 1));
        break;
      case "c":
        setSort("cpu");
        break;
      case "m":
        setSort("mem");
        break;
      case "k":
        requestKill();
        break;
    }
  };

  const update = (state: Option.Option<MetricState>): void => {
    cached = state;
    draw(false); // the render tick requests the paint
  };

  // Re-window on terminal resize (viewport/name width depend on body size).
  renderer.on("resize", () => {
    if (!renderer.isDestroyed) draw(true);
  });

  const notify = (message: string): void => {
    setToast(message);
    draw(true);
  };

  draw(false);

  return {
    root,
    update,
    onKey,
    getSelection,
    getSortKey: () => sortKey,
    isAwaitingConfirm: () => pendingKill !== null,
    notify,
    startFilter,
    onFilterKey,
    lockFilter,
    clearFilter,
  };
}

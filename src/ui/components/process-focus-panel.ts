import {
  BoxRenderable,
  type CliRenderer,
  type Renderable,
  TextAttributes,
  TextRenderable,
} from "@opentui/core";
import { Option } from "effect";
import type {
  MetricState,
  ProcessFocusSnapshot,
  ProcessId,
} from "../../types/metrics.ts";
import { formatBytes } from "../format.ts";
import { appendCapped, renderSparkline } from "./cpu-sparkline.ts";

/**
 * The right-pane focus view for a single pinned process (Feature 2). Mounted in
 * place of the widget grid while a PID is pinned, driven by the PID-scoped
 * `process-focus` stream. It follows the interactive-redraw contract: `update`
 * caches the latest sample and repaints without requesting a paint (the caller
 * does), and {@link ProcessFocusPanel.prime} resets the rolling history for a
 * freshly pinned process so the sparklines don't carry the previous PID's tail.
 *
 * Two rolling sparklines — CPU% (share of machine) and memory as a % of system
 * memory, comparable with the MEM gauge — plus a stats row (threads, open FDs,
 * status). Reuses the `cpu-sparkline` history helpers so the rendering stays
 * consistent with the CPU history widget.
 */

export interface ProcessFocusPanel {
  readonly root: Renderable;
  /**
   * Reset the rolling history and show the header for a newly pinned process,
   * before the first sample arrives. Called on pin.
   */
  readonly prime: (pid: ProcessId, name: string) => void;
  /** Data tick: cache the latest focus state and repaint (no immediate paint request). */
  readonly update: (state: Option.Option<MetricState>) => void;
}

const TITLE_FG = "#8BE9FD";
const SPARK_FG = "#50FA7B";
const VALUE_FG = "#F8F8F2";
const DIM_FG = "#6272A4";
const ERROR_FG = "#FF5555";

const DEFAULT_CAPACITY = 40;

/** Fit a string into `width`, truncating with an ellipsis when it overflows. */
const fit = (s: string, width: number): string => {
  if (width <= 0) return s;
  if (s.length <= width) return s;
  if (width <= 1) return s.slice(0, width);
  return `${s.slice(0, width - 1)}…`;
};

export function makeProcessFocusPanel(
  renderer: CliRenderer,
  capacity: number = DEFAULT_CAPACITY,
): ProcessFocusPanel {
  // --- UI state -------------------------------------------------------------
  let pinnedPid: ProcessId | null = null;
  let pinnedName = "";
  // null = single attached PID; a number = launched-command subtree (Feature 4),
  // shown as `(+N descendants)` in the header.
  let descendantCount: number | null = null;
  let cpuHistory: Array<number | null> = [];
  let memHistory: Array<number | null> = [];
  let cached: Option.Option<MetricState> = Option.none();

  // --- Renderables ----------------------------------------------------------
  const header = new TextRenderable(renderer, {
    id: "focus-header",
    content: "",
    fg: VALUE_FG,
    attributes: TextAttributes.BOLD,
  });
  const cpuTitle = new TextRenderable(renderer, {
    id: "focus-cpu-title",
    content: "CPU",
    fg: TITLE_FG,
    attributes: TextAttributes.BOLD,
  });
  const cpuLine = new TextRenderable(renderer, {
    id: "focus-cpu-line",
    content: "",
    fg: SPARK_FG,
  });
  const memTitle = new TextRenderable(renderer, {
    id: "focus-mem-title",
    content: "MEM",
    fg: TITLE_FG,
    attributes: TextAttributes.BOLD,
  });
  const memLine = new TextRenderable(renderer, {
    id: "focus-mem-line",
    content: "",
    fg: SPARK_FG,
  });
  const stats = new TextRenderable(renderer, {
    id: "focus-stats",
    content: "",
    fg: DIM_FG,
  });

  const root = new BoxRenderable(renderer, {
    id: "process-focus-panel",
    borderStyle: "rounded",
    padding: 1,
    flexDirection: "column",
    title: "Focus",
  });
  root.add(header);
  root.add(cpuTitle);
  root.add(cpuLine);
  root.add(memTitle);
  root.add(memLine);
  root.add(stats);

  const innerWidth = (): number => {
    const w = root.width;
    const base = w > 0 ? w : Math.floor(renderer.width / 2);
    return Math.max(8, base - 4); // padding (1) + border (1) on each side
  };

  /** The current `process-focus` snapshot from the cached state, if any. */
  const focusOf = (): ProcessFocusSnapshot | null => {
    if (Option.isNone(cached)) return null;
    const s = cached.value;
    if (s._tag !== "ok" || s.snapshot._tag !== "process-focus") return null;
    return s.snapshot;
  };

  const drawHeader = (): void => {
    const pid = pinnedPid === null ? "—" : String(pinnedPid as number);
    // A launched command aggregates its subtree — note the descendant count.
    const suffix =
      descendantCount !== null && descendantCount > 0
        ? ` (+${descendantCount} descendant${descendantCount === 1 ? "" : "s"})`
        : "";
    header.content = fit(`PID ${pid} — ${pinnedName}${suffix}`, innerWidth());
  };

  /** Rebuild all renderable content from current state. */
  const draw = (): void => {
    drawHeader();
    cpuLine.content = renderSparkline(cpuHistory);
    memLine.content = renderSparkline(memHistory);

    const focus = focusOf();
    if (focus === null) {
      // No sample yet, or an unavailable reading (process exiting).
      const reason =
        Option.isSome(cached) && cached.value._tag === "unavailable"
          ? cached.value.reason
          : null;
      cpuTitle.content = "CPU";
      memTitle.content = "MEM · % of system";
      stats.content =
        reason === null
          ? "waiting for first reading…"
          : `unavailable (${reason})`;
      stats.fg = reason === null ? DIM_FG : ERROR_FG;
      return;
    }

    // For a single attached PID, refresh the header name from the authoritative
    // snapshot (the resolved exe path). For a launched-command subtree we keep the
    // primed command string (e.g. `bun run build`, not the resolved `bun` path).
    if (focus.descendantCount === null && focus.name.length > 0) {
      pinnedName = focus.name;
    }
    drawHeader();

    cpuTitle.content = `CPU  ${(focus.cpuPercent as number).toFixed(1)}%`;
    memTitle.content = `MEM  ${(focus.memPercent as number).toFixed(1)}% · ${formatBytes(focus.memBytes as number)} (of system)`;
    const fds = focus.openFds === null ? "n/a" : String(focus.openFds);
    stats.content = `Threads: ${focus.threadCount}   Open FDs: ${fds}   Status: ${focus.status}`;
    stats.fg = DIM_FG;
  };

  const prime = (pid: ProcessId, name: string): void => {
    pinnedPid = pid;
    pinnedName = name;
    descendantCount = null;
    cpuHistory = [];
    memHistory = [];
    cached = Option.none();
    draw();
  };

  const update = (state: Option.Option<MetricState>): void => {
    cached = state;
    const focus = focusOf();
    if (focus !== null) descendantCount = focus.descendantCount;
    // A gap (null) for a missing/unavailable sample, mirroring the CPU sparkline.
    cpuHistory = appendCapped(
      cpuHistory,
      focus === null ? null : (focus.cpuPercent as number),
      capacity,
    );
    memHistory = appendCapped(
      memHistory,
      focus === null ? null : (focus.memPercent as number),
      capacity,
    );
    draw();
  };

  // Re-fit the header on resize (inner width depends on the pane size).
  renderer.on("resize", () => {
    if (!renderer.isDestroyed) draw();
  });

  draw();

  return { root, prime, update };
}

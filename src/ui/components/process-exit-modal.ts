import {
  BoxRenderable,
  type CliRenderer,
  type Renderable,
  TextAttributes,
  TextRenderable,
} from "@opentui/core";
import type { InputKey } from "../../services/input-router.ts";
import type { ProcessExitRecord } from "../../types/process-exit.ts";
import { formatBytes } from "../format.ts";
import { clampScroll } from "./process-table.ts";

/**
 * The exit report — a **full-pane visible-toggle overlay**, mirroring the
 * grid↔focus swap rather than a true z-index overlay (OpenTUI has no
 * overlay/z-index primitive). `main.ts` toggles this root's visibility against
 * the process split when the `InputRouter`'s `Modal` mode opens/closes; this
 * component only owns its own content and the stderr scroll state.
 *
 * Write-once + scroll, not the data-tick contract the other panels follow:
 * {@link ProcessExitModal.show} primes a captured `ProcessExitRecord` (there is
 * no live re-sampling — the data is captured once at exit) and
 * {@link ProcessExitModal.onKey} only moves the stderr scroll cursor. Both repaint
 * immediately via `renderer.requestRender()`, matching the interactive-redraw
 * contract's input-driven path.
 */

export interface ProcessExitModal {
  readonly root: Renderable;
  /** Prime the modal with a captured exit record and reset scroll to the top. */
  readonly show: (record: ProcessExitRecord) => void;
  /** Feed a parsed key from the InputRouter's `Modal`-mode handler (arrow-scroll only — Escape/`d` dismiss is handled by the caller). */
  readonly onKey: (key: InputKey) => void;
}

const TITLE_FG = "#8BE9FD";
const VALUE_FG = "#F8F8F2";
const DIM_FG = "#6272A4";
const WARN_FG = "#FFB86C";
const ROW_FG = "#BFBFBF";

const HINT = "↑↓/PgUp/PgDn scroll · Esc/d dismiss";

const clamp = (n: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, n));

/** Pure: the exit-detail line for a launched process. Exported for unit testing. */
export function exitDetailLine(record: ProcessExitRecord): string {
  if (record.origin === "attached") {
    return "attached process — exit code and output unavailable";
  }
  if (record.exitCode !== null) return `exit code ${record.exitCode}`;
  if (record.exitSignal !== null) return `signal ${record.exitSignal}`;
  return "exit outcome unknown";
}

/** Pure: the final-resources line, `n/a` when the process exited before a sample. Exported for unit testing. */
export function finalResourcesLine(record: ProcessExitRecord): string {
  const cpu =
    record.finalCpuPercent === null
      ? "n/a"
      : `${(record.finalCpuPercent as number).toFixed(1)}%`;
  const mem =
    record.finalMemBytes === null
      ? "n/a"
      : formatBytes(record.finalMemBytes as number);
  return `Final CPU: ${cpu}   Final MEM: ${mem}`;
}

export function makeProcessExitModal(renderer: CliRenderer): ProcessExitModal {
  // --- UI state -------------------------------------------------------------
  let current: ProcessExitRecord | null = null;
  let cursor = 0;
  let offset = 0;

  // --- Renderables ------------------------------------------------------------
  const header = new TextRenderable(renderer, {
    id: "exit-header",
    content: "",
    fg: VALUE_FG,
    attributes: TextAttributes.BOLD,
  });
  const detailLine = new TextRenderable(renderer, {
    id: "exit-detail",
    content: "",
    fg: WARN_FG,
  });
  const statsLine = new TextRenderable(renderer, {
    id: "exit-stats",
    content: "",
    fg: DIM_FG,
  });
  const stderrTitle = new TextRenderable(renderer, {
    id: "exit-stderr-title",
    content: "",
    fg: TITLE_FG,
    attributes: TextAttributes.BOLD,
  });
  const body = new BoxRenderable(renderer, {
    id: "exit-body",
    flexGrow: 1,
    flexDirection: "column",
  });
  const footer = new TextRenderable(renderer, {
    id: "exit-footer",
    content: HINT,
    fg: DIM_FG,
  });

  const root = new BoxRenderable(renderer, {
    id: "process-exit-modal",
    borderStyle: "rounded",
    padding: 1,
    flexDirection: "column",
    width: "100%",
    flexGrow: 1,
    title: "Process Exit Report",
  });
  root.add(header);
  root.add(detailLine);
  root.add(statsLine);
  root.add(stderrTitle);
  root.add(body);
  root.add(footer);

  // A reusable pool of row renderables for the stderr tail, windowed exactly like
  // `ProcessTable`'s row pool.
  const rowPool: TextRenderable[] = [];
  const ensureRows = (n: number): void => {
    while (rowPool.length < n) {
      const row = new TextRenderable(renderer, {
        id: `exit-row-${rowPool.length}`,
        content: "",
        fg: ROW_FG,
      });
      body.add(row);
      rowPool.push(row);
    }
  };

  const viewportRows = (): number => {
    const h = body.height;
    return h > 0 ? h : Math.max(1, Math.floor(renderer.height) - 12);
  };

  /** The lines to scroll through: a launched record's stderr tail, or none for an attached one. */
  const currentLines = (): ReadonlyArray<string> =>
    current !== null && current.origin === "launched" ? current.stderrTail : [];

  const drawBody = (): void => {
    const lines = currentLines();
    if (lines.length === 0) {
      ensureRows(1);
      rowPool[0]!.content =
        current === null
          ? ""
          : current.origin === "attached"
            ? "no output captured — attached process"
            : "no stderr output";
      rowPool[0]!.fg = DIM_FG;
      rowPool[0]!.visible = true;
      for (let i = 1; i < rowPool.length; i++) rowPool[i]!.visible = false;
      return;
    }

    const viewport = viewportRows();
    offset = clampScroll(cursor, offset, viewport, lines.length);
    ensureRows(viewport);
    for (let i = 0; i < rowPool.length; i++) {
      const lineIndex = offset + i;
      const row = rowPool[i]!;
      if (i >= viewport || lineIndex >= lines.length) {
        row.visible = false;
        continue;
      }
      row.visible = true;
      row.content = lines[lineIndex]!;
    }
  };

  /** Rebuild all renderable content from current state and request a repaint. */
  const draw = (): void => {
    if (current === null) {
      header.content = "";
      detailLine.content = "";
      statsLine.content = "";
      stderrTitle.content = "";
      drawBody();
      if (!renderer.isDestroyed) renderer.requestRender();
      return;
    }

    header.content = `PID ${current.pid as number} — ${current.name}`;
    detailLine.content = exitDetailLine(current);
    statsLine.content = finalResourcesLine(current);
    stderrTitle.content =
      current.origin === "launched"
        ? `stderr (last ${current.stderrTail.length} line${current.stderrTail.length === 1 ? "" : "s"})`
        : "";
    drawBody();

    if (!renderer.isDestroyed) renderer.requestRender();
  };

  const show = (record: ProcessExitRecord): void => {
    current = record;
    cursor = 0;
    offset = 0;
    draw();
  };

  const onKey = (key: InputKey): void => {
    const total = currentLines().length;
    if (total === 0) return;
    switch (key.name) {
      case "up":
        cursor = clamp(cursor - 1, 0, total - 1);
        draw();
        break;
      case "down":
        cursor = clamp(cursor + 1, 0, total - 1);
        draw();
        break;
      case "pageup":
        cursor = clamp(cursor - Math.max(1, viewportRows() - 1), 0, total - 1);
        draw();
        break;
      case "pagedown":
        cursor = clamp(cursor + Math.max(1, viewportRows() - 1), 0, total - 1);
        draw();
        break;
    }
  };

  // Re-window on terminal resize (viewport depends on body size).
  renderer.on("resize", () => {
    if (!renderer.isDestroyed) draw();
  });

  draw();

  return { root, show, onKey };
}

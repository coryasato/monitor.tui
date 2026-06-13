import {
  BoxRenderable,
  type CliRenderer,
  type Renderable,
  TextAttributes,
  TextRenderable,
} from "@opentui/core";
import { Option } from "effect";
import type { MetricState } from "../../types/metrics.ts";
import { loadColor, renderBar } from "./cpu-gauge.ts";

/**
 * Per-core CPU panel: one labeled, colored bar per logical core. Like the other
 * components it is a passive view — `update` is called from the app's render-tick
 * loop with the latest store state; it never reads the store or owns a fiber.
 *
 * The core count isn't known until the first reading, so the bar rows are created
 * lazily on first `update` and reused thereafter.
 */

const fmt = (n: number): string => n.toFixed(1);

/** `c0 ████░░ 32.0%` — index is right-padded so bars line up past 9 cores. */
const coreLabel = (index: number): string => `c${String(index).padEnd(2)}`;

export interface CpuCores {
  /** Root renderable to mount under `renderer.root`. */
  readonly root: Renderable;
  /** Apply the latest store state to the view (called each render tick). */
  readonly update: (state: Option.Option<MetricState>) => void;
  /** Show a non-fatal render error without disturbing the bars. */
  readonly showDebug: (message: string) => void;
}

export function makeCpuCores(renderer: CliRenderer): CpuCores {
  const title = new TextRenderable(renderer, {
    id: "cpu-cores-title",
    content: "CPU CORES",
    fg: "#8BE9FD",
    attributes: TextAttributes.BOLD,
  });
  const status = new TextRenderable(renderer, {
    id: "cpu-cores-status",
    content: "waiting for first reading…",
    fg: "#888888",
  });
  // Holds one row per core; grows as the first reading reveals the core count.
  const bars = new BoxRenderable(renderer, {
    id: "cpu-cores-bars",
    flexDirection: "column",
  });
  const debug = new TextRenderable(renderer, {
    id: "cpu-cores-debug",
    content: "",
    fg: "#FF5555",
  });

  const root = new BoxRenderable(renderer, {
    id: "cpu-cores",
    borderStyle: "rounded",
    padding: 1,
    flexDirection: "column",
  });
  root.add(title);
  root.add(status);
  root.add(bars);
  root.add(debug);

  // Lazily-created per-core bar rows, indexed by core number.
  const rows: TextRenderable[] = [];

  /** Ensure `rows` has at least `count` renderables, mounting any new ones. */
  const ensureRows = (count: number): void => {
    for (let i = rows.length; i < count; i++) {
      const row = new TextRenderable(renderer, {
        id: `cpu-core-${i}`,
        content: "",
        fg: "#50FA7B",
      });
      rows.push(row);
      bars.add(row);
    }
  };

  /** Clear the status line once real bars are showing. */
  const hideStatus = (): void => {
    status.content = "";
  };

  const update = (state: Option.Option<MetricState>): void =>
    Option.match(state, {
      onNone: () => {
        status.content = "waiting for first reading…";
        status.fg = "#888888";
      },
      onSome: (s) => {
        if (s._tag === "unavailable" || s.snapshot._tag !== "cpu-cores") {
          status.content =
            s._tag === "unavailable" ? `unavailable (${s.reason})` : "unavailable";
          status.fg = "#FF5555";
          // Grey out any existing bars so a transient failure reads as stale.
          for (const row of rows) row.fg = "#6272A4";
          return;
        }
        hideStatus();
        const { cores } = s.snapshot;
        ensureRows(cores.length);
        cores.forEach((pct, i) => {
          const row = rows[i]!;
          row.content = `${coreLabel(i)} ${renderBar(pct)} ${fmt(pct)}%`;
          row.fg = loadColor(pct);
        });
      },
    });

  const showDebug = (message: string): void => {
    debug.content = message;
  };

  return { root, update, showDebug };
}

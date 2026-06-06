import {
  BoxRenderable,
  type CliRenderer,
  type Renderable,
  TextAttributes,
  TextRenderable,
} from "@opentui/core";
import { Option } from "effect";
import type { MetricState } from "../../types/metrics.ts";

/**
 * Network readout: rx/tx throughput as text. Unlike the gauges there is no bar —
 * throughput has no natural 0–100 ceiling, so we just render a scaled rate. A
 * passive view; `update` is pushed the latest store state from the render tick.
 */

const KIB = 1024;
const MIB = 1024 * 1024;

/** Human-readable byte rate: B/s → KB/s → MB/s. Exported for tests. */
export function formatRate(bytesPerSec: number): string {
  if (bytesPerSec >= MIB) return `${(bytesPerSec / MIB).toFixed(1)} MB/s`;
  if (bytesPerSec >= KIB) return `${(bytesPerSec / KIB).toFixed(1)} KB/s`;
  return `${Math.round(bytesPerSec)} B/s`;
}

export interface NetworkReadout {
  readonly root: Renderable;
  readonly update: (state: Option.Option<MetricState>) => void;
}

export function makeNetworkReadout(renderer: CliRenderer): NetworkReadout {
  const title = new TextRenderable(renderer, {
    id: "net-title",
    content: "NET",
    fg: "#8BE9FD",
    attributes: TextAttributes.BOLD,
  });
  const value = new TextRenderable(renderer, {
    id: "net-value",
    content: "waiting for first reading…",
    fg: "#888888",
  });

  const root = new BoxRenderable(renderer, {
    id: "net-readout",
    borderStyle: "rounded",
    padding: 1,
    flexDirection: "column",
  });
  root.add(title);
  root.add(value);

  const update = (state: Option.Option<MetricState>): void =>
    Option.match(state, {
      onNone: () => {
        value.content = "waiting for first reading…";
        value.fg = "#888888";
      },
      onSome: (s) => {
        if (s._tag === "unavailable" || s.snapshot._tag !== "network") {
          value.content =
            s._tag === "unavailable"
              ? `unavailable (${s.reason})`
              : "unavailable";
          value.fg = "#FF5555";
          return;
        }
        const { rxBytesPerSec, txBytesPerSec } = s.snapshot;
        value.content = `↓ ${formatRate(rxBytesPerSec)}   ↑ ${formatRate(txBytesPerSec)}`;
        value.fg = "#F8F8F2";
      },
    });

  return { root, update };
}

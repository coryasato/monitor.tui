/**
 * Shared alert-state resolution for config-driven thresholds. CPU, memory, and
 * disk panels resolve their current value through {@link resolveAlert}
 * and color their gauge/bar via {@link alertColor} — one place instead of
 * per-panel duplication. Network is excluded: throughput rates have no natural
 * 0–100 ceiling to threshold against.
 */

export type AlertState = "ok" | "warn" | "critical";

export interface AlertThresholds {
  readonly warn: number;
  readonly critical: number;
}

/** Resolve `value` against `thresholds` — critical takes priority at the boundary. */
export function resolveAlert(value: number, thresholds: AlertThresholds): AlertState {
  if (value >= thresholds.critical) return "critical";
  if (value >= thresholds.warn) return "warn";
  return "ok";
}

/** Green → amber → red, shared by every alert-aware panel. */
export function alertColor(state: AlertState): string {
  switch (state) {
    case "critical":
      return "#FF5555";
    case "warn":
      return "#FFB86C";
    case "ok":
      return "#50FA7B";
  }
}

/**
 * True only on the tick a metric first enters `"critical"` from a lower state —
 * the debounce for the optional system notification (one per crossing, not one
 * per sample while it stays critical).
 */
export function crossedIntoCritical(previous: AlertState, next: AlertState): boolean {
  return next === "critical" && previous !== "critical";
}

import { describe, expect, test } from "bun:test";
import {
  alertColor,
  crossedIntoCritical,
  resolveAlert,
} from "../src/ui/alerts.ts";

describe("resolveAlert", () => {
  const thresholds = { warn: 75, critical: 90 };

  test("below warn is ok", () => {
    expect(resolveAlert(0, thresholds)).toBe("ok");
    expect(resolveAlert(74.9, thresholds)).toBe("ok");
  });

  test("at/above warn but below critical is warn", () => {
    expect(resolveAlert(75, thresholds)).toBe("warn");
    expect(resolveAlert(89.9, thresholds)).toBe("warn");
  });

  test("at/above critical is critical", () => {
    expect(resolveAlert(90, thresholds)).toBe("critical");
    expect(resolveAlert(150, thresholds)).toBe("critical");
  });
});

describe("alertColor", () => {
  test("maps each state to its color", () => {
    expect(alertColor("ok")).toBe("#50FA7B");
    expect(alertColor("warn")).toBe("#FFB86C");
    expect(alertColor("critical")).toBe("#FF5555");
  });
});

describe("crossedIntoCritical", () => {
  test("true only when transitioning into critical", () => {
    expect(crossedIntoCritical("ok", "critical")).toBe(true);
    expect(crossedIntoCritical("warn", "critical")).toBe(true);
  });

  test("false while already critical (debounced — no renotify per sample)", () => {
    expect(crossedIntoCritical("critical", "critical")).toBe(false);
  });

  test("false for any transition not landing on critical", () => {
    expect(crossedIntoCritical("ok", "warn")).toBe(false);
    expect(crossedIntoCritical("critical", "warn")).toBe(false);
    expect(crossedIntoCritical("critical", "ok")).toBe(false);
  });
});

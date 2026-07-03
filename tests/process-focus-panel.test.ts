import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { Option } from "effect";
import {
  Bytes,
  type MetricState,
  Percent,
  ProcessId,
  type ProcessFocusSnapshot,
  type ProcessStatus,
  Timestamp,
} from "../src/types/metrics.ts";
import { makeProcessFocusPanel } from "../src/ui/components/process-focus-panel.ts";

const focusState = (
  overrides: Partial<ProcessFocusSnapshot> = {},
): MetricState => {
  const snapshot: ProcessFocusSnapshot = {
    _tag: "process-focus",
    at: Timestamp(Date.now()),
    pid: ProcessId(1234),
    name: "/usr/local/bin/bun",
    cpuPercent: Percent(12.5),
    memBytes: Bytes(50 * 1024 * 1024),
    memPercent: Percent(1.5),
    threadCount: 8,
    openFds: 42,
    status: "running" as ProcessStatus,
    descendantCount: null,
    ...overrides,
  };
  return { _tag: "ok", tag: "process-focus", at: snapshot.at, snapshot };
};

const unavailableState = (reason: string): MetricState => ({
  _tag: "unavailable",
  tag: "process-focus",
  at: Timestamp(Date.now()),
  reason,
});

const setup = async () => {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
    width: 60,
    height: 16,
  });
  const panel = makeProcessFocusPanel(renderer, 20);
  panel.root.height = "100%";
  renderer.root.add(panel.root);
  await renderOnce();
  return { renderer, renderOnce, captureCharFrame, panel };
};

describe("ProcessFocusPanel", () => {
  test("prime shows the PID + name header before the first sample", async () => {
    const { renderer, renderOnce, captureCharFrame, panel } = await setup();
    try {
      panel.prime(ProcessId(4321), "/bin/sleep");
      await renderOnce();
      const frame = captureCharFrame();
      expect(frame).toContain("PID 4321");
      expect(frame).toContain("sleep");
      expect(frame).toContain("waiting for first reading");
    } finally {
      renderer.destroy();
    }
  });

  test("renders CPU%, memory %, threads, FDs and status from a sample", async () => {
    const { renderer, renderOnce, captureCharFrame, panel } = await setup();
    try {
      panel.prime(ProcessId(1234), "/usr/local/bin/bun");
      panel.update(Option.some(focusState()));
      await renderOnce();
      const frame = captureCharFrame();
      expect(frame).toContain("PID 1234");
      expect(frame).toContain("12.5%"); // cpu
      expect(frame).toContain("1.5%"); // mem % of system
      expect(frame).toContain("Threads: 8");
      expect(frame).toContain("Open FDs: 42");
      expect(frame).toContain("Status: running");
    } finally {
      renderer.destroy();
    }
  });

  test("shows n/a when the FD count is unavailable", async () => {
    const { renderer, renderOnce, captureCharFrame, panel } = await setup();
    try {
      panel.prime(ProcessId(1234), "/bin/x");
      panel.update(Option.some(focusState({ openFds: null })));
      await renderOnce();
      expect(captureCharFrame()).toContain("Open FDs: n/a");
    } finally {
      renderer.destroy();
    }
  });

  test("builds a CPU sparkline glyph row from successive samples", async () => {
    const { renderer, renderOnce, captureCharFrame, panel } = await setup();
    try {
      panel.prime(ProcessId(1234), "/bin/x");
      for (const cpu of [10, 40, 90]) {
        panel.update(Option.some(focusState({ cpuPercent: Percent(cpu) })));
      }
      await renderOnce();
      const frame = captureCharFrame();
      // Sparkline glyphs from the cpu-sparkline ramp.
      expect(/[▁▂▃▄▅▆▇█]/u.test(frame)).toBe(true);
    } finally {
      renderer.destroy();
    }
  });

  test("prime resets the rolling history for a newly pinned process", async () => {
    const { renderer, renderOnce, captureCharFrame, panel } = await setup();
    try {
      panel.prime(ProcessId(1), "/bin/a");
      panel.update(Option.some(focusState({ pid: ProcessId(1), cpuPercent: Percent(90) })));
      await renderOnce();
      // Re-pin a different PID: header swaps and the waiting state returns.
      panel.prime(ProcessId(2), "/bin/b");
      await renderOnce();
      const frame = captureCharFrame();
      expect(frame).toContain("PID 2");
      expect(frame).toContain("waiting for first reading");
    } finally {
      renderer.destroy();
    }
  });

  test("notes the descendant count for a launched-command subtree", async () => {
    const { renderer, renderOnce, captureCharFrame, panel } = await setup();
    try {
      panel.prime(ProcessId(1234), "bun run build");
      panel.update(
        Option.some(
          focusState({ name: "/path/to/bun", descendantCount: 3 }),
        ),
      );
      await renderOnce();
      const frame = captureCharFrame();
      // Keeps the primed command string (not the resolved exe path) and appends
      // the descendant note.
      expect(frame).toContain("bun run build");
      expect(frame).not.toContain("/path/to/bun");
      expect(frame).toContain("+3 descendants");
    } finally {
      renderer.destroy();
    }
  });

  test("a single-descendant subtree reads '+1 descendant' (singular)", async () => {
    const { renderer, renderOnce, captureCharFrame, panel } = await setup();
    try {
      panel.prime(ProcessId(10), "sh -c work");
      panel.update(Option.some(focusState({ descendantCount: 1 })));
      await renderOnce();
      expect(captureCharFrame()).toContain("+1 descendant");
    } finally {
      renderer.destroy();
    }
  });

  test("renders an unavailable sample as an error note", async () => {
    const { renderer, renderOnce, captureCharFrame, panel } = await setup();
    try {
      panel.prime(ProcessId(1234), "/bin/x");
      panel.update(Option.some(unavailableState("process 1234 unavailable")));
      await renderOnce();
      expect(captureCharFrame()).toContain("unavailable");
    } finally {
      renderer.destroy();
    }
  });
});

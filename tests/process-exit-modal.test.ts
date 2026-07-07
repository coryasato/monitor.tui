import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import type { InputKey } from "../src/services/input-router.ts";
import { Bytes, Percent, ProcessId } from "../src/types/metrics.ts";
import type {
  AttachedExitRecord,
  LaunchedExitRecord,
  ProcessExitRecord,
} from "../src/types/process-exit.ts";
import {
  exitDetailLine,
  finalResourcesLine,
  makeProcessExitModal,
} from "../src/ui/components/process-exit-modal.ts";

const key = (name: string): InputKey => ({
  name,
  ctrl: false,
  shift: false,
  meta: false,
  option: false,
  sequence: name,
});

const launched = (
  overrides: Partial<LaunchedExitRecord> = {},
): LaunchedExitRecord => ({
  origin: "launched",
  pid: ProcessId(4321),
  name: "sh -c 'echo boom >&2; exit 3'",
  exitCode: 3,
  exitSignal: null,
  stderrTail: ["boom"],
  finalCpuPercent: Percent(1.2),
  finalMemBytes: Bytes(2 * 1024 * 1024),
  ...overrides,
});

const attached = (
  overrides: Partial<AttachedExitRecord> = {},
): AttachedExitRecord => ({
  origin: "attached",
  pid: ProcessId(1234),
  name: "/usr/local/bin/bun",
  exitCode: null,
  exitSignal: null,
  stderrTail: null,
  finalCpuPercent: Percent(5.5),
  finalMemBytes: Bytes(50 * 1024 * 1024),
  ...overrides,
});

const setup = async () => {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
    width: 60,
    height: 20,
  });
  const modal = makeProcessExitModal(renderer);
  modal.root.height = "100%";
  renderer.root.add(modal.root);
  await renderOnce();
  return { renderer, renderOnce, captureCharFrame, modal };
};

describe("exitDetailLine / finalResourcesLine (pure)", () => {
  test("launched: exit code wins when present", () => {
    expect(exitDetailLine(launched({ exitCode: 3 }))).toBe("exit code 3");
  });

  test("launched: falls back to signal when there's no exit code", () => {
    expect(
      exitDetailLine(launched({ exitCode: null, exitSignal: "SIGKILL" })),
    ).toBe("signal SIGKILL");
  });

  test("launched: unknown outcome when neither is set", () => {
    expect(
      exitDetailLine(launched({ exitCode: null, exitSignal: null })),
    ).toBe("exit outcome unknown");
  });

  test("attached: states the limitation, not an exit code", () => {
    expect(exitDetailLine(attached())).toBe(
      "attached process — exit code and output unavailable",
    );
  });

  test("finalResourcesLine formats n/a for a fast-exiting process with no sample", () => {
    expect(
      finalResourcesLine(launched({ finalCpuPercent: null, finalMemBytes: null })),
    ).toBe("Final CPU: n/a   Final MEM: n/a");
  });

  test("finalResourcesLine formats real values", () => {
    const line = finalResourcesLine(
      launched({ finalCpuPercent: Percent(12.3), finalMemBytes: Bytes(1024) }),
    );
    expect(line).toContain("12.3%");
    expect(line).toContain("1.0 KiB");
  });
});

describe("ProcessExitModal", () => {
  test("launched: shows PID, exit code, and stderr tail", async () => {
    const { renderer, renderOnce, captureCharFrame, modal } = await setup();
    try {
      modal.show(launched());
      await renderOnce();
      const frame = captureCharFrame();
      expect(frame).toContain("PID 4321");
      expect(frame).toContain("exit code 3");
      expect(frame).toContain("boom");
    } finally {
      renderer.destroy();
    }
  });

  test("launched with no stderr output shows a placeholder, not a blank pane", async () => {
    const { renderer, renderOnce, captureCharFrame, modal } = await setup();
    try {
      modal.show(launched({ stderrTail: [] }));
      await renderOnce();
      expect(captureCharFrame()).toContain("no stderr output");
    } finally {
      renderer.destroy();
    }
  });

  test("attached: shows the degraded-notice limitation and no stderr section", async () => {
    const { renderer, renderOnce, captureCharFrame, modal } = await setup();
    try {
      modal.show(attached());
      await renderOnce();
      const frame = captureCharFrame();
      expect(frame).toContain("PID 1234");
      expect(frame).toContain("exit code and output unavailable");
      expect(frame).not.toContain("stderr (last");
    } finally {
      renderer.destroy();
    }
  });

  test("a record with no final sample shows n/a resources", async () => {
    const { renderer, renderOnce, captureCharFrame, modal } = await setup();
    try {
      modal.show(
        attached({ finalCpuPercent: null, finalMemBytes: null }),
      );
      await renderOnce();
      expect(captureCharFrame()).toContain("Final CPU: n/a");
    } finally {
      renderer.destroy();
    }
  });

  test("arrow keys scroll a long stderr tail into view", async () => {
    const { renderer, renderOnce, captureCharFrame, modal } = await setup();
    try {
      const lines = Array.from({ length: 100 }, (_, i) => `line-${i}`);
      modal.show(launched({ stderrTail: lines }));
      await renderOnce();
      expect(captureCharFrame()).toContain("line-0");
      expect(captureCharFrame()).not.toContain("line-99");

      for (let i = 0; i < 100; i++) modal.onKey(key("down"));
      await renderOnce();
      expect(captureCharFrame()).toContain("line-99");
    } finally {
      renderer.destroy();
    }
  });

  test("pageup/pagedown jump by a viewport", async () => {
    const { renderer, renderOnce, captureCharFrame, modal } = await setup();
    try {
      const lines = Array.from({ length: 100 }, (_, i) => `line-${i}`);
      modal.show(launched({ stderrTail: lines }));
      await renderOnce();
      // One page-down lands the cursor at the bottom of the still-visible first
      // window (clampScroll only scrolls once the cursor leaves view — the same
      // minimal-adjustment semantics as `ProcessTable`'s paging); a second
      // page-down pushes it out and the window scrolls.
      modal.onKey(key("pagedown"));
      modal.onKey(key("pagedown"));
      await renderOnce();
      expect(captureCharFrame()).not.toContain("line-0");
    } finally {
      renderer.destroy();
    }
  });

  test("scrolling is a no-op for an attached record (no stderr lines)", async () => {
    const { renderer, renderOnce, captureCharFrame, modal } = await setup();
    try {
      modal.show(attached());
      await renderOnce();
      const before = captureCharFrame();
      modal.onKey(key("down"));
      await renderOnce();
      expect(captureCharFrame()).toBe(before);
    } finally {
      renderer.destroy();
    }
  });

  test("re-showing a new record resets scroll to the top", async () => {
    const { renderer, renderOnce, captureCharFrame, modal } = await setup();
    try {
      const lines = Array.from({ length: 100 }, (_, i) => `line-${i}`);
      modal.show(launched({ stderrTail: lines }));
      await renderOnce();
      for (let i = 0; i < 100; i++) modal.onKey(key("down"));
      await renderOnce();
      expect(captureCharFrame()).toContain("line-99");

      modal.show(launched({ pid: ProcessId(1), stderrTail: lines }));
      await renderOnce();
      expect(captureCharFrame()).toContain("line-0");
    } finally {
      renderer.destroy();
    }
  });
});

// Exhaustiveness guard: every `ProcessExitRecord` origin must be handled by the
// pure line-formatting helpers, so a new tier can't silently fall through.
const _exhaustive = (r: ProcessExitRecord): string => {
  switch (r.origin) {
    case "launched":
      return exitDetailLine(r);
    case "attached":
      return exitDetailLine(r);
  }
};
void _exhaustive;

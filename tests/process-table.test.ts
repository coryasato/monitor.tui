import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { Effect, Layer, Option } from "effect";
import { InputRouter, InputRouterLive } from "../src/services/input-router.ts";
import { Renderer } from "../src/services/renderer.ts";
import {
  Bytes,
  type MetricState,
  Percent,
  ProcessId,
  type ProcessRecord,
  Timestamp,
} from "../src/types/metrics.ts";
import {
  clampScroll,
  displayName,
  filterProcesses,
  formatHeader,
  formatProcessRow,
  type KillFn,
  makeProcessTable,
  nameWidthFor,
  resolveSelectedIndex,
  sortProcesses,
} from "../src/ui/components/process-table.ts";

const key = (name: string, sequence = name): import("../src/services/input-router.ts").InputKey => ({
  name,
  ctrl: false,
  shift: false,
  meta: false,
  option: false,
  sequence,
});
const typeChars = (
  table: ReturnType<typeof makeProcessTable>,
  text: string,
): void => {
  for (const ch of text) table.onFilterKey(key(ch));
};

const rec = (
  pid: number,
  cpu: number,
  mem: number,
  name = `/bin/p${pid}`,
): ProcessRecord => ({
  pid: ProcessId(pid),
  name,
  cpuPercent: Percent(cpu),
  memBytes: Bytes(mem),
  status: "running",
});

const okState = (procs: ReadonlyArray<ProcessRecord>): MetricState => ({
  _tag: "ok",
  tag: "process",
  at: Timestamp(Date.now()),
  snapshot: { _tag: "process", at: Timestamp(Date.now()), processes: procs },
});

// alpha cpu 10/mem 300, bravo cpu 50/mem 100, charlie cpu 30/mem 200
const alpha = rec(100, 10, 300, "/bin/alpha");
const bravo = rec(200, 50, 100, "/bin/bravo");
const charlie = rec(300, 30, 200, "/bin/charlie");
const three = [alpha, bravo, charlie];

describe("sortProcesses", () => {
  test("sorts by CPU descending", () => {
    expect(sortProcesses(three, "cpu").map((p) => p.pid as number)).toEqual([
      200, 300, 100,
    ]);
  });

  test("sorts by MEM descending", () => {
    expect(sortProcesses(three, "mem").map((p) => p.pid as number)).toEqual([
      100, 300, 200,
    ]);
  });

  test("breaks ties by pid ascending (stable across samples)", () => {
    const tied = [rec(5, 20, 50), rec(2, 20, 50), rec(9, 20, 50)];
    expect(sortProcesses(tied, "cpu").map((p) => p.pid as number)).toEqual([
      2, 5, 9,
    ]);
  });
});

describe("filterProcesses", () => {
  test("empty query returns every process unchanged", () => {
    expect(filterProcesses(three, "")).toEqual(three);
  });

  test("case-insensitive substring match", () => {
    expect(filterProcesses(three, "ALPHA").map((p) => p.pid as number)).toEqual([100]);
  });

  test("matches anywhere in the full command path, not just the basename", () => {
    const procs = [rec(1, 1, 1, "/usr/local/bin/bun"), rec(2, 1, 1, "/usr/bin/cargo")];
    expect(filterProcesses(procs, "local").map((p) => p.pid as number)).toEqual([1]);
  });

  test("no matches yields an empty array", () => {
    expect(filterProcesses(three, "zzz")).toEqual([]);
  });
});

describe("resolveSelectedIndex", () => {
  test("uses the found pid index when present", () => {
    expect(resolveSelectedIndex(5, 3, 0)).toBe(3);
  });
  test("falls back to the last index (clamped) when the pid is gone", () => {
    expect(resolveSelectedIndex(5, -1, 2)).toBe(2);
    expect(resolveSelectedIndex(3, -1, 9)).toBe(2);
  });
  test("returns -1 for an empty list", () => {
    expect(resolveSelectedIndex(0, -1, 0)).toBe(-1);
  });
});

describe("clampScroll", () => {
  test("scrolls down to keep the selection in view", () => {
    // viewport 5, selecting row 7 → window must start at 3 (rows 3..7).
    expect(clampScroll(7, 0, 5, 20)).toBe(3);
  });
  test("scrolls up to keep the selection in view", () => {
    expect(clampScroll(2, 6, 5, 20)).toBe(2);
  });
  test("does not move when the selection is already visible", () => {
    expect(clampScroll(4, 3, 5, 20)).toBe(3);
  });
  test("never scrolls past the last page", () => {
    expect(clampScroll(19, 0, 5, 20)).toBe(15);
  });
  test("is zero when everything fits", () => {
    expect(clampScroll(2, 0, 50, 10)).toBe(0);
  });
});

describe("displayName", () => {
  test("takes the path basename", () => {
    expect(displayName("/usr/local/bin/bun")).toBe("bun");
    expect(displayName("kernel_task")).toBe("kernel_task");
  });
});

describe("formatProcessRow / formatHeader", () => {
  test("row is padded to the body width and carries each column", () => {
    const row = formatProcessRow(alpha, 40);
    expect(row).toHaveLength(40);
    expect(row).toContain("100");
    expect(row).toContain("alpha");
    expect(row).toContain("10.0%");
    expect(row).toContain("300 B");
  });

  test("header marks the active sort column", () => {
    expect(formatHeader(40, "cpu")).toContain("CPU%▼");
    expect(formatHeader(40, "mem")).toContain("MEM▼");
  });

  test("name width shrinks to a floor on narrow panes", () => {
    expect(nameWidthFor(10)).toBe(6);
    expect(nameWidthFor(60)).toBeGreaterThan(6);
  });
});

// --- Integration: real renderer + windowing + input -------------------------

const setup = async (kill?: KillFn) => {
  const { renderer, mockInput, renderOnce, captureCharFrame } =
    await createTestRenderer({ width: 80, height: 24 });
  const table = makeProcessTable(renderer, kill ? { kill } : {});
  // In the app the table fills the flexGrow split column; here give it the full
  // height directly so the windowed body has room for the rows.
  table.root.height = "100%";
  renderer.root.add(table.root);
  await renderOnce();
  return { renderer, mockInput, renderOnce, captureCharFrame, table };
};

describe("ProcessTable (integration)", () => {
  test("renders processes sorted by CPU with the top row selected", async () => {
    const { renderer, renderOnce, captureCharFrame, table } = await setup();
    try {
      table.update(Option.some(okState(three)));
      await renderOnce();
      const frame = captureCharFrame();
      expect(frame).toContain("alpha");
      expect(frame).toContain("bravo");
      expect(frame).toContain("charlie");
      expect(frame).toContain("CPU%▼");
      // Highest CPU (bravo) is selected by default.
      expect(table.getSelection()?.pid as number).toBe(200);
    } finally {
      renderer.destroy();
    }
  });

  test("arrow keys move the PID-anchored selection", async () => {
    const { renderer, renderOnce, table } = await setup();
    try {
      table.update(Option.some(okState(three)));
      await renderOnce();
      // cpu order: bravo(200), charlie(300), alpha(100)
      table.onKey({ name: "down", ctrl: false, shift: false, meta: false, option: false, sequence: "" });
      expect(table.getSelection()?.pid as number).toBe(300);
      table.onKey({ name: "down", ctrl: false, shift: false, meta: false, option: false, sequence: "" });
      expect(table.getSelection()?.pid as number).toBe(100);
      table.onKey({ name: "up", ctrl: false, shift: false, meta: false, option: false, sequence: "" });
      expect(table.getSelection()?.pid as number).toBe(300);
    } finally {
      renderer.destroy();
    }
  });

  test("c/m toggle the sort column and the selection follows its PID", async () => {
    const { renderer, renderOnce, captureCharFrame, table } = await setup();
    try {
      table.update(Option.some(okState(three)));
      await renderOnce();
      // Select charlie (pid 300) under CPU sort.
      table.onKey({ name: "down", ctrl: false, shift: false, meta: false, option: false, sequence: "" });
      expect(table.getSelection()?.pid as number).toBe(300);

      table.onKey({ name: "m", ctrl: false, shift: false, meta: false, option: false, sequence: "" });
      await renderOnce();
      expect(table.getSortKey()).toBe("mem");
      expect(captureCharFrame()).toContain("MEM▼");
      // PID-anchored: still charlie despite the re-sort.
      expect(table.getSelection()?.pid as number).toBe(300);
    } finally {
      renderer.destroy();
    }
  });

  test("selection stays anchored to its PID across a data refresh", async () => {
    const { renderer, renderOnce, table } = await setup();
    try {
      table.update(Option.some(okState(three)));
      await renderOnce();
      table.onKey({ name: "down", ctrl: false, shift: false, meta: false, option: false, sequence: "" });
      expect(table.getSelection()?.pid as number).toBe(300); // charlie

      // New sample: CPUs change so the sort order flips, charlie still present.
      const next = [rec(100, 90, 300, "/bin/alpha"), rec(200, 5, 100, "/bin/bravo"), rec(300, 30, 200, "/bin/charlie")];
      table.update(Option.some(okState(next)));
      await renderOnce();
      expect(table.getSelection()?.pid as number).toBe(300);
    } finally {
      renderer.destroy();
    }
  });

  test("k opens a confirm; y sends SIGTERM to the selected PID", async () => {
    const kills: Array<{ pid: number; signal: string }> = [];
    const { renderer, renderOnce, captureCharFrame, table } = await setup(
      (pid, signal) => {
        kills.push({ pid, signal });
      },
    );
    try {
      table.update(Option.some(okState(three)));
      await renderOnce();
      table.onKey({ name: "k", ctrl: false, shift: false, meta: false, option: false, sequence: "" });
      await renderOnce();
      expect(captureCharFrame()).toContain("Kill PID 200");

      table.onKey({ name: "y", ctrl: false, shift: false, meta: false, option: false, sequence: "" });
      await renderOnce();
      expect(kills).toEqual([{ pid: 200, signal: "SIGTERM" }]);
    } finally {
      renderer.destroy();
    }
  });

  test("n cancels the kill without signaling", async () => {
    const kills: number[] = [];
    const { renderer, renderOnce, captureCharFrame, table } = await setup(
      (pid) => {
        kills.push(pid);
      },
    );
    try {
      table.update(Option.some(okState(three)));
      await renderOnce();
      table.onKey({ name: "k", ctrl: false, shift: false, meta: false, option: false, sequence: "" });
      table.onKey({ name: "n", ctrl: false, shift: false, meta: false, option: false, sequence: "" });
      await renderOnce();
      expect(kills).toEqual([]);
      expect(captureCharFrame()).not.toContain("Kill PID");
    } finally {
      renderer.destroy();
    }
  });

  test("a failed kill (EPERM) surfaces a toast, never throws", async () => {
    const { renderer, renderOnce, captureCharFrame, table } = await setup(() => {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    });
    try {
      table.update(Option.some(okState(three)));
      await renderOnce();
      table.onKey({ name: "k", ctrl: false, shift: false, meta: false, option: false, sequence: "" });
      table.onKey({ name: "y", ctrl: false, shift: false, meta: false, option: false, sequence: "" });
      await renderOnce();
      const frame = captureCharFrame();
      expect(frame).toContain("cannot kill");
      expect(frame).toContain("EPERM");
    } finally {
      renderer.destroy();
    }
  });

  test("windows the rows and scrolls lower ones into view", async () => {
    const { renderer, renderOnce, captureCharFrame, table } = await setup();
    try {
      // 40 processes, distinct CPUs → deterministic order proc00..proc39.
      const many = Array.from({ length: 40 }, (_, i) =>
        rec(1000 + i, 40 - i, 1000, `/bin/proc${String(i).padStart(2, "0")}`),
      );
      table.update(Option.some(okState(many)));
      await renderOnce();
      const top = captureCharFrame();
      expect(top).toContain("proc00");
      expect(top).not.toContain("proc39"); // below the viewport

      // Jump down past the viewport; the last rows scroll in, the first scroll out.
      const pagedown = { name: "pagedown", ctrl: false, shift: false, meta: false, option: false, sequence: "" };
      for (let i = 0; i < 5; i++) table.onKey(pagedown);
      await renderOnce();
      const bottom = captureCharFrame();
      expect(bottom).toContain("proc39");
      expect(bottom).not.toContain("proc00");
    } finally {
      renderer.destroy();
    }
  });

  test("shows a waiting message before the first sample", async () => {
    const { renderer, renderOnce, captureCharFrame } = await setup();
    try {
      await renderOnce();
      expect(captureCharFrame()).toContain("waiting for first reading");
    } finally {
      renderer.destroy();
    }
  });

  test("startFilter shows the bar with a cursor before any typing", async () => {
    const { renderer, renderOnce, captureCharFrame, table } = await setup();
    try {
      table.update(Option.some(okState(three)));
      await renderOnce();
      table.startFilter();
      await renderOnce();
      const frame = captureCharFrame();
      expect(frame).toContain("Filter:");
      expect(frame).toContain("3 / 3");
      expect(frame).toContain("alpha");
      expect(frame).toContain("bravo");
      expect(frame).toContain("charlie");
    } finally {
      renderer.destroy();
    }
  });

  test("typing narrows the table live and updates the match count", async () => {
    const { renderer, renderOnce, captureCharFrame, table } = await setup();
    try {
      table.update(Option.some(okState(three)));
      await renderOnce();
      table.startFilter();
      typeChars(table, "bravo");
      await renderOnce();
      const frame = captureCharFrame();
      expect(frame).toContain("Filter: bravo");
      expect(frame).toContain("1 / 3");
      expect(frame).toContain("bravo");
      expect(frame).not.toContain("alpha");
      expect(frame).not.toContain("charlie");
    } finally {
      renderer.destroy();
    }
  });

  test("backspace edits the query", async () => {
    const { renderer, renderOnce, captureCharFrame, table } = await setup();
    try {
      table.update(Option.some(okState(three)));
      await renderOnce();
      table.startFilter();
      typeChars(table, "bra");
      table.onFilterKey(key("backspace", "\x7F"));
      await renderOnce();
      expect(captureCharFrame()).toContain("Filter: br");
      expect(captureCharFrame()).not.toContain("Filter: bra ");
    } finally {
      renderer.destroy();
    }
  });

  test("no matches shows a message naming the query", async () => {
    const { renderer, renderOnce, captureCharFrame, table } = await setup();
    try {
      table.update(Option.some(okState(three)));
      await renderOnce();
      table.startFilter();
      typeChars(table, "zzz");
      await renderOnce();
      expect(captureCharFrame()).toContain('no matches for "zzz"');
    } finally {
      renderer.destroy();
    }
  });

  test("lockFilter (Enter) keeps the table filtered and drops the cursor", async () => {
    const { renderer, renderOnce, captureCharFrame, table } = await setup();
    try {
      table.update(Option.some(okState(three)));
      await renderOnce();
      table.startFilter();
      typeChars(table, "bravo");
      table.lockFilter();
      await renderOnce();
      const frame = captureCharFrame();
      expect(frame).toContain("Filter: bravo");
      expect(frame).not.toContain("█");
      expect(frame).toContain("bravo");
      expect(frame).not.toContain("alpha");
    } finally {
      renderer.destroy();
    }
  });

  test("clearFilter (Escape) restores the full list and hides the bar", async () => {
    const { renderer, renderOnce, captureCharFrame, table } = await setup();
    try {
      table.update(Option.some(okState(three)));
      await renderOnce();
      table.startFilter();
      typeChars(table, "bravo");
      table.clearFilter();
      await renderOnce();
      const frame = captureCharFrame();
      expect(frame).not.toContain("Filter:");
      expect(frame).toContain("alpha");
      expect(frame).toContain("bravo");
      expect(frame).toContain("charlie");
    } finally {
      renderer.destroy();
    }
  });

  test("a locked filter survives a data refresh — new samples don't reset the query", async () => {
    const { renderer, renderOnce, captureCharFrame, table } = await setup();
    try {
      table.update(Option.some(okState(three)));
      await renderOnce();
      table.startFilter();
      typeChars(table, "bravo");
      table.lockFilter();
      await renderOnce();

      const next = [...three, rec(400, 5, 50, "/bin/delta")];
      table.update(Option.some(okState(next)));
      await renderOnce();
      const frame = captureCharFrame();
      expect(frame).toContain("Filter: bravo");
      expect(frame).toContain("1 / 4");
      expect(frame).toContain("bravo");
      expect(frame).not.toContain("delta");
    } finally {
      renderer.destroy();
    }
  });

  test("filtered selection feeds the pin flow: arrow to the match, it's the one returned", async () => {
    const { renderer, renderOnce, table } = await setup();
    try {
      table.update(Option.some(okState(three)));
      await renderOnce();
      table.startFilter();
      typeChars(table, "a"); // matches alpha, bravo, charlie (all contain "a")
      table.lockFilter();
      await renderOnce();
      table.onKey(key("down"));
      table.onKey(key("down"));
      // cpu order among matches: bravo(200), charlie(300), alpha(100)
      expect(table.getSelection()?.pid as number).toBe(100);
    } finally {
      renderer.destroy();
    }
  });

  test("end-to-end: / enters Filter mode via the InputRouter; q/k are literal while typing", async () => {
    const { renderer, mockInput } = await createTestRenderer({ width: 80, height: 24 });
    const table = makeProcessTable(renderer);
    renderer.root.add(table.root);
    try {
      let modeAfterSlash = "";
      let modeAfterEnter = "";
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const router = yield* InputRouter;
            yield* router.register("Normal", (k) =>
              k.name === "/"
                ? Effect.sync(() => table.startFilter()).pipe(
                    Effect.zipRight(router.setMode("Filter")),
                  )
                : Effect.sync(() => table.onKey(k)),
            );
            yield* router.register("Filter", (k) => {
              if (k.name === "return") {
                return Effect.sync(() => table.lockFilter()).pipe(
                  Effect.zipRight(router.setMode("Normal")),
                );
              }
              if (k.name === "escape") {
                return Effect.sync(() => table.clearFilter()).pipe(
                  Effect.zipRight(router.setMode("Normal")),
                );
              }
              return Effect.sync(() => table.onFilterKey(k));
            });

            table.update(Option.some(okState(three)));
            yield* Effect.sleep("10 millis");
            yield* Effect.sync(() => mockInput.pressKey("/"));
            yield* Effect.sleep("10 millis");
            modeAfterSlash = yield* router.mode;

            yield* Effect.sync(() => mockInput.typeText("bravo"));
            yield* Effect.sleep("20 millis");
            // "q"/"k" are literal in Filter mode: no quit, no kill-confirm opened.
            yield* Effect.sync(() => mockInput.pressKey("q"));
            yield* Effect.sync(() => mockInput.pressKey("k"));
            yield* Effect.sleep("10 millis");
            expect(table.isAwaitingConfirm()).toBe(false);

            yield* Effect.sync(() => mockInput.pressEnter());
            yield* Effect.sleep("10 millis");
            modeAfterEnter = yield* router.mode;
          }).pipe(
            Effect.provide(
              InputRouterLive.pipe(
                Layer.provide(Layer.succeed(Renderer, renderer)),
              ),
            ),
          ),
        ),
      );
      expect(modeAfterSlash).toBe("Filter");
      expect(modeAfterEnter).toBe("Normal");
      // The literal "q"/"k" were appended to the query ("bravoqk"), which no
      // process name matches — proof they were text, not quit/kill keys.
      expect(table.getSelection()).toBeNull();
    } finally {
      renderer.destroy();
    }
  });

  test("end-to-end: a real keypress through the InputRouter drives the table", async () => {
    const { renderer, mockInput } = await createTestRenderer({ width: 80, height: 24 });
    const table = makeProcessTable(renderer);
    renderer.root.add(table.root);
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const router = yield* InputRouter;
            yield* router.register("Normal", (key) =>
              Effect.sync(() => table.onKey(key)),
            );
            table.update(Option.some(okState(three)));
            yield* Effect.sleep("10 millis");
            yield* Effect.sync(() => mockInput.pressKey("m"));
            yield* Effect.sleep("10 millis");
          }).pipe(
            Effect.provide(
              InputRouterLive.pipe(
                Layer.provide(Layer.succeed(Renderer, renderer)),
              ),
            ),
          ),
        ),
      );
      expect(table.getSortKey()).toBe("mem");
    } finally {
      renderer.destroy();
    }
  });
});

import { describe, expect, test } from "bun:test";
import {
  linuxStatus,
  parseProcPidStat,
  parseTotalJiffies,
} from "../src/collectors/process-linux.ts";

describe("parseProcPidStat", () => {
  // A representative /proc/<pid>/stat line. Fields (1-indexed): 1 pid, 2 comm,
  // 3 state, 4 ppid, 14 utime, 15 stime, 20 num_threads, 24 rss.
  const line =
    "1234 (bun) S 1 1234 1234 0 -1 4194560 1000 0 5 0 120 34 0 0 20 0 8 0 9999 123456 567 18446744073709551615 1 1 0 0 0 0 0 0 0";

  test("extracts pid, state, ppid, cpu jiffies, threads, rss", () => {
    const stat = parseProcPidStat(line);
    expect(stat).not.toBeNull();
    expect(stat).toMatchObject({
      pid: 1234,
      comm: "bun",
      state: "S",
      ppid: 1,
      cpuJiffies: 154, // utime 120 + stime 34
      threads: 8,
      rssPages: 567,
    });
  });

  test("handles a comm containing spaces and parens (splits on the last paren)", () => {
    const tricky =
      "42 (weird (proc) name) R 1 42 42 0 -1 0 0 0 0 0 7 3 0 0 20 0 4 0 100 0 250 0 0 0 0 0 0 0 0 0";
    const stat = parseProcPidStat(tricky);
    expect(stat).not.toBeNull();
    expect(stat?.comm).toBe("weird (proc) name");
    expect(stat?.state).toBe("R");
    expect(stat?.cpuJiffies).toBe(10);
    expect(stat?.rssPages).toBe(250);
  });

  test("returns null on a malformed line (no parens)", () => {
    expect(parseProcPidStat("not a stat line")).toBeNull();
  });
});

describe("parseTotalJiffies", () => {
  test("sums the aggregate cpu line across all states", () => {
    const stat = "cpu  100 20 80 700 10 0 5 0 0 0\ncpu0 50 10 40 350 5 0 2\n";
    expect(parseTotalJiffies(stat)).toBe(100 + 20 + 80 + 700 + 10 + 0 + 5);
  });

  test("returns null when the first line is not the aggregate cpu line", () => {
    expect(parseTotalJiffies("intr 123 4 5\ncpu 1 2 3")).toBeNull();
  });
});

describe("linuxStatus", () => {
  test("maps the state char to the normalized union", () => {
    expect(linuxStatus("R")).toBe("running");
    expect(linuxStatus("S")).toBe("sleeping");
    expect(linuxStatus("D")).toBe("sleeping");
    expect(linuxStatus("I")).toBe("idle");
    expect(linuxStatus("T")).toBe("stopped");
    expect(linuxStatus("t")).toBe("stopped");
    expect(linuxStatus("Z")).toBe("zombie");
    expect(linuxStatus("X")).toBe("unknown");
  });
});

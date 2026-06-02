import { describe, expect, test } from "bun:test";
import { parseCpuUsage } from "../src/collectors/cpu-macos.ts";

/** Representative `top -l 2 -n 0` output: two CPU usage samples. */
const TWO_SAMPLE_FIXTURE = `Processes: 600 total, 2 running, 598 sleeping, 3000 threads
2024/06/01 12:00:00
Load Avg: 2.50, 2.60, 2.70
CPU usage: 15.35% user, 20.53% sys, 64.10% idle
SharedLibs: 400M resident, 80M data, 30M linkedit.
MemRegions: 200000 total, 5G resident, 100M private, 2G shared.
PhysMem: 30G used (3G wired), 1G unused.
VM: 200T vsize, 3000M framework vsize, 0(0) swapins, 0(0) swapouts.
Networks: packets: 1/1K in, 1/1K out.
Disks: 100/2G read, 50/1G written.

Processes: 600 total, 2 running, 598 sleeping, 3000 threads
2024/06/01 12:00:01
Load Avg: 2.50, 2.60, 2.70
CPU usage: 16.96% user, 11.94% sys, 71.8% idle
SharedLibs: 400M resident, 80M data, 30M linkedit.`;

describe("parseCpuUsage", () => {
  test("returns the second (delta) sample, not the first", () => {
    const result = parseCpuUsage(TWO_SAMPLE_FIXTURE);
    expect(result).toEqual({ user: 16.96, system: 11.94, idle: 71.8 });
  });

  test("handles single-decimal precision (e.g. 71.8% idle)", () => {
    const result = parseCpuUsage(TWO_SAMPLE_FIXTURE);
    expect(result?.idle).toBe(71.8);
  });

  test("parses a single-sample output", () => {
    const single = "CPU usage: 1.00% user, 2.00% sys, 97.00% idle";
    expect(parseCpuUsage(single)).toEqual({ user: 1, system: 2, idle: 97 });
  });

  test("returns null when no CPU usage line is present", () => {
    expect(parseCpuUsage("Processes: 1 total\nLoad Avg: 0, 0, 0")).toBeNull();
  });

  test("returns null on empty input", () => {
    expect(parseCpuUsage("")).toBeNull();
  });

  test("is stateless across calls (regex lastIndex reset)", () => {
    const single = "CPU usage: 5.00% user, 5.00% sys, 90.00% idle";
    expect(parseCpuUsage(single)).toEqual(parseCpuUsage(single));
  });
});

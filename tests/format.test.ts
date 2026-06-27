import { describe, expect, test } from "bun:test";
import { formatBytes, formatRate } from "../src/ui/format.ts";

describe("formatBytes", () => {
  test("scales B → KiB → MiB → GiB", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KiB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MiB");
    expect(formatBytes(3 * 1024 ** 3)).toBe("3.0 GiB");
  });

  test("rounds bytes below 1 KiB to a whole number", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999.6)).toBe("1000 B");
  });
});

describe("formatRate", () => {
  test("scales B/s → KB/s → MB/s", () => {
    expect(formatRate(500)).toBe("500 B/s");
    expect(formatRate(2048)).toBe("2.0 KB/s");
    expect(formatRate(3 * 1024 * 1024)).toBe("3.0 MB/s");
  });
});

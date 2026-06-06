import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { Option } from "effect";
import {
  formatRate,
  makeNetworkReadout,
  type NetworkReadout,
} from "../src/ui/components/network-readout.ts";
import {
  BytesPerSec,
  type MetricState,
  Timestamp,
} from "../src/types/metrics.ts";

const netOk = (rx: number, tx: number): MetricState => ({
  _tag: "ok",
  tag: "network",
  at: Timestamp(1000),
  snapshot: {
    _tag: "network",
    at: Timestamp(1000),
    rxBytesPerSec: BytesPerSec(rx),
    txBytesPerSec: BytesPerSec(tx),
  },
});

describe("formatRate", () => {
  test("scales B/s → KB/s → MB/s", () => {
    expect(formatRate(512)).toBe("512 B/s");
    expect(formatRate(2 * 1024)).toBe("2.0 KB/s");
    expect(formatRate(3 * 1024 * 1024)).toBe("3.0 MB/s");
  });
});

const withReadout = async (
  body: (ctx: {
    readout: NetworkReadout;
    renderOnce: () => Promise<unknown>;
    frame: () => string;
  }) => Promise<void>,
): Promise<void> => {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
    width: 60,
    height: 8,
  });
  try {
    const readout = makeNetworkReadout(renderer);
    renderer.root.add(readout.root);
    await body({ readout, renderOnce, frame: captureCharFrame });
  } finally {
    renderer.destroy();
  }
};

describe("NetworkReadout rendering", () => {
  test("renders rx/tx rates", async () => {
    await withReadout(async ({ readout, renderOnce, frame }) => {
      readout.update(Option.some(netOk(2 * 1024 * 1024, 512 * 1024)));
      await renderOnce();
      const text = frame();
      expect(text).toContain("2.0 MB/s");
      expect(text).toContain("512.0 KB/s");
    });
  });

  test("renders the reason for an unavailable state", async () => {
    await withReadout(async ({ readout, renderOnce, frame }) => {
      readout.update(
        Option.some({
          _tag: "unavailable",
          tag: "network",
          at: Timestamp(2000),
          reason: "netstat failed",
        }),
      );
      await renderOnce();
      expect(frame()).toContain("unavailable (netstat failed)");
    });
  });
});

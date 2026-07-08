import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { Option } from "effect";
import {
  type DiskReadout,
  makeDiskReadout,
} from "../src/ui/components/disk-readout.ts";
import {
  BytesPerSec,
  type MetricState,
  Timestamp,
} from "../src/types/metrics.ts";
import type { AlertThresholds } from "../src/ui/alerts.ts";

const thresholds: AlertThresholds = { warn: 80, critical: 95 };

const diskOk = (bytesPerSec: number): MetricState => ({
  _tag: "ok",
  tag: "disk",
  at: Timestamp(1000),
  snapshot: {
    _tag: "disk",
    at: Timestamp(1000),
    bytesPerSec: BytesPerSec(bytesPerSec),
  },
});

const withReadout = async (
  body: (ctx: {
    readout: DiskReadout;
    renderOnce: () => Promise<unknown>;
    frame: () => string;
  }) => Promise<void>,
): Promise<void> => {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
    width: 50,
    height: 8,
  });
  try {
    const readout = makeDiskReadout(renderer, thresholds);
    renderer.root.add(readout.root);
    await body({ readout, renderOnce, frame: captureCharFrame });
  } finally {
    renderer.destroy();
  }
};

describe("DiskReadout rendering", () => {
  test("renders combined I/O throughput", async () => {
    await withReadout(async ({ readout, renderOnce, frame }) => {
      readout.update(Option.some(diskOk(5 * 1024 * 1024)));
      await renderOnce();
      const text = frame();
      expect(text).toContain("I/O");
      expect(text).toContain("5.0 MB/s");
    });
  });

  test("renders the reason for an unavailable state", async () => {
    await withReadout(async ({ readout, renderOnce, frame }) => {
      readout.update(
        Option.some({
          _tag: "unavailable",
          tag: "disk",
          at: Timestamp(2000),
          reason: "iostat failed",
        }),
      );
      await renderOnce();
      expect(frame()).toContain("unavailable (iostat failed)");
    });
  });
});

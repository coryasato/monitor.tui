import { describe, expect, test } from "bun:test";
import { Effect, Stream } from "effect";
import {
  NetworkCollectorLinuxLive,
  parseProcNetDev,
} from "../src/collectors/network-linux.ts";
import { NetworkCollector } from "../src/services/network-collector.ts";

// Real-world shape: two header rows (no interface colon), then per-interface rows
// `name: rxBytes rxPkts errs drop fifo frame compressed multicast txBytes txPkts …`.
const NET_DEV = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo:  123456     100    0    0    0     0          0         0   123456     100    0    0    0     0       0          0
  eth0: 5000000    4000    0    0    0     0          0         0  2000000    3000    0    0    0     0       0          0
 wlan0: 1000000    1000    0    0    0     0          0         0   500000     800    0    0    0     0       0          0`;

describe("parseProcNetDev", () => {
  test("sums rx (field 1) and tx (field 9) across non-loopback interfaces", () => {
    // eth0 rx 5,000,000 + wlan0 1,000,000; tx 2,000,000 + 500,000. lo excluded.
    expect(parseProcNetDev(NET_DEV)).toEqual({
      rxBytes: 6_000_000,
      txBytes: 2_500_000,
    });
  });

  test("returns null when only header rows are present", () => {
    expect(
      parseProcNetDev("Inter-|   Receive\n face |bytes    packets"),
    ).toBeNull();
  });

  test("skips lines with too few columns", () => {
    expect(parseProcNetDev("eth0: 1 2 3\n")).toBeNull();
  });
});

const itLinux = process.platform === "linux" ? test : test.skip;

describe("NetworkCollectorLinuxLive (integration, Linux only)", () => {
  itLinux(
    "emits a valid ok network reading from real /proc/net/dev",
    async () => {
      const head = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const net = yield* NetworkCollector;
            return yield* net.stream.pipe(Stream.take(1), Stream.runHead);
          }),
          NetworkCollectorLinuxLive,
        ),
      );
      expect(head._tag).toBe("Some");
      if (head._tag !== "Some") return;
      const state = head.value;
      expect(state._tag).toBe("ok");
      if (state._tag !== "ok" || state.snapshot._tag !== "network") return;
      expect(state.snapshot.rxBytesPerSec).toBeGreaterThanOrEqual(0);
      expect(state.snapshot.txBytesPerSec).toBeGreaterThanOrEqual(0);
    },
    15_000,
  );
});

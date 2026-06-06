import { describe, expect, test } from "bun:test";
import { Effect, Stream } from "effect";
import {
  computeRates,
  type NetTotals,
  NetworkCollectorMacOSLive,
  parseNetTotals,
} from "../src/collectors/network-macos.ts";
import { NetworkCollector } from "../src/services/network-collector.ts";

// Real-world shape: lo0 link row has NO MAC; en0/anpi0 link rows DO. Address
// rows (with "-" error columns) duplicate totals and must be ignored.
const NETSTAT = `Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll
lo0        16384 <Link#1>                       100     0       1000      100     0       1000     0
lo0        16384 127           localhost          100     -       1000      100     -       1000     -
en0        1500  <Link#5>    aa:bb:cc:dd:ee:ff     50     0       5000       40     0       4000     0
en0        1500  192.168.1     myhost              50     -       5000       40     -       4000     -
anpi0      1500  <Link#4>    8e:9e:80:21:ad:1d     10     0       2000        5     0        500     0`;

describe("parseNetTotals", () => {
  test("sums Link rows, excluding loopback and address rows", () => {
    // en0: rx 5000 tx 4000; anpi0: rx 2000 tx 500. lo0 excluded.
    expect(parseNetTotals(NETSTAT)).toEqual({ rxBytes: 7000, txBytes: 4500 });
  });

  test("handles Link rows with and without a MAC address", () => {
    const noMac = `en9 1500 <Link#9> 1 2 111 3 4 222 0`;
    const withMac = `en9 1500 <Link#9> aa:bb:cc:dd:ee:ff 1 2 111 3 4 222 0`;
    expect(parseNetTotals(noMac)).toEqual({ rxBytes: 111, txBytes: 222 });
    expect(parseNetTotals(withMac)).toEqual({ rxBytes: 111, txBytes: 222 });
  });

  test("returns null when no interface row is present", () => {
    expect(parseNetTotals("Name Mtu Network\n")).toBeNull();
  });
});

describe("computeRates", () => {
  const prev: NetTotals = { rxBytes: 1000, txBytes: 500 };

  test("computes per-second rates over the elapsed interval", () => {
    const next: NetTotals = { rxBytes: 3000, txBytes: 1500 };
    expect(computeRates(prev, next, 1000)).toEqual({
      rxBytesPerSec: 2000,
      txBytesPerSec: 1000,
    });
    // Half-second interval doubles the rate.
    expect(computeRates(prev, next, 500)).toEqual({
      rxBytesPerSec: 4000,
      txBytesPerSec: 2000,
    });
  });

  test("clamps counter resets (negative deltas) to 0", () => {
    const reset: NetTotals = { rxBytes: 10, txBytes: 5 };
    expect(computeRates(prev, reset, 1000)).toEqual({
      rxBytesPerSec: 0,
      txBytesPerSec: 0,
    });
  });

  test("returns null for a non-positive interval", () => {
    expect(computeRates(prev, prev, 0)).toBeNull();
    expect(computeRates(prev, prev, -5)).toBeNull();
  });
});

describe("NetworkCollectorMacOSLive (integration)", () => {
  test(
    "emits a valid ok network reading from real netstat samples",
    async () => {
      const head = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const net = yield* NetworkCollector;
            return yield* net.stream.pipe(Stream.take(1), Stream.runHead);
          }),
          NetworkCollectorMacOSLive,
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

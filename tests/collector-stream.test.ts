import { describe, expect, test } from "bun:test";
import { Chunk, Duration, Effect, Ref, Stream } from "effect";
import { collectorStream } from "../src/collectors/collector-stream.ts";
import { CpuCollectorMacOSLive } from "../src/collectors/cpu-macos.ts";
import { CpuCollector } from "../src/services/cpu-collector.ts";
import { CollectorError } from "../src/types/errors.ts";
import { Percent, Timestamp, type CpuSnapshot } from "../src/types/metrics.ts";

const snapshot: CpuSnapshot = {
  _tag: "cpu",
  at: Timestamp(1000),
  user: Percent(10),
  system: Percent(20),
  idle: Percent(70),
};

/** Take the first `n` states from a stream as a plain array. */
const take = <A>(stream: Stream.Stream<A>, n: number): Promise<A[]> =>
  Effect.runPromise(
    stream.pipe(Stream.take(n), Stream.runCollect, Effect.map(Chunk.toReadonlyArray)),
  ) as Promise<A[]>;

describe("collectorStream", () => {
  test("maps a successful read to an ok state carrying the snapshot", async () => {
    const [state] = await take(
      collectorStream("cpu", Effect.succeed(snapshot), Duration.zero),
      1,
    );
    expect(state).toEqual({
      _tag: "ok",
      tag: "cpu",
      at: snapshot.at,
      snapshot,
    });
  });

  test("recovers a CollectorError into an unavailable state with its reason", async () => {
    const failing = Effect.fail(
      new CollectorError({ collector: "cpu", reason: "top exploded" }),
    );
    const [state] = await take(collectorStream("cpu", failing, Duration.zero), 1);
    expect(state?._tag).toBe("unavailable");
    expect(state).toMatchObject({ tag: "cpu", reason: "top exploded" });
  });

  test("keeps streaming after a failure instead of terminating", async () => {
    // Read fails on the first tick, then succeeds — the stream must survive the
    // failure and continue emitting (the graceful-degradation contract).
    const program = Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const read = Effect.gen(function* () {
        const n = yield* Ref.updateAndGet(calls, (x) => x + 1);
        return n === 1
          ? yield* new CollectorError({ collector: "cpu", reason: "boom" })
          : snapshot;
      });
      return yield* collectorStream("cpu", read, Duration.zero).pipe(
        Stream.take(3),
        Stream.runCollect,
      );
    });
    const states = Chunk.toReadonlyArray(await Effect.runPromise(program));
    expect(states.map((s) => s._tag)).toEqual(["unavailable", "ok", "ok"]);
  });

  // Integration: drives the real macOS Layer through `top`, exercising
  // spawn → parse → Valibot → brand end-to-end. Slow (~2s for one sample).
  test(
    "the live macOS collector emits a valid ok reading from real `top`",
    async () => {
      const first = Effect.gen(function* () {
        const cpu = yield* CpuCollector;
        return yield* cpu.stream.pipe(Stream.take(1), Stream.runHead);
      });
      const head = await Effect.runPromise(
        Effect.provide(first, CpuCollectorMacOSLive),
      );
      // runHead yields Option; the stream always emits, so it is Some.
      expect(head._tag).toBe("Some");
      if (head._tag !== "Some") return;
      const state = head.value;
      expect(state._tag).toBe("ok");
      if (state._tag !== "ok") return;
      const { user, system, idle } = state.snapshot;
      for (const p of [user, system, idle]) {
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(100);
      }
      // user + system + idle should account for ~all CPU time.
      expect(user + system + idle).toBeGreaterThan(95);
    },
    15_000,
  );
});

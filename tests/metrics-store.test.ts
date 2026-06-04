import { describe, expect, test } from "bun:test";
import { Effect, HashMap, Option } from "effect";
import {
  MetricsStore,
  MetricsStoreLive,
} from "../src/services/metrics-store.ts";
import { Percent, Timestamp, type MetricState } from "../src/types/metrics.ts";

const okState: MetricState = {
  _tag: "ok",
  tag: "cpu",
  at: Timestamp(1000),
  snapshot: {
    _tag: "cpu",
    at: Timestamp(1000),
    user: Percent(10),
    system: Percent(20),
    idle: Percent(70),
  },
};

/** Run an Effect that needs the store against a fresh live store. */
const withStore = <A>(program: Effect.Effect<A, never, MetricsStore>) =>
  Effect.runPromise(Effect.provide(program, MetricsStoreLive));

describe("MetricsStore", () => {
  test("get returns None before anything is set", async () => {
    const result = await withStore(
      Effect.flatMap(MetricsStore, (store) => store.get("cpu")),
    );
    expect(Option.isNone(result)).toBe(true);
  });

  test("set then get returns the latest state", async () => {
    const result = await withStore(
      Effect.gen(function* () {
        const store = yield* MetricsStore;
        yield* store.set(okState);
        return yield* store.get("cpu");
      }),
    );
    expect(result).toEqual(Option.some(okState));
  });

  test("set overwrites the previous state for the same tag", async () => {
    const unavailable: MetricState = {
      _tag: "unavailable",
      tag: "cpu",
      at: Timestamp(2000),
      reason: "top failed",
    };
    const result = await withStore(
      Effect.gen(function* () {
        const store = yield* MetricsStore;
        yield* store.set(okState);
        yield* store.set(unavailable);
        return yield* store.get("cpu");
      }),
    );
    expect(result).toEqual(Option.some(unavailable));
  });

  test("getAll is empty initially and reflects recorded states", async () => {
    const { before, after } = await withStore(
      Effect.gen(function* () {
        const store = yield* MetricsStore;
        const before = yield* store.getAll;
        yield* store.set(okState);
        const after = yield* store.getAll;
        return { before, after };
      }),
    );
    expect(HashMap.size(before)).toBe(0);
    expect(HashMap.size(after)).toBe(1);
    expect(HashMap.get(after, "cpu")).toEqual(Option.some(okState));
  });

  test("keeps tags independent: one unavailable does not affect another", async () => {
    // The graceful-degradation guarantee at the store level: a failing memory
    // collector marks only "memory" unavailable; "cpu" stays ok.
    const memoryDown: MetricState = {
      _tag: "unavailable",
      tag: "memory",
      at: Timestamp(3000),
      reason: "vm_stat failed",
    };
    const { cpu, memory } = await withStore(
      Effect.gen(function* () {
        const store = yield* MetricsStore;
        yield* store.set(okState); // cpu ok
        yield* store.set(memoryDown); // memory unavailable
        return {
          cpu: yield* store.get("cpu"),
          memory: yield* store.get("memory"),
        };
      }),
    );
    expect(cpu).toEqual(Option.some(okState));
    expect(memory).toEqual(Option.some(memoryDown));
  });
});

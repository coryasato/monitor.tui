import { Context, Effect, HashMap, Layer, type Option, Ref } from "effect";
import type { MetricState, MetricTag } from "../types/metrics.ts";

/**
 * Central store of the latest {@link MetricState} per collector, backed by a
 * `Ref<HashMap>`. Collectors write (push) from their own fibers; UI components
 * read (pull) on a render tick. There is no fiber-to-component wiring — the store
 * is the only shared point, and it holds immutable snapshots.
 */
export class MetricsStore extends Context.Tag("MetricsStore")<
  MetricsStore,
  {
    /** Write the latest state for a metric, overwriting any previous value. */
    readonly set: (state: MetricState) => Effect.Effect<void>;
    /** Read the latest state for one metric, if any has been recorded. */
    readonly get: (tag: MetricTag) => Effect.Effect<Option.Option<MetricState>>;
    /** Snapshot of all metric states (for full-screen layouts). */
    readonly getAll: Effect.Effect<HashMap.HashMap<MetricTag, MetricState>>;
  }
>() {}

/** Live store backed by an in-memory `Ref<HashMap>`. */
export const MetricsStoreLive = Layer.effect(
  MetricsStore,
  Effect.gen(function* () {
    const ref = yield* Ref.make(HashMap.empty<MetricTag, MetricState>());
    return MetricsStore.of({
      set: (state) => Ref.update(ref, HashMap.set(state.tag, state)),
      get: (tag) => Effect.map(Ref.get(ref), HashMap.get(tag)),
      getAll: Ref.get(ref),
    });
  }),
);

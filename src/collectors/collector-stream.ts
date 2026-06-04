import { type Duration, Effect, Schedule, Stream } from "effect";
import type { CollectorError } from "../types/errors.ts";
import {
  type MetricSnapshot,
  type MetricState,
  type MetricTag,
  Timestamp,
} from "../types/metrics.ts";

/**
 * Shared collector infrastructure: turn a one-shot `read` Effect into the
 * never-failing, never-ending `Stream<MetricState>` the MetricsStore consumes.
 * Every collector (cpu, memory, disk, …) reuses this so polling cadence and the
 * graceful-degradation contract live in exactly one place.
 */

const toOk = (snapshot: MetricSnapshot): MetricState => ({
  _tag: "ok",
  tag: snapshot._tag,
  at: snapshot.at,
  snapshot,
});

const toUnavailable = (tag: MetricTag, reason: string): MetricState => ({
  _tag: "unavailable",
  tag,
  at: Timestamp(Date.now()),
  reason,
});

/**
 * Build a metric stream from a polling read. Each tick runs `read`: a success
 * becomes an `ok` state, a recoverable `CollectorError` becomes an `unavailable`
 * state (so the stream keeps polling through failures). `gap` spaces successive
 * reads. The result never fails (`E = never`) and never terminates.
 */
export const collectorStream = (
  tag: MetricTag,
  read: Effect.Effect<MetricSnapshot, CollectorError>,
  gap: Duration.Duration,
): Stream.Stream<MetricState> =>
  Stream.repeatEffect(
    read.pipe(
      Effect.map(toOk),
      Effect.catchTag("CollectorError", (error) =>
        Effect.succeed(toUnavailable(tag, error.reason)),
      ),
    ),
  ).pipe(Stream.schedule(Schedule.spaced(gap)));

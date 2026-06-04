import { BunRuntime } from "@effect/platform-bun";
import { Duration, Effect, Layer, Option, Schedule, Stream } from "effect";
import { CpuCollectorMacOSLive } from "../collectors/cpu-macos.ts";
import { CpuCollector } from "../services/cpu-collector.ts";
import { MetricsStore, MetricsStoreLive } from "../services/metrics-store.ts";

/**
 * Phase 2 milestone: a collector fiber pushes CPU readings into the store while a
 * separate loop pulls the latest state on a tick. Demonstrates the full data flow
 * (Collector Fiber → Stream → MetricsStore → pull-based read) plus resource-safe,
 * cancellable shutdown. Run with `bun src/app/stream-demo.ts`; Ctrl+C to stop.
 */
const program = Effect.gen(function* () {
  const cpu = yield* CpuCollector;
  const store = yield* MetricsStore;

  // Collector owns its interval; we just drain its stream into the store. Forking
  // into the enclosing scope means the fiber is interrupted automatically on
  // shutdown — no manual teardown needed.
  yield* cpu.stream.pipe(
    Stream.runForEach((state) => store.set(state)),
    Effect.forkScoped,
  );

  // Pull-based reader: the UI will do exactly this on each render tick.
  yield* store.get("cpu").pipe(
    Effect.flatMap((state) =>
      Option.match(state, {
        onNone: () => Effect.log("cpu: (waiting for first reading…)"),
        onSome: (s) =>
          s._tag === "ok"
            ? Effect.log(
                `cpu: user ${s.snapshot.user}%  sys ${s.snapshot.system}%  idle ${s.snapshot.idle}%`,
              )
            : Effect.log(`cpu: unavailable (${s.reason})`),
      }),
    ),
    Effect.repeat(Schedule.spaced(Duration.seconds(1))),
  );
});

const AppLive = Layer.merge(MetricsStoreLive, CpuCollectorMacOSLive);

BunRuntime.runMain(Effect.scoped(Effect.provide(program, AppLive)));

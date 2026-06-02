import { Effect } from "effect";
import { CpuCollectorMacOSLive } from "../collectors/cpu-macos.ts";
import { CpuCollector } from "../services/cpu-collector.ts";

/**
 * Phase 1 milestone scratch program: provide the CPU Layer and print one real
 * reading. Run with `bun src/app/cpu-demo.ts`.
 */
const program = Effect.gen(function* () {
  const cpu = yield* CpuCollector;
  const snap = yield* cpu.read;
  yield* Effect.log(
    `CPU  user ${snap.user}%  sys ${snap.system}%  idle ${snap.idle}%`,
  );
});

Effect.runPromise(program.pipe(Effect.provide(CpuCollectorMacOSLive))).catch(
  (err) => {
    console.error("cpu-demo failed:", err);
    process.exit(1);
  },
);

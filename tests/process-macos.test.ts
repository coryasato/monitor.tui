import { describe, expect, test } from "bun:test";
import { Effect, Stream } from "effect";
import { ProcessCollectorMacOSLive } from "../src/collectors/process-macos.ts";
import { ProcessCollector } from "../src/services/process-collector.ts";
import { ProcessId } from "../src/types/metrics.ts";

// Hits real libproc via the Bun FFI helper; macOS-only. Guarded so the suite
// stays green on Linux (where the Mach/libproc symbols don't link).
const onMac = process.platform === "darwin";

describe.if(onMac)("ProcessCollectorMacOSLive (integration)", () => {
  test(
    "emits an ok process snapshot with sane records",
    async () => {
      const head = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const processes = yield* ProcessCollector;
            return yield* processes.stream.pipe(Stream.take(1), Stream.runHead);
          }),
          ProcessCollectorMacOSLive,
        ),
      );

      expect(head._tag).toBe("Some");
      if (head._tag !== "Some") return;
      const state = head.value;
      expect(state._tag).toBe("ok");
      if (state._tag !== "ok" || state.snapshot._tag !== "process") return;

      const { processes } = state.snapshot;
      // A live macOS box always has well more than a handful of processes.
      expect(processes.length).toBeGreaterThan(10);

      // This test process must appear in the table, with a real path name and a
      // nonzero RSS. Asserting memBytes > 0 (not just >= 0) actually exercises the
      // hand-written `pti_resident_size` struct offset — a wrong offset would read
      // a zero/garbage field and fail here rather than silently passing.
      const self = processes.find((p) => p.pid === process.pid);
      expect(self).toBeDefined();
      expect(self?.name.length).toBeGreaterThan(0);
      expect(self?.name).toContain("bun");
      expect((self?.memBytes ?? 0) as number).toBeGreaterThan(0);

      for (const p of processes) {
        expect(p.pid).toBeGreaterThan(0);
        expect(p.cpuPercent).toBeGreaterThanOrEqual(0);
        expect(p.cpuPercent).toBeLessThanOrEqual(100);
        expect(p.memBytes).toBeGreaterThanOrEqual(0);
      }
    },
    15_000,
  );

  test(
    "focusStream emits an ok process-focus snapshot for this process",
    async () => {
      // Pinning our own PID exercises the focus reader, which reuses
      // `read_processes` filtered to the PID — including field 4 (thread count).
      const head = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const processes = yield* ProcessCollector;
            return yield* processes
              .focusStream(ProcessId(process.pid))
              .pipe(Stream.take(1), Stream.runHead);
          }),
          ProcessCollectorMacOSLive,
        ),
      );

      expect(head._tag).toBe("Some");
      if (head._tag !== "Some") return;
      const state = head.value;
      expect(state._tag).toBe("ok");
      if (state._tag !== "ok" || state.snapshot._tag !== "process-focus") return;

      const f = state.snapshot;
      expect(f.pid as number).toBe(process.pid);
      expect(f.name).toContain("bun");
      expect((f.memBytes as number) > 0).toBe(true);
      expect(f.cpuPercent).toBeGreaterThanOrEqual(0);
      expect(f.cpuPercent).toBeLessThanOrEqual(100);
      expect(f.memPercent).toBeGreaterThanOrEqual(0);
      expect(f.memPercent).toBeLessThanOrEqual(100);
      expect(f.threadCount).toBeGreaterThan(0); // a bun runtime is multi-threaded
      // macOS MVP: FD count is null (a second libproc module is unusable here;
      // never the slow lsof path). Linux sources real FDs from /proc/<pid>/fd.
      expect(f.openFds).toBeNull();
    },
    15_000,
  );

  test(
    "focusStream reports unavailable for a nonexistent PID",
    async () => {
      const head = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const processes = yield* ProcessCollector;
            // A PID that is essentially guaranteed not to exist.
            return yield* processes
              .focusStream(ProcessId(900_001))
              .pipe(Stream.take(1), Stream.runHead);
          }),
          ProcessCollectorMacOSLive,
        ),
      );
      expect(head._tag).toBe("Some");
      if (head._tag !== "Some") return;
      expect(head.value._tag).toBe("unavailable");
    },
    15_000,
  );
});

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { LineRing, launchProcess } from "../src/services/launched-process.ts";

describe("LineRing", () => {
  test("splits complete lines on newline", () => {
    const ring = new LineRing(10);
    ring.push("one\ntwo\nthree\n");
    expect(ring.snapshot()).toEqual(["one", "two", "three"]);
  });

  test("carries a partial line across chunk boundaries", () => {
    const ring = new LineRing(10);
    ring.push("hel");
    ring.push("lo\nwor");
    // "hello" is complete; "wor" is still pending but shown in the snapshot.
    expect(ring.snapshot()).toEqual(["hello", "wor"]);
    ring.push("ld\n");
    expect(ring.snapshot()).toEqual(["hello", "world"]);
  });

  test("drops the oldest lines beyond capacity", () => {
    const ring = new LineRing(2);
    ring.push("a\nb\nc\nd\n");
    expect(ring.snapshot()).toEqual(["c", "d"]);
  });

  test("flush commits a trailing partial line with no newline", () => {
    const ring = new LineRing(10);
    ring.push("no newline here");
    expect(ring.snapshot()).toEqual(["no newline here"]); // shown as pending
    ring.flush();
    expect(ring.snapshot()).toEqual(["no newline here"]); // now a committed line
  });

  test("strips a trailing CR so CRLF reads cleanly", () => {
    const ring = new LineRing(10);
    ring.push("win\r\nline\r\n");
    expect(ring.snapshot()).toEqual(["win", "line"]);
  });
});

describe("launchProcess", () => {
  test("captures the real exit code and stderr of a crashing child", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* launchProcess(
            ["sh", "-c", "echo boom >&2; exit 3"],
            { stderrLines: 200, killOnExit: true },
          );
          const info = yield* handle.awaitExit;
          // The stderr pump drains asynchronously; poll until "boom" lands.
          let tail = handle.stderrTail();
          for (let i = 0; i < 40 && !tail.some((l) => l.includes("boom")); i++) {
            yield* Effect.sleep(25);
            tail = handle.stderrTail();
          }
          return { info, tail };
        }),
      ),
    );
    expect(result.info.exitCode).toBe(3);
    expect(result.info.signalCode).toBeNull();
    expect(result.tail).toContain("boom");
  });

  test("reports exit code 0 for a clean child", async () => {
    const info = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* launchProcess(["true"], {
            stderrLines: 10,
            killOnExit: true,
          });
          return yield* handle.awaitExit;
        }),
      ),
    );
    expect(info.exitCode).toBe(0);
  });

  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  test("killOnExit kills the child's process group when the scope closes", async () => {
    const pid = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* launchProcess(["sleep", "30"], {
            stderrLines: 10,
            killOnExit: true,
          });
          expect(alive(handle.pid as number)).toBe(true);
          return handle.pid as number;
        }),
      ),
    );
    // Scope has closed → the group-kill finalizer ran. Poll until it's gone.
    let gone = false;
    for (let i = 0; i < 60; i++) {
      if (!alive(pid)) {
        gone = true;
        break;
      }
      await Bun.sleep(25);
    }
    expect(gone).toBe(true);
  });

  test("--no-kill-on-exit leaves the child running after the scope closes", async () => {
    const pid = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* launchProcess(["sleep", "30"], {
            stderrLines: 10,
            killOnExit: false,
          });
          return handle.pid as number;
        }),
      ),
    );
    try {
      // The detached child survives the monitor's teardown.
      await Bun.sleep(100);
      expect(alive(pid)).toBe(true);
    } finally {
      try {
        process.kill(-pid, "SIGKILL"); // clean up the group we intentionally left
      } catch {
        /* already gone */
      }
    }
  });

  test("a bad command surfaces a CollectorError rather than throwing", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        launchProcess(["definitely-not-a-real-binary-xyz"], {
          stderrLines: 10,
          killOnExit: true,
        }).pipe(Effect.map((h) => h.pid)),
      ),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(JSON.stringify(exit.cause)).toContain("CollectorError");
    }
  });
});

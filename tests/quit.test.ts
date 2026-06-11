import { describe, expect, test } from "bun:test";
import { createTestRenderer, type MockInput } from "@opentui/core/testing";
import { Effect, Fiber, Option } from "effect";
import { awaitQuit, isQuitKey } from "../src/app/quit.ts";

describe("isQuitKey", () => {
  test("quits on plain q", () => {
    expect(isQuitKey({ name: "q", ctrl: false })).toBe(true);
  });

  test("quits on Ctrl+C", () => {
    expect(isQuitKey({ name: "c", ctrl: true })).toBe(true);
  });

  test("does not quit on plain c (needs ctrl)", () => {
    expect(isQuitKey({ name: "c", ctrl: false })).toBe(false);
  });

  test("quits on q even with ctrl held (q matches regardless of modifiers)", () => {
    expect(isQuitKey({ name: "q", ctrl: true })).toBe(true);
  });

  test("ignores unrelated keys", () => {
    expect(isQuitKey({ name: "a", ctrl: false })).toBe(false);
    expect(isQuitKey({ name: "x", ctrl: true })).toBe(false);
  });
});

/**
 * Drive a real keypress through the renderer's parser and report whether the
 * `awaitQuit` effect completes. `kittyKeyboard` toggles the encoding so we cover
 * both the bare-byte path and the CSI-u path that originally broke Ctrl+C.
 */
const quitsOn = async (
  kittyKeyboard: boolean,
  press: (input: MockInput) => void,
): Promise<boolean> => {
  const { renderer, mockInput } = await createTestRenderer({
    width: 40,
    height: 8,
    kittyKeyboard,
  });
  try {
    return await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(awaitQuit(renderer));
        // Let the forked fiber register its keypress listener before we press.
        yield* Effect.sleep("10 millis");
        yield* Effect.sync(() => press(mockInput));
        // Completes → Some(void); times out (still waiting) → None.
        const result = yield* Fiber.join(fiber).pipe(
          Effect.timeoutOption("200 millis"),
        );
        if (Option.isNone(result)) yield* Fiber.interrupt(fiber);
        return Option.isSome(result);
      }),
    );
  } finally {
    renderer.destroy();
  }
};

describe("awaitQuit (real key parsing)", () => {
  for (const kitty of [false, true]) {
    const label = kitty ? "kitty protocol" : "legacy bytes";

    test(`completes on Ctrl+C (${label})`, async () => {
      expect(await quitsOn(kitty, (m) => m.pressCtrlC())).toBe(true);
    });

    test(`completes on q (${label})`, async () => {
      expect(await quitsOn(kitty, (m) => m.pressKey("q"))).toBe(true);
    });

    test(`stays running on an unrelated key (${label})`, async () => {
      expect(await quitsOn(kitty, (m) => m.pressKey("a"))).toBe(false);
    });
  }
});

import { describe, expect, test } from "bun:test";
import type { CliRenderer } from "@opentui/core";
import { createTestRenderer, type MockInput } from "@opentui/core/testing";
import { Effect, Fiber, Layer, Option } from "effect";
import {
  type InputMode,
  InputRouter,
  InputRouterLive,
  isQuitForMode,
} from "../src/services/input-router.ts";
import { Renderer } from "../src/services/renderer.ts";

describe("isQuitForMode", () => {
  const modes: InputMode[] = ["Normal", "Filter", "Focus", "Modal"];

  test("Ctrl+C quits in every mode", () => {
    for (const mode of modes) {
      expect(isQuitForMode({ name: "c", ctrl: true }, mode)).toBe(true);
    }
  });

  test("bare q quits only in Normal and Focus", () => {
    expect(isQuitForMode({ name: "q", ctrl: false }, "Normal")).toBe(true);
    expect(isQuitForMode({ name: "q", ctrl: false }, "Focus")).toBe(true);
    expect(isQuitForMode({ name: "q", ctrl: false }, "Filter")).toBe(false);
    expect(isQuitForMode({ name: "q", ctrl: false }, "Modal")).toBe(false);
  });

  test("unrelated keys never quit", () => {
    for (const mode of modes) {
      expect(isQuitForMode({ name: "j", ctrl: false }, mode)).toBe(false);
      expect(isQuitForMode({ name: "c", ctrl: false }, mode)).toBe(false);
    }
  });
});

/**
 * Run `fn` against a live InputRouter wired to a real test renderer (one keypress
 * subscription, parsed through the renderer like production). `kittyKeyboard`
 * toggles the encoding so quit is covered on both the bare-byte and CSI-u paths.
 */
const withRouter = async <A>(
  kittyKeyboard: boolean,
  fn: (
    router: InputRouter["Type"],
    mockInput: MockInput,
    renderer: CliRenderer,
  ) => Effect.Effect<A>,
): Promise<A> => {
  const { renderer, mockInput } = await createTestRenderer({
    width: 40,
    height: 8,
    kittyKeyboard,
  });
  try {
    return await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const router = yield* InputRouter;
          return yield* fn(router, mockInput, renderer);
        }).pipe(
          Effect.provide(
            InputRouterLive.pipe(
              Layer.provide(Layer.succeed(Renderer, renderer)),
            ),
          ),
        ),
      ),
    );
  } finally {
    renderer.destroy();
  }
};

/** Press a key in `mode` and report whether the router's quit signal completed. */
const quitsInMode = (
  kitty: boolean,
  mode: InputMode,
  press: (input: MockInput) => void,
): Promise<boolean> =>
  withRouter(kitty, (router, mockInput) =>
    Effect.gen(function* () {
      yield* router.setMode(mode);
      const fiber = yield* Effect.fork(router.awaitQuit);
      yield* Effect.sleep("10 millis");
      yield* Effect.sync(() => press(mockInput));
      const result = yield* Fiber.join(fiber).pipe(
        Effect.timeoutOption("200 millis"),
      );
      if (Option.isNone(result)) yield* Fiber.interrupt(fiber);
      return Option.isSome(result);
    }),
  );

describe("InputRouter quit signal (real key parsing)", () => {
  for (const kitty of [false, true]) {
    const label = kitty ? "kitty protocol" : "legacy bytes";

    test(`Ctrl+C quits from Normal (${label})`, async () => {
      expect(await quitsInMode(kitty, "Normal", (m) => m.pressCtrlC())).toBe(true);
    });

    test(`Ctrl+C quits even from Filter (${label})`, async () => {
      expect(await quitsInMode(kitty, "Filter", (m) => m.pressCtrlC())).toBe(true);
    });

    test(`bare q quits from Normal (${label})`, async () => {
      expect(await quitsInMode(kitty, "Normal", (m) => m.pressKey("q"))).toBe(true);
    });
  }

  test("bare q does NOT quit in Filter mode (q is literal there)", async () => {
    expect(await quitsInMode(false, "Filter", (m) => m.pressKey("q"))).toBe(false);
  });

  test("bare q does NOT quit in Modal mode", async () => {
    expect(await quitsInMode(false, "Modal", (m) => m.pressKey("q"))).toBe(false);
  });
});

describe("InputRouter dispatch", () => {
  test("routes a non-quit key to the active mode's handler", async () => {
    const seen = await withRouter(false, (router, mockInput) =>
      Effect.gen(function* () {
        // Boxed so control-flow analysis doesn't narrow the callback write away.
        const box: { pressed: string | null } = { pressed: null };
        yield* router.register("Normal", (key) =>
          Effect.sync(() => {
            box.pressed = key.name;
          }),
        );
        yield* Effect.sleep("10 millis");
        yield* Effect.sync(() => mockInput.pressKey("j"));
        yield* Effect.sleep("10 millis");
        return box.pressed;
      }),
    );
    expect(seen).toBe("j");
  });

  test("dispatches to the handler for the active mode only", async () => {
    const counts = await withRouter(false, (router, mockInput) =>
      Effect.gen(function* () {
        let normal = 0;
        let filter = 0;
        yield* router.register("Normal", () => Effect.sync(() => normal++));
        yield* router.register("Filter", () => Effect.sync(() => filter++));
        yield* router.setMode("Filter");
        yield* Effect.sleep("10 millis");
        yield* Effect.sync(() => mockInput.pressKey("j"));
        yield* Effect.sleep("10 millis");
        return { normal, filter };
      }),
    );
    expect(counts).toEqual({ normal: 0, filter: 1 });
  });

  // The interactive-redraw contract: an input-driven change repaints immediately,
  // with no data tick — proven by the handler triggering requestRender on keypress.
  test("an input handler repaints immediately (no data tick)", async () => {
    const renders = await withRouter(false, (router, mockInput, renderer) =>
      Effect.gen(function* () {
        let count = 0;
        const original = renderer.requestRender.bind(renderer);
        renderer.requestRender = () => {
          count++;
          original();
        };
        yield* router.register("Normal", () =>
          Effect.sync(() => renderer.requestRender()),
        );
        yield* Effect.sleep("10 millis");
        yield* Effect.sync(() => mockInput.pressKey("j"));
        yield* Effect.sleep("10 millis");
        return count;
      }),
    );
    expect(renders).toBeGreaterThan(0);
  });
});

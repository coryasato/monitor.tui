import { Data } from "effect";

/**
 * Error taxonomy for monitor.tui. All errors are typed `Data.TaggedError`s so
 * they can be recovered at boundaries with `Effect.catchTag`.
 *
 * Three categories, per the project error contract:
 * - {@link CollectorError} — recoverable; the affected metric shows
 *   "unavailable" while other collectors keep running.
 * - {@link ConfigError} — fatal at startup; the app exits with a clear message.
 * - {@link RenderError} — logged to a debug pane; the TUI degrades gracefully
 *   and never crashes.
 */

/**
 * A recoverable failure inside a metric collector (e.g. a shell command failed,
 * or its output didn't match the expected schema). `collector` identifies which
 * collector produced it so recovery can be scoped per-source.
 */
export class CollectorError extends Data.TaggedError("CollectorError")<{
  readonly collector: string;
  readonly reason: string;
  readonly cause?: unknown;
}> {}

/**
 * A fatal configuration failure detected at startup (missing/invalid config
 * file or CLI flags). Surfaced to the user; the app then exits.
 */
export class ConfigError extends Data.TaggedError("ConfigError")<{
  readonly reason: string;
  readonly cause?: unknown;
}> {}

/**
 * A non-fatal rendering failure in a UI component. Logged to a debug line; the
 * render loop continues so a single bad component never takes down the TUI.
 */
export class RenderError extends Data.TaggedError("RenderError")<{
  readonly component: string;
  readonly reason: string;
  readonly cause?: unknown;
}> {}

/** Any error originating from a collector boundary. Grows as collectors are added. */
export type AppError = CollectorError | ConfigError | RenderError;

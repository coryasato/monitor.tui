import { Context, Effect, Layer } from "effect";
import * as v from "valibot";
import { type AppConfig, defaultConfig } from "../types/config.ts";
import { ConfigError } from "../types/errors.ts";

/**
 * Config service: holds the resolved {@link AppConfig}. Loaded via {@link ConfigLive}
 * from defaults < config file < CLI flags, validated with Valibot at the boundary.
 * Pure helpers (`parseArgs`, `mergeConfig`) and the Effect loader (`loadConfigFrom`)
 * are exported for testing.
 */
export class Config extends Context.Tag("Config")<Config, AppConfig>() {}

/** Default config file path (relative to cwd), used when `--config` is absent. */
export const DEFAULT_CONFIG_PATH = "monitor.config.json";

// --- CLI parsing -----------------------------------------------------------

export interface CliOverrides {
  configPath?: string;
  refreshMs?: number;
  cpu?: { enabled?: boolean };
  memory?: { enabled?: boolean };
  sparklineWidth?: number;
}

/**
 * Parse CLI args into overrides. Numeric flags are coerced with `Number` (a bad
 * value becomes `NaN` and is rejected later by the schema). Unrecognized args are
 * returned in `unknown` so the loader can fail with a clear `ConfigError`.
 */
export const parseArgs = (
  argv: ReadonlyArray<string>,
): { overrides: CliOverrides; unknown: string[] } => {
  const overrides: CliOverrides = {};
  const unknown: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--config":
        overrides.configPath = argv[++i];
        break;
      case "--refresh":
        overrides.refreshMs = Number(argv[++i]);
        break;
      case "--sparkline-width":
        overrides.sparklineWidth = Number(argv[++i]);
        break;
      case "--cpu":
        overrides.cpu = { enabled: true };
        break;
      case "--no-cpu":
        overrides.cpu = { enabled: false };
        break;
      case "--memory":
        overrides.memory = { enabled: true };
        break;
      case "--no-memory":
        overrides.memory = { enabled: false };
        break;
      default:
        unknown.push(arg);
    }
  }
  return { overrides, unknown };
};

// --- Schemas ---------------------------------------------------------------

/** Config-file schema: every field optional; unknown keys ignored. */
const FileConfigSchema = v.object({
  refreshMs: v.optional(v.number()),
  cpu: v.optional(v.object({ enabled: v.optional(v.boolean()) })),
  memory: v.optional(v.object({ enabled: v.optional(v.boolean()) })),
  sparkline: v.optional(v.object({ width: v.optional(v.number()) })),
});
type FileConfig = v.InferOutput<typeof FileConfigSchema>;

/** Final schema with real ranges; failure here is a fatal `ConfigError`. */
const AppConfigSchema = v.object({
  refreshMs: v.pipe(v.number(), v.integer(), v.minValue(50), v.maxValue(10_000)),
  cpu: v.object({ enabled: v.boolean() }),
  memory: v.object({ enabled: v.boolean() }),
  sparkline: v.object({
    width: v.pipe(v.number(), v.integer(), v.minValue(4), v.maxValue(200)),
  }),
});

// --- Merge -----------------------------------------------------------------

/** Resolve precedence: defaults < file < CLI. `??` keeps `NaN` so it fails validation. */
export const mergeConfig = (
  base: AppConfig,
  file: FileConfig,
  cli: CliOverrides,
): AppConfig => ({
  refreshMs: cli.refreshMs ?? file.refreshMs ?? base.refreshMs,
  cpu: { enabled: cli.cpu?.enabled ?? file.cpu?.enabled ?? base.cpu.enabled },
  memory: {
    enabled: cli.memory?.enabled ?? file.memory?.enabled ?? base.memory.enabled,
  },
  sparkline: {
    width: cli.sparklineWidth ?? file.sparkline?.width ?? base.sparkline.width,
  },
});

// --- Loader ----------------------------------------------------------------

/** Read + validate the config file. Missing default file → no overrides; a missing
 * explicit `--config` path or any parse/validation failure → `ConfigError`. */
const loadFile = (
  explicitPath: string | undefined,
): Effect.Effect<FileConfig, ConfigError> =>
  Effect.gen(function* () {
    const path = explicitPath ?? DEFAULT_CONFIG_PATH;
    const exists = yield* Effect.promise(() => Bun.file(path).exists());
    if (!exists) {
      if (explicitPath !== undefined) {
        return yield* new ConfigError({
          reason: `config file not found: ${explicitPath}`,
        });
      }
      return {};
    }
    const text = yield* Effect.tryPromise({
      try: () => Bun.file(path).text(),
      catch: (cause) =>
        new ConfigError({ reason: `could not read config file: ${path}`, cause }),
    });
    const json = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: (cause) =>
        new ConfigError({
          reason: `config file is not valid JSON: ${path}`,
          cause,
        }),
    });
    const result = v.safeParse(FileConfigSchema, json);
    if (!result.success) {
      return yield* new ConfigError({
        reason: `config file failed validation (${path}): ${v.summarize(result.issues)}`,
        cause: result.issues,
      });
    }
    return result.output;
  });

/**
 * Resolve the full config from CLI args (defaults < file < flags), validating the
 * result. Takes `argv` explicitly so it is testable without touching `process`.
 */
export const loadConfigFrom = (
  argv: ReadonlyArray<string>,
): Effect.Effect<AppConfig, ConfigError> =>
  Effect.gen(function* () {
    const { overrides, unknown } = parseArgs(argv);
    if (unknown.length > 0) {
      return yield* new ConfigError({
        reason: `unknown CLI argument(s): ${unknown.join(", ")}`,
      });
    }
    const fileConfig = yield* loadFile(overrides.configPath);
    const merged = mergeConfig(defaultConfig, fileConfig, overrides);
    const result = v.safeParse(AppConfigSchema, merged);
    if (!result.success) {
      return yield* new ConfigError({
        reason: `invalid configuration: ${v.summarize(result.issues)}`,
        cause: result.issues,
      });
    }
    return result.output;
  });

/** Live config, loaded from the process command-line arguments. */
export const ConfigLive = Layer.effect(
  Config,
  loadConfigFrom(process.argv.slice(2)),
);

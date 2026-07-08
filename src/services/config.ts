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

/** Default cap on the launched process's captured stderr ring buffer (lines). */
export const DEFAULT_STDERR_LINES = 200;

// --- CLI parsing -----------------------------------------------------------

export interface CliOverrides {
  configPath?: string;
  refreshMs?: number;
  cpu?: { enabled?: boolean };
  cpuCores?: { enabled?: boolean };
  memory?: { enabled?: boolean };
  network?: { enabled?: boolean };
  disk?: { enabled?: boolean };
  process?: { enabled?: boolean };
  sparklineWidth?: number;
  /** `--notify`/`--no-notify`; unset means "use file/default". Thresholds themselves are file-only (see `AppConfig.alerts`), matching `launch.stderrLines`. */
  notify?: boolean;
  /** The command after `--` (everything following it, verbatim). Empty = `--` with no command. */
  launchCommand?: ReadonlyArray<string>;
  /** `--no-kill-on-exit` sets `false`; unset means "use file/default". */
  killOnExit?: boolean;
}

/**
 * Parse CLI args into overrides. Numeric flags are coerced with `Number` (a bad
 * value becomes `NaN` and is rejected later by the schema). Unrecognized args are
 * returned in `unknown` so the loader can fail with a clear `ConfigError`.
 *
 * The command to run under the monitor (`monitor -- <command…>`) is everything
 * after a `--`, OR everything from the first bare positional token (one not
 * starting with `-`) onward. Supporting the bare form matters because Bun strips
 * a leading `--` before the script sees it (`bun main.ts -- sleep 2` arrives as
 * `["sleep","2"]`), and it also lets `monitor sleep 2` work without the `--`. The
 * command's own flags are never mistaken for the monitor's — collection stops
 * flag parsing entirely. Unknown `-`/`--`-prefixed tokens still error.
 */
export const parseArgs = (
  argv: ReadonlyArray<string>,
): { overrides: CliOverrides; unknown: string[] } => {
  const overrides: CliOverrides = {};
  const unknown: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      // Everything after `--` is the launched command + its args, verbatim.
      overrides.launchCommand = argv.slice(i + 1);
      break;
    }
    if (!arg.startsWith("-")) {
      // A bare positional starts the command (Bun ate our `--`, or none given).
      overrides.launchCommand = argv.slice(i);
      break;
    }
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
      case "--cpu-cores":
        overrides.cpuCores = { enabled: true };
        break;
      case "--no-cpu-cores":
        overrides.cpuCores = { enabled: false };
        break;
      case "--memory":
        overrides.memory = { enabled: true };
        break;
      case "--no-memory":
        overrides.memory = { enabled: false };
        break;
      case "--network":
        overrides.network = { enabled: true };
        break;
      case "--no-network":
        overrides.network = { enabled: false };
        break;
      case "--disk":
        overrides.disk = { enabled: true };
        break;
      case "--no-disk":
        overrides.disk = { enabled: false };
        break;
      case "--process":
        overrides.process = { enabled: true };
        break;
      case "--no-process":
        overrides.process = { enabled: false };
        break;
      case "--notify":
        overrides.notify = true;
        break;
      case "--no-notify":
        overrides.notify = false;
        break;
      case "--kill-on-exit":
        overrides.killOnExit = true;
        break;
      case "--no-kill-on-exit":
        overrides.killOnExit = false;
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
  cpuCores: v.optional(v.object({ enabled: v.optional(v.boolean()) })),
  memory: v.optional(v.object({ enabled: v.optional(v.boolean()) })),
  network: v.optional(v.object({ enabled: v.optional(v.boolean()) })),
  disk: v.optional(v.object({ enabled: v.optional(v.boolean()) })),
  process: v.optional(v.object({ enabled: v.optional(v.boolean()) })),
  sparkline: v.optional(v.object({ width: v.optional(v.number()) })),
  // Thresholds are file-only (no CLI flags — six numbers is too many); `notify`
  // also has a CLI override (`--notify`/`--no-notify`), read separately below.
  alerts: v.optional(
    v.object({
      cpu: v.optional(
        v.object({ warn: v.optional(v.number()), critical: v.optional(v.number()) }),
      ),
      memory: v.optional(
        v.object({ warn: v.optional(v.number()), critical: v.optional(v.number()) }),
      ),
      disk: v.optional(
        v.object({ warn: v.optional(v.number()), critical: v.optional(v.number()) }),
      ),
      notify: v.optional(v.boolean()),
    }),
  ),
  // The command itself only comes from the CLI (after `--`); the file may set the
  // launch *defaults* (kill behavior + stderr buffer size) for when one is given.
  launch: v.optional(
    v.object({
      killOnExit: v.optional(v.boolean()),
      stderrLines: v.optional(v.number()),
    }),
  ),
});
type FileConfig = v.InferOutput<typeof FileConfigSchema>;

/** A warn/critical pair, `warn <= critical`, values in `[0, max]`. */
const thresholdPair = (max: number) =>
  v.pipe(
    v.object({
      warn: v.pipe(v.number(), v.minValue(0), v.maxValue(max)),
      critical: v.pipe(v.number(), v.minValue(0), v.maxValue(max)),
    }),
    v.check((t) => t.warn <= t.critical, "warn must be <= critical"),
  );

/** Final schema with real ranges; failure here is a fatal `ConfigError`. */
const AppConfigSchema = v.object({
  refreshMs: v.pipe(v.number(), v.integer(), v.minValue(50), v.maxValue(10_000)),
  cpu: v.object({ enabled: v.boolean() }),
  cpuCores: v.object({ enabled: v.boolean() }),
  memory: v.object({ enabled: v.boolean() }),
  network: v.object({ enabled: v.boolean() }),
  disk: v.object({ enabled: v.boolean() }),
  process: v.object({ enabled: v.boolean() }),
  sparkline: v.object({
    width: v.pipe(v.number(), v.integer(), v.minValue(4), v.maxValue(200)),
  }),
  alerts: v.object({
    cpu: thresholdPair(100),
    memory: thresholdPair(100),
    // MB/s throughput, not a percentage — no natural upper ceiling.
    disk: thresholdPair(Number.MAX_SAFE_INTEGER),
    notify: v.boolean(),
  }),
  launch: v.nullable(
    v.object({
      command: v.pipe(v.array(v.string()), v.minLength(1)),
      killOnExit: v.boolean(),
      stderrLines: v.pipe(
        v.number(),
        v.integer(),
        v.minValue(1),
        v.maxValue(100_000),
      ),
    }),
  ),
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
  cpuCores: {
    enabled:
      cli.cpuCores?.enabled ?? file.cpuCores?.enabled ?? base.cpuCores.enabled,
  },
  memory: {
    enabled: cli.memory?.enabled ?? file.memory?.enabled ?? base.memory.enabled,
  },
  network: {
    enabled:
      cli.network?.enabled ?? file.network?.enabled ?? base.network.enabled,
  },
  disk: {
    enabled: cli.disk?.enabled ?? file.disk?.enabled ?? base.disk.enabled,
  },
  process: {
    enabled:
      cli.process?.enabled ?? file.process?.enabled ?? base.process.enabled,
  },
  sparkline: {
    width: cli.sparklineWidth ?? file.sparkline?.width ?? base.sparkline.width,
  },
  alerts: {
    cpu: {
      warn: file.alerts?.cpu?.warn ?? base.alerts.cpu.warn,
      critical: file.alerts?.cpu?.critical ?? base.alerts.cpu.critical,
    },
    memory: {
      warn: file.alerts?.memory?.warn ?? base.alerts.memory.warn,
      critical: file.alerts?.memory?.critical ?? base.alerts.memory.critical,
    },
    disk: {
      warn: file.alerts?.disk?.warn ?? base.alerts.disk.warn,
      critical: file.alerts?.disk?.critical ?? base.alerts.disk.critical,
    },
    notify: cli.notify ?? file.alerts?.notify ?? base.alerts.notify,
  },
  // A launch config exists only when a command was given after `--`; its kill
  // behavior and buffer size fall back through cli < file < defaults.
  launch:
    cli.launchCommand === undefined
      ? base.launch
      : {
          command: cli.launchCommand,
          killOnExit: cli.killOnExit ?? file.launch?.killOnExit ?? true,
          stderrLines: file.launch?.stderrLines ?? DEFAULT_STDERR_LINES,
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
    // `--` with nothing after it is a usage error, caught here for a clear message
    // (the schema's minLength would otherwise report an opaque validation failure).
    if (overrides.launchCommand !== undefined && overrides.launchCommand.length === 0) {
      return yield* new ConfigError({
        reason: "no command given after `--` (usage: monitor -- <command…>)",
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
    // Launching a command drives the focus view, which lives in the process panel.
    if (result.output.launch !== null && !result.output.process.enabled) {
      return yield* new ConfigError({
        reason: "launching a command requires the process panel (remove --no-process)",
      });
    }
    return result.output;
  });

/** Live config, loaded from the process command-line arguments. */
export const ConfigLive = Layer.effect(
  Config,
  loadConfigFrom(process.argv.slice(2)),
);

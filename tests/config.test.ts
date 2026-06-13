import { afterAll, describe, expect, test } from "bun:test";
import { Effect, Either } from "effect";
import {
  type CliOverrides,
  loadConfigFrom,
  mergeConfig,
  parseArgs,
} from "../src/services/config.ts";
import { type AppConfig, defaultConfig } from "../src/types/config.ts";

const tmpFiles: string[] = [];
const writeTmp = async (content: string): Promise<string> => {
  const path = `/tmp/monitor-config-${crypto.randomUUID()}.json`;
  await Bun.write(path, content);
  tmpFiles.push(path);
  return path;
};
afterAll(async () => {
  await Promise.all(tmpFiles.map((p) => Bun.file(p).delete().catch(() => {})));
});

/** Run the loader and return an Either (Right = config, Left = ConfigError). */
const load = (argv: string[]) =>
  Effect.runPromise(Effect.either(loadConfigFrom(argv)));

describe("parseArgs", () => {
  test("returns empty overrides for no args", () => {
    expect(parseArgs([])).toEqual({ overrides: {}, unknown: [] });
  });

  test("parses all known flags", () => {
    const { overrides, unknown } = parseArgs([
      "--config",
      "/x.json",
      "--refresh",
      "500",
      "--no-cpu",
      "--memory",
      "--sparkline-width",
      "20",
    ]);
    expect(unknown).toEqual([]);
    expect(overrides).toEqual({
      configPath: "/x.json",
      refreshMs: 500,
      cpu: { enabled: false },
      memory: { enabled: true },
      sparklineWidth: 20,
    });
  });

  test("distinguishes --cpu-cores from --cpu", () => {
    expect(parseArgs(["--no-cpu-cores"]).overrides).toEqual({
      cpuCores: { enabled: false },
    });
    // --cpu must not be swallowed by the cpu-cores cases.
    expect(parseArgs(["--cpu"]).overrides).toEqual({ cpu: { enabled: true } });
  });

  test("collects unrecognized args", () => {
    expect(parseArgs(["--bogus", "x"]).unknown).toEqual(["--bogus", "x"]);
  });
});

describe("mergeConfig", () => {
  test("precedence is defaults < file < cli", () => {
    const file = { refreshMs: 500, memory: { enabled: false } };
    const cli: CliOverrides = { refreshMs: 1000 };
    const merged = mergeConfig(defaultConfig, file, cli);
    expect(merged.refreshMs).toBe(1000); // cli wins over file
    expect(merged.memory.enabled).toBe(false); // file wins over default
    expect(merged.cpu.enabled).toBe(true); // default
    expect(merged.cpuCores.enabled).toBe(true); // default
    expect(merged.sparkline.width).toBe(defaultConfig.sparkline.width);
  });

  test("cli cpuCores flag overrides the default", () => {
    const merged = mergeConfig(defaultConfig, {}, { cpuCores: { enabled: false } });
    expect(merged.cpuCores.enabled).toBe(false);
  });
});

describe("loadConfigFrom", () => {
  test("returns defaults with no args and no default file", async () => {
    const result = await load([]);
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) expect(result.right).toEqual(defaultConfig);
  });

  test("loads and merges a valid config file", async () => {
    const path = await writeTmp(
      JSON.stringify({ refreshMs: 800, cpu: { enabled: false } }),
    );
    const result = await load(["--config", path, "--sparkline-width", "60"]);
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      const cfg: AppConfig = result.right;
      expect(cfg.refreshMs).toBe(800); // from file
      expect(cfg.cpu.enabled).toBe(false); // from file
      expect(cfg.sparkline.width).toBe(60); // cli overrides
    }
  });

  const expectConfigError = async (argv: string[], match: RegExp) => {
    const result = await load(argv);
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("ConfigError");
      expect(result.left.reason).toMatch(match);
    }
  };

  test("fails on an unknown CLI flag", () =>
    expectConfigError(["--nope"], /unknown CLI argument/));

  test("fails when an explicit --config path is missing", () =>
    expectConfigError(["--config", "/no/such/file.json"], /not found/));

  test("fails on malformed JSON", async () => {
    const path = await writeTmp("{ not json ");
    await expectConfigError(["--config", path], /not valid JSON/);
  });

  test("fails when a file value is out of range", async () => {
    const path = await writeTmp(JSON.stringify({ refreshMs: 5 })); // below min 50
    await expectConfigError(["--config", path], /invalid configuration/);
  });

  test("fails when a numeric flag is not a number", () =>
    expectConfigError(["--refresh", "abc"], /invalid configuration/));
});

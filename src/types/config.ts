/**
 * Application configuration. Resolved once at startup from defaults < config file
 * < CLI flags, then validated. Invalid config is a fatal `ConfigError` (the app
 * exits with a clear message before the TUI starts).
 */
export interface AppConfig {
  /** Render-tick interval in milliseconds (how often views are refreshed). */
  readonly refreshMs: number;
  /** CPU collector + gauge + history sparkline. */
  readonly cpu: { readonly enabled: boolean };
  /** Per-core CPU collector (Bun FFI) + bars. */
  readonly cpuCores: { readonly enabled: boolean };
  /** Memory collector + gauge. */
  readonly memory: { readonly enabled: boolean };
  /** Network collector + readout. */
  readonly network: { readonly enabled: boolean };
  /** Disk collector + readout. */
  readonly disk: { readonly enabled: boolean };
  /** Process collector + table (left pane). When disabled the layout is full-width widgets. */
  readonly process: { readonly enabled: boolean };
  /** CPU history sparkline width (number of samples shown). */
  readonly sparkline: { readonly width: number };
  /**
   * A command to launch under the monitor (`monitor -- <command…>`), or `null`
   * when only attaching to existing processes. When set, the child is spawned,
   * auto-pinned in the focus view, and its subtree resources are watched live.
   * `killOnExit` (default `true`, cleared by `--no-kill-on-exit`) kills the
   * child's process group when the monitor quits; `stderrLines` bounds the
   * captured stderr ring buffer feeding the exit report (Feature 5).
   */
  readonly launch: {
    readonly command: ReadonlyArray<string>;
    readonly killOnExit: boolean;
    readonly stderrLines: number;
  } | null;
}

/** Defaults used when no file/flags override them. */
export const defaultConfig: AppConfig = {
  refreshMs: 250,
  cpu: { enabled: true },
  cpuCores: { enabled: false },
  memory: { enabled: true },
  network: { enabled: true },
  disk: { enabled: true },
  process: { enabled: true },
  sparkline: { width: 40 },
  launch: null,
};

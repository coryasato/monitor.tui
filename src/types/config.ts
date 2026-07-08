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
   * High-watermark alert thresholds. CPU/memory are `usedPercent` in [0,100];
   * disk is combined I/O throughput in MB/s (binary MiB, matching
   * `formatRate`) since disk has no natural 0–100 ceiling to threshold a
   * percentage against. `notify` fires a best-effort OS notification
   * (`osascript`/`notify-send`) once per crossing into `critical`. Network is
   * excluded entirely — same "no natural ceiling" reasoning as disk's rate.
   */
  readonly alerts: {
    readonly cpu: { readonly warn: number; readonly critical: number };
    readonly memory: { readonly warn: number; readonly critical: number };
    readonly disk: { readonly warn: number; readonly critical: number };
    readonly notify: boolean;
  };
  /**
   * A command to launch under the monitor (`monitor -- <command…>`), or `null`
   * when only attaching to existing processes. When set, the child is spawned,
   * auto-pinned in the focus view, and its subtree resources are watched live.
   * `killOnExit` (default `true`, cleared by `--no-kill-on-exit`) kills the
   * child's process group when the monitor quits; `stderrLines` bounds the
   * captured stderr ring buffer feeding the exit report.
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
  alerts: {
    cpu: { warn: 75, critical: 90 },
    memory: { warn: 80, critical: 95 },
    disk: { warn: 80, critical: 95 },
    notify: false,
  },
  launch: null,
};

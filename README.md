# monitor.tui

A production-grade, real-time TUI dashboard for system and container observability — inspired by htop and glances, built with TypeScript, Effect.ts, and OpenTUI.

## Goals

- **System observability**: CPU, memory, disk, network, processes, Docker containers
- **TypeScript mastery**: strict types, branded types, discriminated unions throughout
- **Effect.ts**: services/layers, streams, typed errors, fiber-based concurrency
- **OpenTUI**: high-performance terminal rendering with React reconciler

## Tech Stack

| Layer | Tool |
|---|---|
| Language | TypeScript (strict) |
| Runtime | Bun |
| TUI | `@opentui/core` + `@opentui/react` |
| Effects | Effect.ts |
| Validation | Valibot (external data boundaries) |
| Remote (planned) | `@effect/platform` HTTP/WS |

## Getting Started

```bash
bun install
bun index.ts
```

Press `Ctrl+C` to exit.

## Project Structure

```
/src
  /services     # Effect Context + Layer definitions
  /collectors   # Metric implementations (cpu, mem, disk, docker, proc)
  /ui
    /components # Reusable OpenTUI widgets
    /views      # Full screen layouts
  /app          # BunRuntime entrypoint, config loading, layer composition
  /types        # Branded types, discriminated unions, schemas
/tests
```

## Architecture

Collectors run as independent Effect fibers and push `MetricSnapshot` values into a central `MetricsStore`. UI components subscribe to individual streams via `Stream.changes` to minimize redraws.

```
Collector Fiber → Stream<MetricSnapshot> → MetricsStore (Ref) → UI subscription
```

**Error handling** follows three categories:
- `CollectorError<Tag>` — recoverable; affected metric shows "unavailable", others continue
- `ConfigError` — fatal at startup with a clear message
- `RenderError` — logged to a debug pane; TUI degrades gracefully

## Development

```bash
bun test          # run tests
bun run typecheck # tsc --noEmit
```

## References

- [OpenTUI Docs](https://opentui.com/docs/getting-started/)
- [Effect.ts Docs](https://effect.website)
- [Effect Patterns](https://github.com/PaulJPhilp/EffectPatterns)

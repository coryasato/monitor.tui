# Project: monitor.tui - System Observability Dashboard

## Overview

Build a production-grade, daily-usable real-time TUI dashboard (htop/glances-inspired but richer) for system + container observability.
Primary goals:
- Deep TypeScript mastery (strict types, performance, architecture)
- Master Effect.ts for robust concurrency, resource management, error handling, and streaming
- Learn OpenTUI (React/Solid/vanilla) for high-performance terminal UIs
- Create something genuinely useful that runs locally or remotely

## Tech Stack

- **Language**: TypeScript (strict mode, `tsc --noEmit` + runtime checks)
- **TUI**: `@opentui/core` + `@opentui/react` (React reconciler)
- **Effects & Runtime**: Effect.ts (latest) — everything async/resource-heavy must use Effect
- **Bundler/Runtime**: Bun
- **Schemas**: Valibot for config file validation and external data boundaries (procfs output, Docker API responses). Not used as a general type system — internal types use TypeScript directly.
- **Remote (optional)**: `@effect/platform` for HTTP/WS if adding remote agent/dashboard features

## Project Goals & Learning Focus

- Practice **strong typing**: Metrics schemas, discriminated unions for widgets/states, branded types.
- Master **Effect.ts**:
  - Services + Layers for dependency injection (procfs, Docker, Prometheus, etc.)
  - Streams for real-time metrics/logs
  - `acquireRelease` for resources
  - Fibers/concurrency for independent collectors
  - Typed errors + recovery/graceful degradation
- OpenTUI best practices: Efficient re-renders, canvas-like drawing for graphs, responsive layouts.
- Performance: Minimize redraws, handle high-frequency updates smoothly.

## Error Taxonomy

All errors are typed and handled explicitly. Three categories:

- `CollectorError<Tag>` — recoverable; the affected metric shows "unavailable" while others continue
- `ConfigError` — fatal at startup; app exits with a clear message
- `RenderError` — logged to a debug pane; TUI degrades gracefully, never crashes

No `unknown` or untyped throws in Effect pipelines. Use `Effect.catchTag` for recovery at collector boundaries.

## Metrics Data Flow

Collectors push into a central `MetricsStore` — a `Ref`-backed map of `Stream<MetricSnapshot>` keyed by collector tag. UI components subscribe to individual streams via `Stream.changes` to minimize redraws. No direct fiber-to-component wiring.

```
Collector Fiber → Stream<MetricSnapshot> → MetricsStore (Ref) → UI component subscription
```

- Collectors own their polling interval and error recovery
- `MetricSnapshot` is an immutable value type (no shared mutable state)
- UI reads are always pull-based (on render tick), never push-based

## Architecture Principles

- **Layered**: Core services (Effect Layers) → Data models → UI components → App root.
- All side effects in Effect. Pure functions where possible.
- Prefer composition over inheritance.
- Feature flags/config-driven widgets and data sources.
- Modular: Easy to add new metric sources or visualization widgets.

## File Structure (suggested)

/src
  /services     # Effect Context + Layer definitions (the interfaces)
  /collectors   # Metric implementations (cpu, mem, disk, docker, proc)
  /ui
    /components # Reusable OpenTUI widgets
    /views      # Full screen layouts
  /app          # BunRuntime entrypoint, config loading, layer composition
  /types        # Shared branded types, discriminated unions, schemas
/tests

## Coding Standards

- **TypeScript**: `strict: true`, no `any`, prefer interfaces for external, types for internal. Use branded types and discriminated unions heavily.
- **Effect.ts**:
  - Use `Effect.gen` or `pipe` consistently.
  - Services via `Context` + Layers.
  - Never use raw promises/async-await for core logic — wrap in Effect.
  - Handle errors explicitly (no fire-and-forget).
- **OpenTUI**: Follow component patterns from docs/examples. Prefer declarative (React) for complex UIs.
- Naming: `kebab-case` for files, `PascalCase` for components, descriptive names.
- JSDoc: JSDoc only for Effect service interfaces and public Layer constructors.
- Tests: Focus on unit testing services and pure logic first.

## Critical Rules

- Never block the main TUI loop.
- All polling/streaming must be cancellable and resource-managed.
- Graceful degradation on partial failures (e.g., one collector dies, others continue).
- Configurable via file + CLI flags (use Effect for config loading).
- Performance > prettiness initially.

## Commands (Default to using Bun instead of Node.js.)

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## Key References

- OpenTUI Docs: https://opentui.com/docs/getting-started/
- OpenTUI GitHub: https://github.com/anomalyco/opentui
- Effect.ts Docs: https://effect.website
- Effect Patterns: https://github.com/PaulJPhilp/EffectPatterns

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

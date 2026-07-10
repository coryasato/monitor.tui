# PLAN.md — monitor.tui

## Context

Greenfield system/container observability TUI. This is a **learning project**: the
goal is to internalize Effect.ts (Services, Layers, Streams, typed errors, fibers)
and OpenTUI while building something genuinely useful. Architecture correctness
matters more than feature breadth, so we move in **small, milestone-gated phases**,
starting with a single CPU collector and growing the pattern outward.

Key constraints:
- **macOS has no `/proc`.** CLAUDE.md's procfs design can't run here. We abstract
  collection behind a Service interface and ship a **macOS Layer** now; a Linux
  Layer drops in later with no call-site changes.
- **UI:** vanilla `@opentui/core` (reuse the pattern in `index.ts`); React deferred.
- **Docker isn't running** → container observability is a late phase.

Locked decisions: *abstract now / macOS only*, *vanilla OpenTUI*, *full Service +
Layer + Stream from Phase 1*.

Process-feature decisions (from review): *per-process data via libproc Bun FFI*
(not `top` parsing), *launched commands aggregate the process subtree*, *launched
children are killed on monitor quit by default* (`--no-kill-on-exit` to detach).

---

## Status

**Features 0–6 are complete.** Implementation seams, gotchas, and the
per-feature shipped history live in `ARCHITECTURE.md` — read it before
starting a Backlog item that touches the process table, input routing, the
redraw contract, focus/launch/exit flow, or alerts.

---

## Backlog — Next Planning

Pick an item, flesh it out into a spec (see `ARCHITECTURE.md`'s Feature 0–6
write-ups for the level of detail expected — goal, concrete file/type
changes, milestone), then promote it into its own `###` section here when
ready to build.

- Resizable split panes (left/right via keyboard or drag)
- Widget pin/unpin with persisted layout state (written to config file — builds on existing `AppConfig` pipeline)
- Redesigned widget visuals (better gauges, richer sparklines, borders/headers)
- Theming / color scheme config

---

## Verification

**Every feature:** `bun run typecheck` (`tsc --noEmit`) and `bun test` stay green.

**Interactive features** (process table, focus, search, modals): simulate parsed
keypresses into `renderer.keyInput` via `@opentui/core/testing`'s
`createTestRenderer`; unit-test `InputRouter` mode transitions, `resolveAlert`, and
the subtree/parse/diff helpers as pure functions.

**TUI smoke test (needs a real PTY).** Piping the TUI to a non-TTY shows only the
first frame, so drive it through a pty and capture the output:

```sh
script -q /tmp/tui.out timeout -s INT --preserve-status 10 bun src/app/main.ts >/dev/null 2>/tmp/tui.err
# then assert against /tmp/tui.out (rendered frames) and /tmp/tui.err (should be empty)
```

After it exits, confirm no collector subprocess was orphaned by interruption:

```sh
pgrep -fl "top -l 2|vm_stat|hw.memsize|netstat -ib|iostat" || echo "NONE — clean"
```

**Quitting:** press `q` or Ctrl+C for a clean shutdown (renderer destroyed,
fibers interrupted). The harness `timeout -s INT` above also exits cleanly via
BunRuntime's signal handling.

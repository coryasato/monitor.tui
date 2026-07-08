import { describe, expect, test } from "bun:test";
import { escapeAppleScript } from "../src/services/notify.ts";

// `sendNotification` itself isn't unit tested here — unlike `launchProcess`'s
// `true`/`sleep` children, actually invoking `osascript`/`notify-send` pops a
// real, user-visible OS notification on every test run. Only the pure escaping
// (the part that keeps arbitrary alert text from breaking the AppleScript
// literal it's embedded in) is covered.
describe("escapeAppleScript", () => {
  test("passes plain text through unchanged", () => {
    expect(escapeAppleScript("CPU crossed into critical")).toBe(
      "CPU crossed into critical",
    );
  });

  test("escapes double quotes", () => {
    expect(escapeAppleScript('say "hi"')).toBe('say \\"hi\\"');
  });

  test("escapes backslashes before quotes so escaping doesn't double up", () => {
    expect(escapeAppleScript("C:\\path")).toBe("C:\\\\path");
    expect(escapeAppleScript('\\"')).toBe('\\\\\\"');
  });
});

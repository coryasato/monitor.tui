import { createCliRenderer, Box, Text, TextRenderable } from "@opentui/core";

const renderer = await createCliRenderer({
  exitOnCtrlC: true,
  targetFps: 30,
  screenMode: "split-footer",
  externalOutputMode: "capture-stdout",
  consoleMode: "disabled",
});

renderer.root.add(
  Box(
    { borderStyle: "rounded", padding: 1, flexDirection: "column", gap: 1 },
    Text({ content: "Welcome", fg: "#FFFF00" }),
    Text({ content: "Press Ctrl+C to exit" }),
  ),
);

renderer.writeToScrollback((ctx) => {
  const root = new TextRenderable(ctx.renderContext, {
    id: "api-response",
    position: "absolute",
    left: 0,
    top: 0,
    width: ctx.width,
    height: 1,
    content: "api responded in 12ms",
    fg: "#8BD5CA",
  });

  return {
    root,
    width: ctx.width,
    height: 1,
    startOnNewLine: true,
    trailingNewline: true,
  };
});
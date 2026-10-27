// Bundles each extension entry point into dist/ and copies the static files beside them.
// dist/ is the folder you load in chrome://extensions.
import { build, context } from "esbuild";
import { cp, rm } from "node:fs/promises";

const watch = process.argv.includes("--watch");

const common = {
  outdir: "dist",
  bundle: true,
  // 116 is the first version with chrome.sidePanel.setPanelBehavior, which we rely on.
  target: "chrome116",
  sourcemap: true,
  logLevel: "info",
};

const configs = [
  {
    ...common,
    entryPoints: {
      background: "src/background.ts",
      options: "src/options.ts",
      sidepanel: "src/sidepanel.ts",
    },
    // Chrome loads the service worker as an ES module (see manifest "type": "module"),
    // and the pages load their scripts with <script type="module">.
    format: "esm",
  },
  {
    ...common,
    entryPoints: { content: "src/content.ts" },
    // executeScript runs files as classic scripts, and every injection into a page shares
    // one global scope. Wrapping the bundle in a function keeps its top-level names out of
    // that scope, so injecting it a second time doesn't throw "already declared".
    format: "iife",
  },
];

await rm("dist", { recursive: true, force: true });
await cp("static", "dist", { recursive: true });

if (watch) {
  for (const config of configs) await (await context(config)).watch();
} else {
  await Promise.all(configs.map((config) => build(config)));
}

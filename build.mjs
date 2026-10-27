// Bundles each extension entry point into dist/ and copies the static files beside them.
// dist/ is the folder you load in chrome://extensions.
import { build, context } from "esbuild";
import { cp, rm } from "node:fs/promises";

const watch = process.argv.includes("--watch");

const options = {
  entryPoints: {
    background: "src/background.ts",
    options: "src/options.ts",
    sidepanel: "src/sidepanel.ts",
  },
  outdir: "dist",
  bundle: true,
  // Chrome loads the service worker as an ES module (see manifest "type": "module").
  format: "esm",
  // 116 is the first version with chrome.sidePanel.setPanelBehavior, which we rely on.
  target: "chrome116",
  sourcemap: true,
  logLevel: "info",
};

await rm("dist", { recursive: true, force: true });
await cp("static", "dist", { recursive: true });

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}

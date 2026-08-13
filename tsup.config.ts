import { defineConfig } from "tsup";
import type { Plugin } from "esbuild";

// ink conditionally imports react-devtools-core (only when DEV=true).
// esbuild inlines the dynamic import, turning the static import inside devtools.js
// into a top-level require — which then fails at runtime because the package
// is a peerDep and not installed. Stub it with a no-op so the bundle is self-contained.
const stubReactDevtools: Plugin = {
  name: "stub-react-devtools-core",
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
      path: "react-devtools-core",
      namespace: "stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: "export default { initialize() {}, connectToDevTools() {} }",
      loader: "js",
    }));
  },
};

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  splitting: false,
  sourcemap: true,
  // Bundle react + ink + their internal deps so there is exactly one React
  // instance in the process. Without this, Windows Node 20 loads React twice
  // (ESM cache key vs CJS require cache key differ), breaking hook dispatch.
  noExternal: ["react", "ink", "ink-text-input"],
  esbuildPlugins: [stubReactDevtools],
  shims: true,
  banner: {
    // createRequire must be declared before esbuild's __require IIFE so CJS
    // packages bundled inside (e.g. signal-exit) can require Node built-ins.
    js: "#!/usr/bin/env node\nimport { createRequire } from 'module';\nconst require = createRequire(import.meta.url);",
  },
});

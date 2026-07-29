import commonjs from "@rollup/plugin-commonjs";
import nodeResolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";
import { execFileSync } from "node:child_process";
import path from "node:path";
import url from "node:url";

const isWatching = Boolean(process.env.ROLLUP_WATCH);
const sdPlugin = "works.kawaii.codex-shortcuts-plugin.sdPlugin";

/** @type {import("rollup").RollupOptions} */
const config = {
  input: "src/plugin.ts",
  output: {
    file: `${sdPlugin}/bin/plugin.js`,
    format: "es",
    sourcemap: isWatching,
    sourcemapPathTransform(relativeSourcePath, sourcemapPath) {
      return url.pathToFileURL(path.resolve(path.dirname(sourcemapPath), relativeSourcePath)).href;
    }
  },
  plugins: [
    {
      name: "watch-static-files",
      buildStart() {
        execFileSync(process.execPath, ["scripts/build-mic-level-meter.mjs"], {
          stdio: "inherit"
        });
        this.addWatchFile("native/mic-level-meter.swift");
        this.addWatchFile(`${sdPlugin}/manifest.json`);
        this.addWatchFile(`${sdPlugin}/ui/property-inspector.html`);
        this.addWatchFile(`${sdPlugin}/ui/property-inspector.js`);
        this.addWatchFile(`${sdPlugin}/layouts/encoder.json`);
      }
    },
    typescript({
      tsconfig: "./tsconfig.build.json",
      compilerOptions: {
        noEmit: false,
        sourceMap: isWatching
      },
      mapRoot: isWatching ? "./" : undefined
    }),
    nodeResolve({ browser: false, exportConditions: ["node"], preferBuiltins: true }),
    commonjs(),
    {
      name: "emit-module-package-file",
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "package.json",
          source: "{\"type\":\"module\"}"
        });
      }
    }
  ]
};

export default config;

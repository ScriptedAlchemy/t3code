// @effect-diagnostics nodeBuiltinImport:off - Tests exercise the Node build configuration boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";

import { expect, it, vi } from "vite-plus/test";

it("loads the Metro config without generating bundle assets or accessing the network", async () => {
  const configPath = new URL("../apps/mobile/metro.config.js", import.meta.url);
  const require = NodeModule.createRequire(configPath);
  const getTransformOptions = vi.fn(async () => ({ transform: { inlineRequires: true } }));
  const generateImport = vi.fn(async () => {
    throw new Error("Bundle generation must not run while loading the config");
  });
  const module = { exports: undefined as unknown };
  const script = new NodeVM.Script(await NodeFSP.readFile(configPath, "utf8"), {
    filename: configPath.pathname,
    importModuleDynamically: generateImport,
  });
  script.runInNewContext({
    __dirname: new URL("../apps/mobile/", import.meta.url).pathname.slice(0, -1),
    module,
    process,
    console,
    require: Object.assign(
      (id: string) => {
        if (id === "expo/metro-config") {
          return { getDefaultConfig: () => ({ transformer: { getTransformOptions } }) };
        }
        if (id === "uniwind/metro") return { withUniwindConfig: (config: unknown) => config };
        return require(id);
      },
      { resolve: require.resolve },
    ),
  });
  const config = await module.exports;
  expect(config).toHaveProperty("transformer.getTransformOptions");
  expect(generateImport).not.toHaveBeenCalled();
  expect(getTransformOptions).not.toHaveBeenCalled();
});

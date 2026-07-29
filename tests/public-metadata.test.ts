import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const projectRoot = new URL("../", import.meta.url);
const pluginRoot = new URL(
  "../works.kawaii.codex-shortcuts-plugin.sdPlugin/",
  import.meta.url
);

test("public package and Stream Deck metadata use the release identity", async () => {
  const [packageJson, manifest] = await Promise.all([
    readJson(new URL("package.json", projectRoot)),
    readJson(new URL("manifest.json", pluginRoot))
  ]);

  assert.equal(packageJson.name, "codex-shortcuts-plugin");
  assert.equal(packageJson.author, "KAWAII");
  assert.equal(manifest.Name, "Codex Shortcuts Plugin");
  assert.equal(manifest.Author, "KAWAII");
  assert.equal(manifest.UUID, "works.kawaii.codex-shortcuts-plugin");
  assert.deepEqual(
    manifest.Actions.map((action: { UUID: string }) => action.UUID),
    [
      "works.kawaii.codex-shortcuts-plugin.key",
      "works.kawaii.codex-shortcuts-plugin.encoder"
    ]
  );
  assert.equal(
    manifest.Profiles[0]?.Name,
    "profiles/Codex Shortcuts Plugin"
  );
});

async function readJson(url: URL): Promise<any> {
  return JSON.parse(await readFile(url, "utf8"));
}

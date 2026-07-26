import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CodexConfigController, rewriteRootStringSettings } from "../src/codex/config-controller.ts";

test("model, reasoning, and speed preserve comments while Access never writes config.toml", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "codex-micro-deck-config-"));
  await writeModels(root);
  const original = [
    "# user note",
    'model = "gpt-5.6-sol" # keep this comment',
    'theme = "dark"',
    "",
    "[features]",
    "experimental = true",
    ""
  ].join("\n");
  await writeFile(path.join(root, "config.toml"), original, { mode: 0o600 });

  const controller = new CodexConfigController({ codexRoot: root });
  await controller.applyControl("model", "gpt-5.6-terra");
  await controller.applyControl("reasoning", "medium");
  await controller.applyControl("speed", "fast");
  await controller.applyControl("approval", "custom");

  const saved = await readFile(path.join(root, "config.toml"), "utf8");
  assert.match(saved, /model = "gpt-5\.6-terra" # keep this comment/);
  assert.match(saved, /theme = "dark"/);
  assert.match(saved, /model_reasoning_effort = "medium"/);
  assert.match(saved, /service_tier = "fast"/);
  assert.doesNotMatch(saved, /approval_policy\s*=/);
  assert.doesNotMatch(saved, /approvals_reviewer\s*=/);
  assert.match(saved, /\[features\]\nexperimental = true\n$/);
  assert.equal((await stat(path.join(root, "config.toml"))).mode & 0o777, 0o600);
});

test("reset removes Standard service tier while Access leaves configured defaults untouched", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "codex-micro-deck-reset-"));
  await writeModels(root);
  await writeFile(path.join(root, "config.toml"), [
    'service_tier = "fast"',
    'approval_policy = "never"',
    'approvals_reviewer = "auto_review"',
    ""
  ].join("\n"));
  const controller = new CodexConfigController({ codexRoot: root });
  await controller.resetControl("speed");
  await controller.resetControl("approval");
  const saved = await readFile(path.join(root, "config.toml"), "utf8");
  assert.doesNotMatch(saved, /^service_tier\s*=/m);
  assert.match(saved, /^approval_policy = "on-request"$/m);
  assert.match(saved, /^approvals_reviewer = "user"$/m);
  assert.match(saved, /^sandbox_mode = "workspace-write"$/m);
});

test("Ask, Delegate, and Full write the exact new-task Access defaults", async () => {
  const expected = {
    ask: {
      approval: "on-request", reviewer: "user", sandbox: "workspace-write"
    },
    delegate: {
      approval: "on-request", reviewer: "guardian_subagent", sandbox: "workspace-write"
    },
    full: {
      approval: "never", reviewer: "user", sandbox: "danger-full-access"
    }
  } as const;

  for (const [access, values] of Object.entries(expected)) {
    const root = await mkdtemp(path.join(tmpdir(), `codex-micro-deck-${access}-`));
    await writeModels(root);
    await writeFile(path.join(root, "config.toml"), 'theme = "dark"\n');
    const controller = new CodexConfigController({ codexRoot: root });
    await controller.applyControl("approval", access);
    const saved = await readFile(path.join(root, "config.toml"), "utf8");
    assert.match(saved, new RegExp(`^approval_policy = "${values.approval}"$`, "m"));
    assert.match(saved, new RegExp(`^approvals_reviewer = "${values.reviewer}"$`, "m"));
    assert.match(saved, new RegExp(`^sandbox_mode = "${values.sandbox}"$`, "m"));
  }
});

test("unrelated apply or reset preserves legacy Never for the one-time migration tool", async () => {
  for (const operation of ["apply", "reset"] as const) {
    const root = await mkdtemp(path.join(tmpdir(), `codex-micro-deck-never-${operation}-`));
    await writeModels(root);
    await writeFile(path.join(root, "config.toml"), [
      'model = "gpt-5.6-sol"',
      'approval_policy = "never"',
      'approvals_reviewer = "user"',
      ""
    ].join("\n"));
    const controller = new CodexConfigController({ codexRoot: root });
    const snapshot = operation === "apply"
      ? await controller.applyControl("speed", "fast")
      : await controller.resetControl("model");
    const saved = await readFile(path.join(root, "config.toml"), "utf8");
    assert.equal(snapshot.approval, "never");
    assert.match(saved, /^approval_policy = "never"$/m);
    assert.match(saved, /^approvals_reviewer = "user"$/m);
  }
});

test("complex and duplicate root values are rejected instead of partially rewritten", () => {
  assert.throws(
    () => rewriteRootStringSettings('approval_policy = { reject = { sandbox = true } }\n', { approval_policy: "never" }),
    /Unsupported Codex config value syntax/
  );
  assert.throws(
    () => rewriteRootStringSettings('model = "a"\nmodel = "b"\n', { model: "gpt-5.6-sol" }),
    /Duplicate root Codex config key/
  );
});

test("rewriter preserves LF, CRLF, missing final newline, and an empty result", () => {
  assert.equal(
    rewriteRootStringSettings('model = "old"\n', { model: "gpt-5.6-sol" }),
    'model = "gpt-5.6-sol"\n'
  );
  assert.equal(
    rewriteRootStringSettings('model = "old"\r\n[features]\r\nfast_mode = true\r\n', { model: "gpt-5.6-sol" }),
    'model = "gpt-5.6-sol"\r\n[features]\r\nfast_mode = true\r\n'
  );
  assert.equal(
    rewriteRootStringSettings('model = "old"', { model: "gpt-5.6-sol" }),
    'model = "gpt-5.6-sol"'
  );
  assert.equal(rewriteRootStringSettings('service_tier = "fast"\n', { service_tier: undefined }), "");
  assert.equal(rewriteRootStringSettings("", { model: "gpt-5.6-sol" }), 'model = "gpt-5.6-sol"\n');
});

test("model and reasoning choices come from visible cache entries in priority order", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "codex-micro-deck-models-"));
  await writeFile(path.join(root, "models_cache.json"), JSON.stringify({ models: [
    {
      slug: "gpt-hidden", display_name: "Hidden", visibility: "hide", priority: 0,
      default_reasoning_level: "high", supported_reasoning_levels: [{ effort: "high" }]
    },
    {
      slug: "gpt-5.6-terra", display_name: "GPT-5.6-Codex-Terra", visibility: "list", priority: 2,
      default_reasoning_level: "medium",
      supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "ultra" }]
    },
    {
      slug: "gpt-5.6-sol", display_name: "GPT-5.6-Codex-Sol", visibility: "list", priority: 1,
      default_reasoning_level: "low",
      supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, { effort: "ultra" }]
    }
  ] }));
  await writeFile(path.join(root, "config.toml"), [
    'model = "gpt-5.6-terra"',
    'model_reasoning_effort = "ultra"',
    'service_tier = "default"',
    'approval_policy = "on-request"',
    'approvals_reviewer = "auto_review"',
    ""
  ].join("\n"));

  const snapshot = await new CodexConfigController({ codexRoot: root }).read();
  assert.deepEqual(snapshot.models.map((model) => model.id), ["gpt-5.6-sol", "gpt-5.6-terra"]);
  assert.equal(snapshot.model, "gpt-5.6-terra");
  assert.equal(snapshot.reasoning, "ultra");
  assert.equal(snapshot.speed, "standard");
  assert.equal(snapshot.approval, "auto");
});

test("an outdated model cache cannot expose or apply the retired Max reasoning level", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "codex-micro-deck-no-max-"));
  await writeFile(path.join(root, "models_cache.json"), JSON.stringify({ models: [{
    slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol", visibility: "list", priority: 1,
    default_reasoning_level: "max",
    supported_reasoning_levels: [{ effort: "low" }, { effort: "max" }, { effort: "ultra" }]
  }] }));
  await writeFile(path.join(root, "config.toml"), 'model_reasoning_effort = "max"\n');
  const controller = new CodexConfigController({ codexRoot: root });

  const snapshot = await controller.read();
  assert.deepEqual(snapshot.models[0]?.reasoning, ["low", "ultra"]);
  assert.equal(snapshot.reasoning, "low");
  await assert.rejects(() => controller.applyControl("reasoning", "max"), /not supported/);
});

test("Custom resolves config.toml approval, reviewer, and sandbox policy without writing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "codex-micro-deck-approvals-"));
  await writeModels(root);
  const original = [
    'approval_policy = "on-request"',
    'approvals_reviewer = "user"',
    'sandbox_mode = "danger-full-access"',
    ""
  ].join("\n");
  await writeFile(path.join(root, "config.toml"), original);
  const controller = new CodexConfigController({ codexRoot: root });
  const snapshot = await controller.applyControl("approval", "custom");
  assert.deepEqual(snapshot.customAccess, {
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandboxPolicy: { type: "dangerFullAccess" }
  });
  assert.equal(await readFile(path.join(root, "config.toml",), "utf8"), original);
});

test("Custom resolves the documented workspace sandbox table without writing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "codex-micro-deck-workspace-sandbox-"));
  await writeModels(root);
  const original = [
    'approval_policy = "on-request"',
    'approvals_reviewer = "guardian_subagent"',
    'sandbox_mode = "workspace-write"',
    "",
    "[sandbox_workspace_write]",
    'writable_roots = ["/Users/example/Project", "/private/tmp"]',
    "network_access = true",
    "exclude_tmpdir_env_var = true",
    "exclude_slash_tmp = true",
    ""
  ].join("\n");
  await writeFile(path.join(root, "config.toml"), original);
  const controller = new CodexConfigController({ codexRoot: root });

  const snapshot = await controller.applyControl("approval", "custom");
  assert.deepEqual(snapshot.customAccess, {
    approvalPolicy: "on-request",
    approvalsReviewer: "guardian_subagent",
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: ["/Users/example/Project", "/private/tmp"],
      networkAccess: true,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true
    }
  });
  assert.equal(await readFile(path.join(root, "config.toml"), "utf8"), original);
});

test("invalid model/reasoning and a complex Access config leave the file untouched", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "codex-micro-deck-reject-"));
  await writeModels(root);
  const original = [
    'model = "gpt-5.6-sol"',
    'approval_policy = { granular = { sandbox_approval = "prompt" } }',
    'approvals_reviewer = "user"',
    ""
  ].join("\n");
  await writeFile(path.join(root, "config.toml"), original);
  const controller = new CodexConfigController({ codexRoot: root });

  await assert.rejects(() => controller.applyControl("model", "not-in-cache"), /not present/);
  await assert.rejects(() => controller.applyControl("reasoning", "impossible"), /not supported/);
  await controller.applyControl("approval", "custom");
  assert.equal(await readFile(path.join(root, "config.toml"), "utf8"), original);
});

test("concurrent config changes serialize a new Access default with other dials", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "codex-micro-deck-queue-"));
  await writeModels(root);
  await writeFile(path.join(root, "config.toml"), 'model = "gpt-5.6-sol"\n');
  await chmod(path.join(root, "config.toml"), 0o600);
  const controller = new CodexConfigController({ codexRoot: root });

  await Promise.all([
    controller.applyControl("speed", "flex"),
    controller.applyControl("approval", "delegate")
  ]);
  const saved = await readFile(path.join(root, "config.toml"), "utf8");
  assert.match(saved, /^service_tier = "flex"$/m);
  assert.match(saved, /^approval_policy = "on-request"$/m);
  assert.match(saved, /^approvals_reviewer = "guardian_subagent"$/m);
  assert.match(saved, /^sandbox_mode = "workspace-write"$/m);
});

test("symbolic-link config files are refused before any write", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "codex-micro-deck-link-"));
  const target = path.join(root, "real.toml");
  await writeFile(target, 'model = "gpt-5.6-sol"\n');
  await symlink(target, path.join(root, "config.toml"));
  const controller = new CodexConfigController({ codexRoot: root });
  await assert.rejects(() => controller.applyControl("speed", "fast"), /symbolic-link/);
  assert.equal(await readFile(target, "utf8"), 'model = "gpt-5.6-sol"\n');
});

async function writeModels(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "models_cache.json"), JSON.stringify({ models: [
    {
      slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol", visibility: "list", priority: 1,
      default_reasoning_level: "low",
      supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }]
    },
    {
      slug: "gpt-5.6-terra", display_name: "GPT-5.6-Terra", visibility: "list", priority: 2,
      default_reasoning_level: "medium",
      supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }]
    }
  ] }));
}

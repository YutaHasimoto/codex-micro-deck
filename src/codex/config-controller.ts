import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export type ConfigControlRole = "model" | "reasoning" | "speed" | "approval";
export type SpeedSetting = "standard" | "fast" | "flex";
export type ApprovalSetting = "strict" | "ask" | "auto" | "never";
export type CodexApprovalPolicy = "untrusted" | "on-request" | "never";
export type CodexApprovalsReviewer = "user" | "auto_review" | "guardian_subagent";
export type CodexSandboxPolicy =
  | { type: "dangerFullAccess" }
  | { type: "readOnly"; networkAccess: boolean }
  | {
    type: "workspaceWrite";
    writableRoots: string[];
    networkAccess: boolean;
    excludeTmpdirEnvVar: boolean;
    excludeSlashTmp: boolean;
  };

/** Exact access values resolved from config.toml for the Custom Access mode. */
export type CustomAccessSettings = {
  approvalPolicy: CodexApprovalPolicy;
  approvalsReviewer: CodexApprovalsReviewer;
  sandboxPolicy: CodexSandboxPolicy;
};

export type ModelOption = {
  id: string;
  label: string;
  reasoning: string[];
  defaultReasoning: string;
  priority: number;
};

export type CodexControlSnapshot = {
  models: ModelOption[];
  model: string;
  reasoning: string;
  speed: SpeedSetting;
  /** Legacy config view retained for old settings and migration tooling. */
  approval: ApprovalSetting;
  /** Config-derived values used only when the Deck Access mode is Custom. */
  customAccess: CustomAccessSettings;
};

// Codex no longer exposes a `max` reasoning level. Keep this allow-list
// narrower than old configuration files so an outdated cache can never put a
// value on the Deck which Desktop will reject.
const REASONING_VALUES = new Set(["low", "medium", "high", "xhigh", "ultra"]);
const SPEED_VALUES = new Set<SpeedSetting>(["standard", "fast", "flex"]);
const MAX_CONFIG_BYTES = 2 * 1024 * 1024;

export const FALLBACK_MODELS: readonly ModelOption[] = [
  {
    id: "gpt-5.6-sol",
    label: "5.6 Sol",
    reasoning: ["low", "medium", "high", "xhigh", "ultra"],
    defaultReasoning: "low",
    priority: 1
  },
  {
    id: "gpt-5.6-terra",
    label: "5.6 Terra",
    reasoning: ["low", "medium", "high", "xhigh", "ultra"],
    defaultReasoning: "medium",
    priority: 2
  }
];

type ConfigControllerOptions = {
  codexRoot?: string;
  environment?: NodeJS.ProcessEnv;
  userHome?: string;
};

/**
 * Reads and atomically updates only the supported root keys in Codex config.
 * Existing comments, unrelated keys, and every TOML table remain byte-for-byte
 * unchanged except for line endings around newly inserted keys.
 */
export class CodexConfigController {
  readonly #codexRoot: string;
  readonly #configPath: string;
  readonly #modelsPath: string;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: ConfigControllerOptions = {}) {
    const environment = options.environment ?? process.env;
    const userHome = options.userHome ?? homedir();
    const configuredRoot = environment.CODEX_HOME?.trim();
    this.#codexRoot = path.resolve(
      options.codexRoot ?? (configuredRoot || path.join(userHome, ".codex"))
    );
    this.#configPath = path.join(this.#codexRoot, "config.toml");
    this.#modelsPath = path.join(this.#codexRoot, "models_cache.json");
  }

  read(): Promise<CodexControlSnapshot> {
    return this.#enqueue(() => this.#readUnlocked());
  }

  applyControl(role: ConfigControlRole, value: string): Promise<CodexControlSnapshot> {
    return this.#enqueue(async () => {
      const current = await this.#readUnlocked();
      const updates = this.#updatesFor(role, value, current);
      await this.#writeUpdates(updates);
      return this.#readUnlocked();
    });
  }

  resetControl(role: ConfigControlRole): Promise<CodexControlSnapshot> {
    return this.#enqueue(async () => {
      const current = await this.#readUnlocked();
      const defaultModel = current.models[0] ?? FALLBACK_MODELS[0]!;
      let updates: Record<string, string | undefined>;
      if (role === "model") {
        updates = {
          model: defaultModel.id,
          model_reasoning_effort: defaultModel.defaultReasoning
        };
      } else if (role === "reasoning") {
        const selectedModel = modelFor(current.models, current.model);
        updates = { model_reasoning_effort: selectedModel.defaultReasoning };
      } else if (role === "speed") {
        updates = { service_tier: undefined };
      } else {
        updates = accessPresetUpdates("ask");
      }
      await this.#writeUpdates(updates);
      return this.#readUnlocked();
    });
  }

  async #readUnlocked(): Promise<CodexControlSnapshot> {
    const [models, content] = await Promise.all([
      this.#readModels(),
      this.#readConfig()
    ]);
    const root = parseRootStringSettings(content);
    const configuredModel = root.get("model");
    const selectedModel = modelFor(models, configuredModel);
    const configuredReasoning = root.get("model_reasoning_effort");
    const reasoning = configuredReasoning && selectedModel.reasoning.includes(configuredReasoning)
      ? configuredReasoning
      : selectedModel.defaultReasoning;
    const configuredSpeed = root.get("service_tier");
    const speed: SpeedSetting = configuredSpeed === "fast" || configuredSpeed === "flex"
      ? configuredSpeed
      : "standard";
    return {
      models,
      model: selectedModel.id,
      reasoning,
      speed,
      approval: approvalFromConfig(root.get("approval_policy"), root.get("approvals_reviewer")),
      customAccess: customAccessFromConfig(content, root)
    };
  }

  #updatesFor(
    role: ConfigControlRole,
    value: string,
    current: CodexControlSnapshot
  ): Record<string, string | undefined> {
    if (role === "model") {
      const selected = current.models.find((model) => model.id === value);
      if (!selected) throw new Error("Selected model is not present in the current Codex model cache");
      return {
        model: selected.id,
        ...(!selected.reasoning.includes(current.reasoning)
          ? { model_reasoning_effort: selected.defaultReasoning } : {})
      };
    }
    if (role === "reasoning") {
      const selectedModel = modelFor(current.models, current.model);
      if (!REASONING_VALUES.has(value) || !selectedModel.reasoning.includes(value)) {
        throw new Error("Selected reasoning effort is not supported by the current model");
      }
      return { model_reasoning_effort: value };
    }
    if (role === "speed") {
      if (!SPEED_VALUES.has(value as SpeedSetting)) throw new Error("Unsupported Codex speed setting");
      return { service_tier: value === "standard" ? undefined : value };
    }
    if (role === "approval") {
      if (value === "custom") return {};
      if (value === "ask" || value === "delegate" || value === "full") {
        return accessPresetUpdates(value);
      }
      throw new Error("Unsupported Codex Access setting");
    }
    throw new Error("Unsupported Codex configuration control");
  }

  async #readModels(): Promise<ModelOption[]> {
    try {
      const raw = await readFile(this.#modelsPath, "utf8");
      const parsed = JSON.parse(raw) as { models?: unknown };
      if (!Array.isArray(parsed.models)) return cloneFallbackModels();
      const models = parsed.models.flatMap((value): ModelOption[] => {
        if (!value || typeof value !== "object") return [];
        const item = value as Record<string, unknown>;
        if (item.visibility !== "list" || typeof item.slug !== "string" || !safeConfigToken(item.slug)) {
          return [];
        }
        const reasoning = Array.isArray(item.supported_reasoning_levels)
          ? item.supported_reasoning_levels.flatMap((level): string[] => {
            if (!level || typeof level !== "object") return [];
            const effort = (level as Record<string, unknown>).effort;
            return typeof effort === "string" && REASONING_VALUES.has(effort) ? [effort] : [];
          })
          : [];
        if (!reasoning.length) return [];
        const defaultReasoning = typeof item.default_reasoning_level === "string"
          && reasoning.includes(item.default_reasoning_level)
          ? item.default_reasoning_level
          : reasoning[0]!;
        const priority = typeof item.priority === "number" && Number.isFinite(item.priority)
          ? item.priority : Number.MAX_SAFE_INTEGER;
        const displayName = typeof item.display_name === "string" ? item.display_name : item.slug;
        return [{
          id: item.slug,
          label: shortModelLabel(displayName),
          reasoning: [...new Set(reasoning)],
          defaultReasoning,
          priority
        }];
      }).sort((left, right) => left.priority - right.priority || left.label.localeCompare(right.label));
      return models.length ? models : cloneFallbackModels();
    } catch {
      return cloneFallbackModels();
    }
  }

  async #readConfig(): Promise<string> {
    try {
      const info = await lstat(this.#configPath);
      if (info.isSymbolicLink()) throw new Error("Refusing to modify a symbolic-link Codex config");
      if (!info.isFile()) throw new Error("Codex config path is not a regular file");
      if (info.size > MAX_CONFIG_BYTES) throw new Error("Codex config is unexpectedly large");
      return await readFile(this.#configPath, "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return "";
      throw error;
    }
  }

  async #writeUpdates(updates: Record<string, string | undefined>): Promise<void> {
    const current = await this.#readConfig();
    const next = rewriteRootStringSettings(current, updates);
    if (next === current) return;
    await mkdir(this.#codexRoot, { recursive: true, mode: 0o700 });
    const existing = await stat(this.#configPath).catch((error: unknown) => {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw error;
    });
    const mode = existing ? existing.mode & 0o777 : 0o600;
    const temporaryPath = path.join(
      this.#codexRoot,
      `.config.toml.codex-micro-deck-${process.pid}-${randomUUID()}.tmp`
    );
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
      await handle.writeFile(next, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, this.#configPath);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation);
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function modelFor(models: readonly ModelOption[], modelId: string | undefined): ModelOption {
  return models.find((model) => model.id === modelId) ?? models[0] ?? FALLBACK_MODELS[0]!;
}

function approvalFromConfig(policy: string | undefined, reviewer: string | undefined): ApprovalSetting {
  if (policy === "untrusted") return "strict";
  if (policy === "never") return "never";
  if (policy === "on-request" && reviewer === "auto_review") return "auto";
  return "ask";
}

function accessPresetUpdates(access: "ask" | "delegate" | "full"): Record<string, string> {
  if (access === "full") {
    return {
      approval_policy: "never",
      approvals_reviewer: "user",
      sandbox_mode: "danger-full-access"
    };
  }
  return {
    approval_policy: "on-request",
    approvals_reviewer: access === "delegate" ? "guardian_subagent" : "user",
    sandbox_mode: "workspace-write"
  };
}

function customAccessFromConfig(
  content: string,
  root: ReadonlyMap<string, string>
): CustomAccessSettings {
  const configuredPolicy = root.get("approval_policy");
  const approvalPolicy: CodexApprovalPolicy = configuredPolicy === "untrusted"
    || configuredPolicy === "never"
    || configuredPolicy === "on-request"
    ? configuredPolicy
    : "on-request";
  const configuredReviewer = root.get("approvals_reviewer");
  const approvalsReviewer: CodexApprovalsReviewer = configuredReviewer === "auto_review"
    || configuredReviewer === "guardian_subagent"
    || configuredReviewer === "user"
    ? configuredReviewer
    : "user";
  return {
    approvalPolicy,
    approvalsReviewer,
    sandboxPolicy: sandboxPolicyFromConfig(content, root.get("sandbox_mode"))
  };
}

/**
 * This reader deliberately supports only the documented sandbox_mode strings
 * and the small [sandbox_workspace_write] scalar/table shape. It never writes
 * this section; malformed or omitted values fall back to read-only so Custom
 * cannot accidentally grant broader access than config.toml made clear.
 */
function sandboxPolicyFromConfig(content: string, sandboxMode: string | undefined): CodexSandboxPolicy {
  if (sandboxMode === "danger-full-access") return { type: "dangerFullAccess" };
  if (sandboxMode === "workspace-write") {
    const workspace = parseSandboxWorkspaceWrite(content);
    return {
      type: "workspaceWrite",
      writableRoots: workspace.writableRoots,
      networkAccess: workspace.networkAccess,
      excludeTmpdirEnvVar: workspace.excludeTmpdirEnvVar,
      excludeSlashTmp: workspace.excludeSlashTmp
    };
  }
  return { type: "readOnly", networkAccess: false };
}

function parseSandboxWorkspaceWrite(content: string): {
  writableRoots: string[];
  networkAccess: boolean;
  excludeTmpdirEnvVar: boolean;
  excludeSlashTmp: boolean;
} {
  const result = {
    writableRoots: [] as string[],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false
  };
  let inTable = false;
  for (const line of content.split(/\r?\n/)) {
    const table = /^\s*\[\s*([^\]]+)\s*\]\s*(?:#.*)?$/.exec(line);
    if (table?.[1]) {
      inTable = table[1] === "sandbox_workspace_write";
      continue;
    }
    if (!inTable) continue;
    const assignment = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.*?)\s*(?:#.*)?$/.exec(line);
    const key = assignment?.[1];
    const raw = assignment?.[2];
    if (!key || raw === undefined) continue;
    if (key === "writable_roots") {
      const roots = parseTomlStringArray(raw);
      if (roots) result.writableRoots = roots;
    } else if (key === "network_access" && raw === "true") {
      result.networkAccess = true;
    } else if (key === "exclude_tmpdir_env_var" && raw === "true") {
      result.excludeTmpdirEnvVar = true;
    } else if (key === "exclude_slash_tmp" && raw === "true") {
      result.excludeSlashTmp = true;
    }
  }
  return result;
}

function parseTomlStringArray(value: string): string[] | undefined {
  const match = /^\[\s*(.*?)\s*\]$/.exec(value);
  if (!match || match[1] === undefined) return undefined;
  if (!match[1]) return [];
  const values: string[] = [];
  const itemPattern = /"((?:\\.|[^"\\])*)"\s*(?:,|$)/gy;
  let position = 0;
  while (position < match[1].length) {
    itemPattern.lastIndex = position;
    const item = itemPattern.exec(match[1]);
    if (!item?.[1]) return undefined;
    const decoded = decodeTomlBasicString(item[1]);
    if (!path.isAbsolute(decoded) || decoded.includes("\0")) return undefined;
    values.push(decoded);
    position = itemPattern.lastIndex;
    while (position < match[1].length && /\s/.test(match[1][position]!)) position += 1;
  }
  return values.length <= 64 ? values : undefined;
}

function parseRootStringSettings(content: string): Map<string, string> {
  const settings = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;
    const match = /^\s*([A-Za-z0-9_-]+)\s*=\s*"((?:\\.|[^"\\])*)"/.exec(line);
    if (!match?.[1] || match[2] === undefined) continue;
    settings.set(match[1], decodeTomlBasicString(match[2]));
  }
  return settings;
}

export function rewriteRootStringSettings(
  content: string,
  updates: Record<string, string | undefined>
): string {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const hadFinalNewline = content.endsWith("\n") || content.length === 0;
  const lines = content ? content.split(/\r?\n/) : [];
  if (hadFinalNewline && lines.at(-1) === "") lines.pop();
  const tableIndex = lines.findIndex((line) => /^\s*\[/.test(line));
  const rootEnd = tableIndex === -1 ? lines.length : tableIndex;
  const found = new Set<string>();
  const rewritten: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (index >= rootEnd) {
      rewritten.push(line);
      continue;
    }
    const keyMatch = /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line);
    const key = keyMatch?.[1];
    if (!key || !Object.hasOwn(updates, key)) {
      rewritten.push(line);
      continue;
    }
    if (found.has(key)) throw new Error(`Duplicate root Codex config key: ${key}`);
    found.add(key);
    // These Codex settings are documented as strings. Refuse inline tables,
    // arrays, multiline strings, and other complex TOML instead of replacing
    // only their first token and leaving an invalid tail behind.
    const assignment = /^(\s*[A-Za-z0-9_-]+\s*=\s*)(?:"(?:\\.|[^"\\])*"|'[^']*')(\s*(?:#.*)?)$/.exec(line);
    if (!assignment?.[1]) throw new Error(`Unsupported Codex config value syntax: ${key}`);
    const value = updates[key];
    if (value === undefined) continue;
    rewritten.push(`${assignment[1]}${encodeTomlBasicString(value)}${assignment[2] ?? ""}`);
  }

  const additions = Object.entries(updates)
    .filter(([key, value]) => value !== undefined && !found.has(key))
    .map(([key, value]) => `${key} = ${encodeTomlBasicString(value!)}`);
  if (additions.length) {
    const insertAt = tableIndex === -1 ? rewritten.length : rootEnd;
    rewritten.splice(insertAt, 0, ...additions);
    if (tableIndex !== -1 && rewritten[insertAt + additions.length] !== "") {
      rewritten.splice(insertAt + additions.length, 0, "");
    }
  }
  const result = rewritten.join(newline);
  if (!result) return "";
  return hadFinalNewline ? `${result}${newline}` : result;
}

function encodeTomlBasicString(value: string): string {
  if (!safeConfigToken(value)) throw new Error("Unsafe Codex config value");
  return JSON.stringify(value);
}

function decodeTomlBasicString(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value;
  }
}

function safeConfigToken(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,95}$/i.test(value);
}

function shortModelLabel(value: string): string {
  return value
    .replace(/^GPT-/i, "")
    .replace(/-Codex-/i, " ")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 18);
}

function cloneFallbackModels(): ModelOption[] {
  return FALLBACK_MODELS.map((model) => ({ ...model, reasoning: [...model.reasoning] }));
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

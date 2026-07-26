import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createConnection, type Socket } from "node:net";

import type {
  ApprovalSetting,
  CodexApprovalsReviewer,
  CodexControlSnapshot,
  CodexSandboxPolicy,
  ConfigControlRole,
  CustomAccessSettings,
  SpeedSetting
} from "./config-controller.js";
import type { AccessMode } from "../types.js";

export const DEFAULT_DESKTOP_IPC_TIMEOUT_MS = 2_500;
export const DEFAULT_DESKTOP_IPC_MAX_FRAME_BYTES = 1024 * 1024;

// Must stay aligned with config-controller: `max` is not a current Codex
// reasoning enum and is rejected before any Desktop IPC request is sent.
const REASONING_VALUES = new Set(["low", "medium", "high", "xhigh", "ultra"]);
const CLIENT_TYPE = "codex-micro-deck";

type JsonRecord = Record<string, unknown>;

export type CodexThreadSettingsPatch = {
  model?: string;
  effort?: string;
  serviceTier?: string | null;
  approvalPolicy?: "untrusted" | "on-request" | "never";
  approvalsReviewer?: CodexApprovalsReviewer;
  /** Named profile, e.g. :workspace or :danger-full-access. */
  permissions?: string;
  /** Raw sandbox policy, used solely for the config.toml-backed Custom mode. */
  sandboxPolicy?: CodexSandboxPolicy;
};

export type CodexDesktopIpcClientOptions = {
  codexRoot?: string;
  environment?: NodeJS.ProcessEnv;
  userHome?: string;
  timeoutMs?: number;
  maxFrameBytes?: number;
  expectedUid?: number;
  /** In-memory transport seam used by tests; production always uses createConnection. */
  socketConnector?: (socketPath: string) => Socket;
  /** Test seam paired with socketConnector; production always performs lstat checks. */
  socketVerifier?: () => Promise<void>;
};

export type LiveThreadUpdateResult =
  | { applied: true; conversationId: string }
  | { applied: false; reason: "no-target" | "ambiguous" };

/**
 * Applies settings to an existing Codex Desktop task through its local,
 * owner-only IPC router. Each operation uses an ephemeral client so the
 * Stream Deck plugin never becomes a long-lived Desktop routing target.
 */
export class CodexDesktopIpcClient {
  readonly #codexRoot: string;
  readonly #ipcDirectory: string;
  readonly #socketPath: string;
  readonly #timeoutMs: number;
  readonly #maxFrameBytes: number;
  readonly #expectedUid: number | undefined;
  readonly #socketConnector: (socketPath: string) => Socket;
  readonly #socketVerifier: (() => Promise<void>) | undefined;

  constructor(options: CodexDesktopIpcClientOptions = {}) {
    const environment = options.environment ?? process.env;
    const userHome = options.userHome ?? homedir();
    const configuredRoot = environment.CODEX_HOME?.trim();
    this.#codexRoot = path.resolve(
      options.codexRoot ?? (configuredRoot || path.join(userHome, ".codex"))
    );
    this.#ipcDirectory = path.join(this.#codexRoot, "ipc");
    this.#socketPath = path.join(this.#ipcDirectory, "ipc.sock");
    this.#timeoutMs = boundedPositiveInteger(
      options.timeoutMs,
      DEFAULT_DESKTOP_IPC_TIMEOUT_MS,
      100,
      10_000
    );
    this.#maxFrameBytes = boundedPositiveInteger(
      options.maxFrameBytes,
      DEFAULT_DESKTOP_IPC_MAX_FRAME_BYTES,
      1024,
      16 * 1024 * 1024
    );
    this.#expectedUid = options.expectedUid
      ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
    this.#socketConnector = options.socketConnector
      ?? ((socketPath) => createConnection({ path: socketPath }));
    this.#socketVerifier = options.socketVerifier;
  }

  async updateThreadSettings(
    fallbackConversationId: string | undefined,
    threadSettings: CodexThreadSettingsPatch
  ): Promise<LiveThreadUpdateResult> {
    if (fallbackConversationId !== undefined) assertConversationId(fallbackConversationId);
    assertThreadSettings(threadSettings);
    if (this.#socketVerifier) await this.#socketVerifier();
    else await this.#assertSecureSocket();

    const socket = this.#socketConnector(this.#socketPath);
    // Install the decoder before waiting for connect. Desktop can announce the
    // actively followed task immediately, before it answers initialize.
    const session = new DesktopIpcSession(socket, this.#timeoutMs, this.#maxFrameBytes);
    try {
      await waitForConnection(socket, this.#timeoutMs);
      const initializeRequestId = randomUUID();
      const initializeResponse = await session.request({
        type: "request",
        requestId: initializeRequestId,
        sourceClientId: "initializing-client",
        version: 0,
        method: "initialize",
        params: { clientType: CLIENT_TYPE }
      });
      assertSuccessfulResponse(initializeResponse, "initialize", "initialize");
      const initializeResult = asRecord(initializeResponse.result);
      const clientId = initializeResult?.clientId;
      if (typeof clientId !== "string" || !clientId) {
        throw new Error("Codex Desktop IPC returned an invalid initialize response");
      }

      // Desktop may emit the initial following state immediately before or
      // shortly after initialize. A short settle window captures both orders
      // and lets us reject an unexpected multi-follow state safely.
      const activeTarget = await session.settleActiveConversation(50);
      if (activeTarget.kind === "ambiguous" && !fallbackConversationId) {
        return { applied: false, reason: "ambiguous" };
      }
      const conversationId = activeTarget.kind === "one"
        ? activeTarget.conversationId
        : fallbackConversationId;
      if (!conversationId) return { applied: false, reason: "no-target" };
      const updateResponse = await session.request({
        type: "request",
        requestId: randomUUID(),
        sourceClientId: clientId,
        version: 1,
        method: "thread-follower-update-thread-settings",
        timeoutMs: this.#timeoutMs,
        params: { conversationId, threadSettings }
      });
      assertSuccessfulResponse(
        updateResponse,
        "thread-follower-update-thread-settings",
        "thread settings update"
      );
      const updateResult = asRecord(updateResponse.result);
      if (updateResult?.ok !== true) {
        throw new Error("Codex Desktop did not confirm the task settings update");
      }
      return { applied: true, conversationId };
    } catch (error) {
      throw normalizeIpcError(error);
    } finally {
      session.close();
    }
  }

  async #assertSecureSocket(): Promise<void> {
    await assertOwnerOnlyIpcPaths(
      this.#codexRoot,
      this.#ipcDirectory,
      this.#socketPath,
      this.#expectedUid
    );
  }
}

/** Owner-only lstat checks shared by the ephemeral client and the follower. */
export async function assertOwnerOnlyIpcPaths(
  codexRoot: string,
  ipcDirectory: string,
  socketPath: string,
  expectedUid: number | undefined
): Promise<void> {
  const assertOwner = (actualUid: number, label: string): void => {
    if (expectedUid !== undefined && actualUid !== expectedUid) {
      throw new Error(`${label} is owned by another user`);
    }
  };

  const rootInfo = await secureLstat(codexRoot, "Codex data directory");
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error("Codex data directory is not a real directory");
  }
  assertOwner(rootInfo.uid, "Codex data directory");
  if ((rootInfo.mode & 0o022) !== 0) {
    throw new Error("Codex data directory is writable by another user");
  }

  const directoryInfo = await secureLstat(ipcDirectory, "Codex Desktop IPC directory");
  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
    throw new Error("Codex Desktop IPC directory is not a real directory");
  }
  assertOwner(directoryInfo.uid, "Codex Desktop IPC directory");
  const directoryMode = directoryInfo.mode & 0o777;
  if ((directoryMode & 0o700) !== 0o700 || (directoryMode & 0o077) !== 0) {
    throw new Error("Codex Desktop IPC directory is not owner-only");
  }

  const socketInfo = await secureLstat(socketPath, "Codex Desktop IPC socket");
  if (socketInfo.isSymbolicLink() || !socketInfo.isSocket()) {
    throw new Error("Codex Desktop IPC path is not a real socket");
  }
  assertOwner(socketInfo.uid, "Codex Desktop IPC socket");
  const socketMode = socketInfo.mode & 0o777;
  if ((socketMode & 0o600) !== 0o600 || (socketMode & 0o077) !== 0) {
    throw new Error("Codex Desktop IPC socket is not owner-only");
  }
}

/** Convert the four physical control values to the Desktop thread schema. */
export function threadSettingsForControl(
  role: ConfigControlRole,
  value: string,
  appliedReasoning?: string,
  customAccess?: CustomAccessSettings
): CodexThreadSettingsPatch {
  if (role === "model") {
    if (!safeToken(value)) throw new Error("Unsupported Codex model selection");
    if (appliedReasoning !== undefined && !REASONING_VALUES.has(appliedReasoning)) {
      throw new Error("Unsupported applied Codex reasoning selection");
    }
    return {
      model: value,
      ...(appliedReasoning !== undefined ? { effort: appliedReasoning } : {})
    };
  }
  if (role === "reasoning") {
    if (!REASONING_VALUES.has(value)) throw new Error("Unsupported Codex reasoning selection");
    return { effort: value };
  }
  if (role === "speed") {
    const speed = value as SpeedSetting;
    if (speed === "standard") return { serviceTier: null };
    if (speed === "fast") return { serviceTier: "priority" };
    if (speed === "flex") return { serviceTier: "flex" };
    throw new Error("Unsupported Codex speed selection");
  }

  if (value === "ask") {
    return {
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      permissions: ":workspace"
    };
  }
  if (value === "delegate") {
    return {
      approvalPolicy: "on-request",
      approvalsReviewer: "guardian_subagent",
      permissions: ":workspace"
    };
  }
  if (value === "full") {
    return {
      approvalPolicy: "never",
      approvalsReviewer: "user",
      permissions: ":danger-full-access"
    };
  }
  if (value === "custom") {
    if (!customAccess) throw new Error("Custom Access needs resolved config.toml values");
    return { ...customAccess };
  }
  // Old manually configured controls may still send these values. Retain the
  // legacy mapping, but never offer them on the default Access dial.
  if (value === "strict") {
    return { approvalPolicy: "untrusted", approvalsReviewer: "user" };
  }
  if (value === "auto") {
    return { approvalPolicy: "on-request", approvalsReviewer: "auto_review" };
  }
  if (value === "never") {
    return { approvalPolicy: "never", approvalsReviewer: "user" };
  }
  throw new Error("Unsupported Codex approval selection");
}

/**
 * Convert the complete persisted control snapshot to one authoritative task
 * override. Sending all four controls prevents stale per-task overrides from
 * surviving when the user changes only one physical dial.
 */
export function threadSettingsForSnapshot(
  snapshot: Pick<CodexControlSnapshot, "model" | "reasoning" | "speed" | "approval">
    & Partial<Pick<CodexControlSnapshot, "customAccess">>,
  accessMode: AccessMode | ApprovalSetting = snapshot.approval
): CodexThreadSettingsPatch {
  return {
    ...threadSettingsForControl("model", snapshot.model, snapshot.reasoning),
    ...threadSettingsForControl("speed", snapshot.speed),
    ...threadSettingsForControl("approval", accessMode, undefined, snapshot.customAccess)
  };
}

/**
 * Confirms that a `thread/resume` response contains every requested setting.
 * Access must compare its permission provenance too: profiles are read from
 * activePermissionProfile.id, while Custom carries a raw sandbox policy.
 */
export function threadSettingsMatchResume(
  result: unknown,
  expected: CodexThreadSettingsPatch
): boolean {
  const actual = asRecord(result);
  if (!actual) return false;
  const resumeField: Record<keyof CodexThreadSettingsPatch, string> = {
    model: "model",
    effort: "reasoningEffort",
    serviceTier: "serviceTier",
    approvalPolicy: "approvalPolicy",
    approvalsReviewer: "approvalsReviewer",
    permissions: "activePermissionProfile",
    sandboxPolicy: "sandbox"
  };
  return (Object.keys(expected) as Array<keyof CodexThreadSettingsPatch>).every((key) => (
    key === "permissions"
      ? activePermissionProfileId(actual[resumeField[key]]) === expected.permissions
      : key === "sandboxPolicy"
        ? sandboxPoliciesMatch(actual[resumeField[key]], expected.sandboxPolicy)
          && actual.activePermissionProfile === null
        : key === "approvalsReviewer"
          ? approvalsReviewersMatch(actual[resumeField[key]], expected.approvalsReviewer)
          : key === "serviceTier"
            ? serviceTiersMatch(actual[resumeField[key]], expected.serviceTier)
        : actual[resumeField[key]] === expected[key]
  ));
}

function activePermissionProfileId(value: unknown): string | undefined {
  const profile = asRecord(value);
  return typeof profile?.id === "string" ? profile.id : undefined;
}

/**
 * Current Codex surfaces may spell delegated approval as either the original
 * auto reviewer or the guardian subagent. Both are the same Deck Delegate
 * intent; accepting either keeps persistence verification forward-compatible.
 */
function approvalsReviewersMatch(actual: unknown, expected: CodexApprovalsReviewer | undefined): boolean {
  if (actual === expected) return true;
  const delegated = expected === "guardian_subagent" || expected === "auto_review";
  return delegated && (actual === "guardian_subagent" || actual === "auto_review");
}

/**
 * App Server normalizes the absence of an explicit service tier from `null`
 * to `"default"` in `thread/resume`. Both mean the Deck's Standard speed;
 * Fast and Flex retain strict, exact verification.
 */
function serviceTiersMatch(actual: unknown, expected: string | null | undefined): boolean {
  if (expected === null) return actual === null || actual === "default";
  return actual === expected;
}

function sandboxPoliciesMatch(actual: unknown, expected: CodexSandboxPolicy | undefined): boolean {
  if (!expected) return false;
  const candidate = asRecord(actual);
  if (!candidate || candidate.type !== expected.type) return false;
  if (expected.type === "dangerFullAccess") return Object.keys(candidate).length === 1;
  if (expected.type === "readOnly") return candidate.networkAccess === expected.networkAccess;
  return candidate.networkAccess === expected.networkAccess
    && candidate.excludeTmpdirEnvVar === expected.excludeTmpdirEnvVar
    && candidate.excludeSlashTmp === expected.excludeSlashTmp
    && stringArraysMatch(candidate.writableRoots, expected.writableRoots);
}

function stringArraysMatch(actual: unknown, expected: readonly string[]): boolean {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

export function encodeIpcFrame(
  value: unknown,
  maxFrameBytes = DEFAULT_DESKTOP_IPC_MAX_FRAME_BYTES
): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (!payload.length) throw new Error("Codex Desktop IPC frame is empty");
  if (payload.length > maxFrameBytes) throw new Error("Codex Desktop IPC frame is too large");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

/** Streaming decoder that supports fragmented and coalesced Unix-socket data. */
export class IpcFrameDecoder {
  #buffer = Buffer.alloc(0);
  readonly maxFrameBytes: number;

  constructor(maxFrameBytes = DEFAULT_DESKTOP_IPC_MAX_FRAME_BYTES) {
    this.maxFrameBytes = maxFrameBytes;
  }

  push(chunk: Uint8Array): unknown[] {
    if (chunk.byteLength) {
      const next = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, next]) : Buffer.from(next);
    }
    const messages: unknown[] = [];
    while (this.#buffer.length >= 4) {
      const payloadLength = this.#buffer.readUInt32LE(0);
      if (!payloadLength) throw new Error("Codex Desktop IPC frame is empty");
      if (payloadLength > this.maxFrameBytes) throw new Error("Codex Desktop IPC frame is too large");
      if (this.#buffer.length < payloadLength + 4) break;
      const payload = this.#buffer.subarray(4, payloadLength + 4);
      this.#buffer = this.#buffer.subarray(payloadLength + 4);
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload.toString("utf8"));
      } catch {
        throw new Error("Codex Desktop IPC returned invalid JSON");
      }
      messages.push(parsed);
    }
    return messages;
  }
}

type PendingRequest = {
  resolve: (message: JsonRecord) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

class DesktopIpcSession {
  readonly #decoder: IpcFrameDecoder;
  readonly #pending = new Map<string, PendingRequest>();
  readonly socket: Socket;
  readonly timeoutMs: number;
  #closed = false;
  readonly #activeConversationIds = new Set<string>();

  constructor(
    socket: Socket,
    timeoutMs: number,
    maxFrameBytes: number
  ) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.#decoder = new IpcFrameDecoder(maxFrameBytes);
    socket.on("data", (chunk) => this.#onData(chunk));
    socket.on("error", (error) => this.#failAll(normalizeIpcError(error)));
    socket.on("close", () => this.#failAll(new Error("Codex Desktop IPC connection closed")));
  }

  async settleActiveConversation(delayMs: number): Promise<
    | { kind: "one"; conversationId: string }
    | { kind: "none" }
    | { kind: "ambiguous" }
  > {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delayMs);
      timer.unref();
    });
    if (this.#activeConversationIds.size > 1) return { kind: "ambiguous" };
    const [conversationId] = this.#activeConversationIds;
    return conversationId ? { kind: "one", conversationId } : { kind: "none" };
  }

  request(message: JsonRecord): Promise<JsonRecord> {
    const requestId = message.requestId;
    if (this.#closed) return Promise.reject(new Error("Codex Desktop IPC connection is closed"));
    if (typeof requestId !== "string" || !requestId || this.#pending.has(requestId)) {
      return Promise.reject(new Error("Codex Desktop IPC request id is invalid"));
    }

    let frame: Buffer;
    try {
      frame = encodeIpcFrame(message, this.#decoder.maxFrameBytes);
    } catch (error) {
      return Promise.reject(normalizeIpcError(error));
    }

    return new Promise<JsonRecord>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.#pending.delete(requestId)) return;
        reject(new Error("Codex Desktop IPC request timed out"));
      }, this.timeoutMs);
      timer.unref();
      this.#pending.set(requestId, { resolve, reject, timer });
      this.socket.write(frame, (error) => {
        if (!error) return;
        this.#failRequest(requestId, normalizeIpcError(error));
      });
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#failAll(new Error("Codex Desktop IPC client closed"));
    this.socket.destroy();
  }

  #onData(chunk: Buffer): void {
    let messages: unknown[];
    try {
      messages = this.#decoder.push(chunk);
    } catch (error) {
      this.#failAll(normalizeIpcError(error));
      this.socket.destroy();
      return;
    }
    for (const rawMessage of messages) {
      const message = asRecord(rawMessage);
      if (!message) continue;
      this.#captureFollowingChange(message);
      if (message.type === "client-discovery-request") {
        this.#declineDiscovery(message);
        continue;
      }
      if (message.type !== "response" || typeof message.requestId !== "string") continue;
      const pending = this.#pending.get(message.requestId);
      if (!pending) continue;
      this.#pending.delete(message.requestId);
      clearTimeout(pending.timer);
      pending.resolve(message);
    }
  }

  #captureFollowingChange(message: JsonRecord): void {
    if (message.method !== "thread-stream-following-changed" || message.version !== 1) return;
    const params = asRecord(message.params);
    if (!params || params.hostId !== "local" || typeof params.conversationId !== "string") return;
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(params.conversationId)) return;
    if (params.following === true) this.#activeConversationIds.add(params.conversationId);
    else if (params.following === false) this.#activeConversationIds.delete(params.conversationId);
  }

  #declineDiscovery(message: JsonRecord): void {
    const requestId = message.requestId;
    if (typeof requestId !== "string" || !requestId || this.#closed) return;
    try {
      this.socket.write(encodeIpcFrame({
        type: "client-discovery-response",
        requestId,
        response: { canHandle: false }
      }, this.#decoder.maxFrameBytes));
    } catch (error) {
      this.#failAll(normalizeIpcError(error));
      this.socket.destroy();
    }
  }

  #failRequest(requestId: string, error: Error): void {
    const pending = this.#pending.get(requestId);
    if (!pending) return;
    this.#pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  #failAll(error: Error): void {
    for (const [requestId] of this.#pending) this.#failRequest(requestId, error);
  }
}

async function waitForConnection(socket: Socket, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Codex Desktop IPC connection timed out"));
    }, timeoutMs);
    timer.unref();
    const connected = () => {
      cleanup();
      resolve();
    };
    const failed = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("connect", connected);
      socket.off("error", failed);
    };
    socket.once("connect", connected);
    socket.once("error", failed);
  });
}

async function secureLstat(targetPath: string, label: string) {
  try {
    return await lstat(targetPath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) throw new Error(`${label} is unavailable`);
    throw new Error(`${label} could not be verified`);
  }
}

function assertSuccessfulResponse(
  response: JsonRecord,
  expectedMethod: string,
  operation: string
): void {
  if (response.resultType !== "success") {
    throw new Error(`Codex Desktop rejected the ${operation}`);
  }
  if (response.method !== expectedMethod) {
    throw new Error("Codex Desktop IPC returned a mismatched response method");
  }
}

function assertConversationId(value: string): void {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(value)) {
    throw new Error("Codex task id is invalid");
  }
}

export function assertThreadSettings(value: CodexThreadSettingsPatch): void {
  const keys = Object.keys(value);
  const allowed = new Set([
    "model", "effort", "serviceTier", "approvalPolicy", "approvalsReviewer",
    "permissions", "sandboxPolicy"
  ]);
  if (!keys.length || keys.some((key) => !allowed.has(key))) {
    throw new Error("Codex task settings update is invalid");
  }
  if (value.model !== undefined && !safeToken(value.model)) {
    throw new Error("Codex model selection is invalid");
  }
  if (value.effort !== undefined && !REASONING_VALUES.has(value.effort)) {
    throw new Error("Codex reasoning selection is invalid");
  }
  if (value.serviceTier !== undefined
    && value.serviceTier !== null
    && value.serviceTier !== "priority"
    && value.serviceTier !== "flex") {
    throw new Error("Codex speed selection is invalid");
  }
  if (value.approvalPolicy !== undefined
    && value.approvalPolicy !== "untrusted"
    && value.approvalPolicy !== "on-request"
    && value.approvalPolicy !== "never") {
    throw new Error("Codex approval policy selection is invalid");
  }
  if (value.approvalsReviewer !== undefined
    && value.approvalsReviewer !== "user"
    && value.approvalsReviewer !== "auto_review"
    && value.approvalsReviewer !== "guardian_subagent") {
    throw new Error("Codex approval reviewer selection is invalid");
  }
  if (value.permissions !== undefined && !safePermissionProfile(value.permissions)) {
    throw new Error("Codex permission profile selection is invalid");
  }
  if (value.permissions !== undefined && value.sandboxPolicy !== undefined) {
    throw new Error("Codex permissions and sandbox policy cannot be combined");
  }
  if (value.sandboxPolicy !== undefined && !isSandboxPolicy(value.sandboxPolicy)) {
    throw new Error("Codex sandbox policy selection is invalid");
  }
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(value!)));
}

function safeToken(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,95}$/i.test(value);
}

function safePermissionProfile(value: string): boolean {
  return /^(?::)?[a-z0-9][a-z0-9._-]{0,95}$/i.test(value);
}

function isSandboxPolicy(value: CodexSandboxPolicy): boolean {
  if (!value || typeof value !== "object") return false;
  if (value.type === "dangerFullAccess") return Object.keys(value).length === 1;
  if (value.type === "readOnly") return typeof value.networkAccess === "boolean";
  return Array.isArray(value.writableRoots)
    && value.writableRoots.length <= 64
    && value.writableRoots.every((root) => typeof root === "string" && root.startsWith("/") && !root.includes("\0"))
    && typeof value.networkAccess === "boolean"
    && typeof value.excludeTmpdirEnvVar === "boolean"
    && typeof value.excludeSlashTmp === "boolean";
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function normalizeIpcError(error: unknown): Error {
  if (error instanceof Error && /^Codex Desktop|^Codex task/.test(error.message)) return error;
  return new Error("Codex Desktop IPC is unavailable");
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

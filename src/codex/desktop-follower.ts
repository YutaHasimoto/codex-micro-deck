import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { createConnection, type Socket } from "node:net";

import {
  assertOwnerOnlyIpcPaths,
  assertThreadSettings,
  encodeIpcFrame,
  IpcFrameDecoder,
  type CodexThreadSettingsPatch
} from "./desktop-ipc-client.js";

export const FOLLOWER_CLIENT_TYPE = "codex-micro-deck";
export const DEFAULT_FOLLOWER_REQUEST_TIMEOUT_MS = 2_500;
// Conversation snapshots include the full turn history; the active task on this
// machine already produces ~5 MB snapshots, so the cap must sit far above the
// 1 MB used by the tiny ephemeral request/response client.
export const DEFAULT_FOLLOWER_MAX_FRAME_BYTES = 64 * 1024 * 1024;
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000] as const;
const SNAPSHOT_REFRESH_MIN_INTERVAL_MS = 2_000;
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const STATE_CHANGED_VERSION = 11;

export type PendingApprovalKind = "command" | "file" | "other";

export type ApprovalRequestId = string | number;

export type PendingApproval = {
  requestId: ApprovalRequestId;
  kind: PendingApprovalKind;
  method: string;
};

export type ApprovalDecision = "accept" | "decline";

type JsonRecord = Record<string, unknown>;

type PendingRequest = {
  resolve: (message: JsonRecord) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export type CodexDesktopFollowerOptions = {
  codexRoot?: string;
  environment?: NodeJS.ProcessEnv;
  userHome?: string;
  requestTimeoutMs?: number;
  maxFrameBytes?: number;
  expectedUid?: number;
  reconnectDelaysMs?: readonly number[];
  logger?: (message: string) => void;
  /** In-memory transport seam used by tests; production always uses createConnection. */
  socketConnector?: (socketPath: string) => Socket;
  /** Test seam paired with socketConnector; production always performs lstat checks. */
  socketVerifier?: () => Promise<void>;
};

/**
 * Persistent follower of the Codex Desktop IPC router. It registers this
 * plugin as a thread-stream follower for the tracked conversations, mirrors
 * their pending server requests (command/file approvals, questions), and
 * carries live thread-settings updates and approval decisions.
 */
export class CodexDesktopFollower {
  readonly #socketPath: string;
  readonly #verify: () => Promise<void>;
  readonly #connector: (socketPath: string) => Socket;
  readonly #requestTimeoutMs: number;
  readonly #maxFrameBytes: number;
  readonly #reconnectDelaysMs: readonly number[];
  readonly #log: (message: string) => void;
  readonly #listeners = new Set<() => void>();

  #socket: Socket | undefined;
  #decoder: IpcFrameDecoder | undefined;
  #clientId: string | undefined;
  #hostId = "local";
  #running = false;
  #connectAttempt = 0;
  #retryTimer: NodeJS.Timeout | undefined;
  #connecting = false;

  #desired = new Set<string>();
  readonly #registered = new Set<string>();
  readonly #desktopFollowed = new Set<string>();
  /** Full-fidelity requests[] per conversation; Immer patch indices refer to this array. */
  readonly #rawRequests = new Map<string, unknown[]>();
  /**
   * Request ids this client has already answered. The raw mirror must stay
   * byte-identical to the owner's array so patch indices keep lining up, so
   * decided requests are hidden at the projection layer instead and pruned
   * once the owner's own patch confirms the removal.
   */
  readonly #decidedLocally = new Map<string, Set<ApprovalRequestId>>();
  readonly #pending = new Map<string, PendingApproval[]>();
  readonly #revisions = new Map<string, number>();
  readonly #lastSnapshotRequestAt = new Map<string, number>();
  readonly #requests = new Map<string, PendingRequest>();

  constructor(options: CodexDesktopFollowerOptions = {}) {
    const environment = options.environment ?? process.env;
    const userHome = options.userHome ?? homedir();
    const configuredRoot = environment.CODEX_HOME?.trim();
    const codexRoot = path.resolve(
      options.codexRoot ?? (configuredRoot || path.join(userHome, ".codex"))
    );
    const ipcDirectory = path.join(codexRoot, "ipc");
    this.#socketPath = path.join(ipcDirectory, "ipc.sock");
    const expectedUid = options.expectedUid
      ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
    this.#verify = options.socketVerifier
      ?? (() => assertOwnerOnlyIpcPaths(codexRoot, ipcDirectory, this.#socketPath, expectedUid));
    this.#connector = options.socketConnector
      ?? ((socketPath) => createConnection({ path: socketPath }));
    this.#requestTimeoutMs = boundedInteger(options.requestTimeoutMs, DEFAULT_FOLLOWER_REQUEST_TIMEOUT_MS, 100, 10_000);
    this.#maxFrameBytes = boundedInteger(options.maxFrameBytes, DEFAULT_FOLLOWER_MAX_FRAME_BYTES, 1024, 256 * 1024 * 1024);
    this.#reconnectDelaysMs = options.reconnectDelaysMs ?? RECONNECT_DELAYS_MS;
    this.#log = options.logger ?? (() => undefined);
  }

  get isConnected(): boolean {
    return this.#clientId !== undefined && this.#socket !== undefined;
  }

  get desktopFollowedIds(): string[] {
    return [...this.#desktopFollowed];
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    void this.#connect();
  }

  stop(): void {
    this.#running = false;
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    this.#teardown(false);
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Conversations whose approval state should be tracked (the six agent keys). */
  setDesiredConversations(conversationIds: readonly string[]): void {
    const next = new Set(conversationIds.filter((id) => CONVERSATION_ID_PATTERN.test(id)));
    const removed = [...this.#desired].filter((id) => !next.has(id));
    const added = [...next].filter((id) => !this.#desired.has(id));
    this.#desired = next;
    let changed = false;
    for (const id of removed) {
      if (this.#pending.delete(id)) changed = true;
      this.#rawRequests.delete(id);
      this.#decidedLocally.delete(id);
      this.#revisions.delete(id);
      this.#lastSnapshotRequestAt.delete(id);
      if (this.#registered.delete(id)) this.#sendFollowing(id, false);
    }
    if (this.isConnected) {
      for (const id of added) this.#register(id);
    }
    if (changed) this.#notify();
  }

  /** Pending approval requests per conversation; only non-empty entries. */
  pendingApprovals(): Map<string, PendingApproval[]> {
    const result = new Map<string, PendingApproval[]>();
    for (const [conversationId, requests] of this.#pending) {
      if (requests.length) result.set(conversationId, requests.map((request) => ({ ...request })));
    }
    return result;
  }

  async decideApproval(
    conversationId: string,
    approval: PendingApproval,
    decision: ApprovalDecision
  ): Promise<void> {
    assertConversationId(conversationId);
    if (approval.kind !== "command" && approval.kind !== "file") {
      throw new Error("This Codex request needs an answer inside the Codex app");
    }
    const method = approval.kind === "command"
      ? "thread-follower-command-approval-decision"
      : "thread-follower-file-approval-decision";
    const response = await this.#request(method, {
      conversationId,
      requestId: approval.requestId,
      decision
    });
    if (asRecord(response.result)?.ok !== true) {
      throw new Error("Codex Desktop did not confirm the approval decision");
    }
    // Hide the answered request immediately, but never mutate #rawRequests:
    // the owner's later patches index into its own unfiltered array.
    const decided = this.#decidedLocally.get(conversationId) ?? new Set<ApprovalRequestId>();
    decided.add(approval.requestId);
    this.#decidedLocally.set(conversationId, decided);
    this.#refreshPendingFromRaw(conversationId);
  }

  /** Live-apply thread settings to a known conversation over the persistent link. */
  async updateThreadSettings(
    conversationId: string,
    threadSettings: CodexThreadSettingsPatch
  ): Promise<void> {
    assertConversationId(conversationId);
    assertThreadSettings(threadSettings);
    const response = await this.#request("thread-follower-update-thread-settings", {
      conversationId,
      threadSettings
    });
    if (asRecord(response.result)?.ok !== true) {
      throw new Error("Codex Desktop did not confirm the task settings update");
    }
  }

  async #connect(): Promise<void> {
    if (!this.#running || this.#connecting || this.isConnected) return;
    this.#connecting = true;
    try {
      await this.#verify();
      // stop() may have run while the verifier was suspended; without this
      // check the socket below would outlive the follower as a zombie.
      if (!this.#running) return;
      const socket = this.#connector(this.#socketPath);
      const decoder = new IpcFrameDecoder(this.#maxFrameBytes);
      this.#socket = socket;
      this.#decoder = decoder;
      socket.on("data", (chunk) => this.#onData(chunk));
      socket.on("error", () => this.#handleDisconnect());
      socket.on("close", () => this.#handleDisconnect());
      await waitForConnect(socket, this.#requestTimeoutMs);
      const response = await this.#request("initialize", { clientType: FOLLOWER_CLIENT_TYPE }, {
        version: 0,
        sourceClientId: "initializing-client"
      });
      const clientId = asRecord(response.result)?.clientId;
      if (typeof clientId !== "string" || !clientId) {
        throw new Error("Codex Desktop IPC returned an invalid initialize response");
      }
      if (!this.#running) {
        this.#teardown(false);
        return;
      }
      this.#clientId = clientId;
      this.#connectAttempt = 0;
      this.#log("[follower] connected to Codex Desktop IPC");
      for (const id of this.#desired) this.#register(id);
      this.#notify();
    } catch {
      // The socket "error" listener may already have torn down and scheduled a
      // retry; scheduling again here would double-advance the backoff ladder.
      if (this.#retryTimer === undefined) this.#teardown(true);
    } finally {
      this.#connecting = false;
    }
  }

  #register(conversationId: string): void {
    this.#registered.add(conversationId);
    this.#sendFollowing(conversationId, true);
  }

  #sendFollowing(conversationId: string, following: boolean): void {
    if (!this.isConnected || !this.#clientId) return;
    this.#write({
      type: "broadcast",
      method: "thread-stream-following-changed",
      sourceClientId: this.#clientId,
      params: { hostId: this.#hostId, conversationId, following },
      version: 1
    });
  }

  #request(
    method: string,
    params: JsonRecord,
    options: { version?: number; sourceClientId?: string } = {}
  ): Promise<JsonRecord> {
    const socket = this.#socket;
    if (!socket) return Promise.reject(new Error("Codex Desktop IPC is unavailable"));
    const requestId = randomUUID();
    const version = options.version ?? 1;
    const message: JsonRecord = {
      type: "request",
      requestId,
      sourceClientId: options.sourceClientId ?? this.#clientId ?? "initializing-client",
      version,
      method,
      ...(version >= 1 ? { timeoutMs: this.#requestTimeoutMs } : {}),
      params
    };
    return new Promise<JsonRecord>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.#requests.delete(requestId)) return;
        reject(new Error("Codex Desktop IPC request timed out"));
      }, this.#requestTimeoutMs);
      timer.unref();
      this.#requests.set(requestId, { resolve, reject, timer });
      let frame: Buffer;
      try {
        frame = encodeIpcFrame(message, this.#maxFrameBytes);
      } catch (error) {
        this.#failRequest(requestId, toError(error));
        return;
      }
      socket.write(frame, (error) => {
        if (error) this.#failRequest(requestId, new Error("Codex Desktop IPC is unavailable"));
      });
    });
  }

  #write(message: JsonRecord): void {
    const socket = this.#socket;
    if (!socket) return;
    try {
      socket.write(encodeIpcFrame(message, this.#maxFrameBytes));
    } catch {
      // Dropping a broadcast is recoverable; the reconnect path re-registers.
    }
  }

  #onData(chunk: Buffer): void {
    if (!this.#decoder) return;
    let messages: unknown[];
    try {
      messages = this.#decoder.push(chunk);
    } catch {
      this.#log("[follower] IPC frame decode failed; reconnecting");
      this.#teardown(true);
      return;
    }
    for (const rawMessage of messages) {
      const message = asRecord(rawMessage);
      if (!message) continue;
      this.#handleMessage(message);
    }
  }

  #handleMessage(message: JsonRecord): void {
    if (message.type === "response" && typeof message.requestId === "string") {
      const pending = this.#requests.get(message.requestId);
      if (!pending) return;
      this.#requests.delete(message.requestId);
      clearTimeout(pending.timer);
      if (message.resultType === "success") pending.resolve(message);
      else pending.reject(new Error("Codex Desktop rejected the request"));
      return;
    }
    if (message.type === "client-discovery-request" && typeof message.requestId === "string") {
      this.#write({
        type: "client-discovery-response",
        requestId: message.requestId,
        response: { canHandle: false }
      });
      return;
    }
    if (message.type !== "broadcast") return;
    const params = asRecord(message.params);
    if (!params) return;
    if (message.method === "thread-stream-following-changed" && message.version === 1) {
      this.#handleFollowingChanged(params, message.sourceClientId);
      return;
    }
    if (message.method === "thread-stream-following-status-requested" && message.version === 1) {
      if (typeof params.hostId === "string" && params.hostId) this.#hostId = params.hostId;
      const conversationId = params.conversationId;
      if (typeof conversationId === "string" && this.#desired.has(conversationId)) {
        this.#register(conversationId);
      }
      return;
    }
    if (message.method === "thread-stream-state-changed" && message.version === STATE_CHANGED_VERSION) {
      this.#handleStateChanged(params);
    }
  }

  #handleFollowingChanged(params: JsonRecord, sourceClientId: unknown): void {
    if (typeof params.conversationId !== "string") return;
    if (!CONVERSATION_ID_PATTERN.test(params.conversationId)) return;
    if (typeof params.hostId === "string" && params.hostId) this.#hostId = params.hostId;
    if (sourceClientId === this.#clientId) return;
    if (params.following === true) this.#desktopFollowed.add(params.conversationId);
    else if (params.following === false) this.#desktopFollowed.delete(params.conversationId);
    else return;
    this.#notify();
  }

  #handleStateChanged(params: JsonRecord): void {
    const conversationId = params.conversationId;
    if (typeof conversationId !== "string" || !this.#desired.has(conversationId)) return;
    const change = asRecord(params.change);
    if (!change) return;
    if (change.type === "snapshot") {
      const state = asRecord(change.conversationState);
      const revision = change.revision;
      if (typeof revision === "number") this.#revisions.set(conversationId, revision);
      this.#rawRequests.set(conversationId, Array.isArray(state?.requests) ? [...state.requests] : []);
      this.#refreshPendingFromRaw(conversationId);
      return;
    }
    if (change.type !== "patches") return;
    const baseRevision = change.baseRevision;
    const revision = change.revision;
    const knownRevision = this.#revisions.get(conversationId);
    if (knownRevision === undefined
      || typeof baseRevision !== "number"
      || knownRevision !== baseRevision
      || typeof revision !== "number") {
      this.#refreshSnapshot(conversationId);
      return;
    }
    this.#revisions.set(conversationId, revision);
    const raw = this.#rawRequests.get(conversationId) ?? [];
    const applied = applyRequestsPatches(raw, Array.isArray(change.patches) ? change.patches : []);
    if (!applied.supported) {
      this.#refreshSnapshot(conversationId);
      return;
    }
    if (applied.touched) {
      this.#rawRequests.set(conversationId, applied.next);
      this.#refreshPendingFromRaw(conversationId);
    }
  }

  #refreshPendingFromRaw(conversationId: string): void {
    const parsed = parseRequests(this.#rawRequests.get(conversationId) ?? []);
    const decided = this.#decidedLocally.get(conversationId);
    let visible = parsed;
    if (decided) {
      // Once the owner's own state no longer contains a decided id, the
      // decision has been confirmed and the local suppression can be dropped.
      const present = new Set(parsed.map((request) => request.requestId));
      for (const requestId of [...decided]) {
        if (!present.has(requestId)) decided.delete(requestId);
      }
      if (decided.size === 0) this.#decidedLocally.delete(conversationId);
      else visible = parsed.filter((request) => !decided.has(request.requestId));
    }
    const previous = this.#pending.get(conversationId) ?? [];
    if (visible.length) this.#pending.set(conversationId, visible);
    else this.#pending.delete(conversationId);
    if (!sameRequests(previous, visible)) this.#notify();
  }

  #refreshSnapshot(conversationId: string): void {
    const now = Date.now();
    const last = this.#lastSnapshotRequestAt.get(conversationId) ?? 0;
    if (now - last < SNAPSHOT_REFRESH_MIN_INTERVAL_MS) return;
    this.#lastSnapshotRequestAt.set(conversationId, now);
    // Re-affirming the follower registration makes the owner push a fresh
    // targeted snapshot — the same verified mechanism used on (re)connect.
    this.#sendFollowing(conversationId, true);
  }

  #handleDisconnect(): void {
    if (!this.#socket) return;
    this.#teardown(true);
  }

  #teardown(scheduleRetry: boolean): void {
    const hadState = this.isConnected || this.#pending.size > 0 || this.#desktopFollowed.size > 0;
    const socket = this.#socket;
    this.#socket = undefined;
    this.#decoder = undefined;
    this.#clientId = undefined;
    socket?.removeAllListeners();
    // destroy() can still emit a late "error"; without a listener that would
    // crash the plugin process.
    socket?.on("error", () => undefined);
    socket?.destroy();
    for (const requestId of [...this.#requests.keys()]) {
      this.#failRequest(requestId, new Error("Codex Desktop IPC connection closed"));
    }
    this.#registered.clear();
    this.#desktopFollowed.clear();
    // Without a live stream we cannot claim any approval is still pending.
    this.#pending.clear();
    this.#rawRequests.clear();
    this.#decidedLocally.clear();
    this.#revisions.clear();
    if (hadState) this.#notify();
    // An already-scheduled retry stays authoritative: rescheduling here would
    // double-advance the backoff ladder when error + catch both tear down.
    if (!scheduleRetry || !this.#running || this.#retryTimer) return;
    const delayIndex = Math.min(this.#connectAttempt, this.#reconnectDelaysMs.length - 1);
    const delay = this.#reconnectDelaysMs[delayIndex] ?? 10_000;
    this.#connectAttempt += 1;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      void this.#connect();
    }, delay);
    this.#retryTimer.unref();
  }

  #failRequest(requestId: string, error: Error): void {
    const pending = this.#requests.get(requestId);
    if (!pending) return;
    this.#requests.delete(requestId);
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  #notify(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        // Listeners must not break the IPC pump.
      }
    }
  }
}

const APPROVAL_REQUEST_KINDS: Record<string, PendingApprovalKind> = {
  "item/commandExecution/requestApproval": "command",
  "item/fileChange/requestApproval": "file",
  "item/permissions/requestApproval": "other",
  "item/tool/requestUserInput": "other",
  "item/tool/requestOptionPicker": "other",
  "item/tool/requestSetupCodexContextPicker": "other",
  "mcpServer/elicitation/request": "other"
};

export function parseRequests(value: unknown): PendingApproval[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): PendingApproval[] => {
    const record = asRecord(entry);
    if (!record) return [];
    const id = record.id;
    const method = record.method;
    if (!isApprovalRequestId(id) || typeof method !== "string") return [];
    const kind = APPROVAL_REQUEST_KINDS[method];
    if (!kind) return [];
    return [{ requestId: id, kind, method }];
  });
}

function isApprovalRequestId(value: unknown): value is ApprovalRequestId {
  return typeof value === "string"
    ? value.length > 0
    : typeof value === "number" && Number.isSafeInteger(value);
}

type RequestsPatchResult = {
  next: unknown[];
  touched: boolean;
  supported: boolean;
};

/**
 * Applies the `requests`-array slice of an Immer patch broadcast against the
 * raw requests array. Patch indices refer to the full requests array (which
 * can contain non-approval entries), so callers must feed the raw array, not
 * a filtered view. Unsupported shapes report supported:false so the caller
 * re-syncs from a fresh snapshot instead of guessing.
 */
export function applyRequestsPatches(
  current: readonly unknown[],
  patches: readonly unknown[]
): RequestsPatchResult {
  const raw: unknown[] = current.map((entry) => structuredCloneSafe(entry));
  let touched = false;
  for (const patchValue of patches) {
    const patch = asRecord(patchValue);
    if (!patch || !Array.isArray(patch.path)) continue;
    const patchPath = patch.path as (string | number)[];
    if (patchPath.length === 0) {
      // Whole-state replacement.
      if (patch.op !== "replace") return { next: [...current], touched: false, supported: false };
      const record = asRecord(patch.value);
      raw.length = 0;
      if (record && Array.isArray(record.requests)) raw.push(...record.requests);
      touched = true;
      continue;
    }
    if (patchPath[0] !== "requests") continue;
    const rest = patchPath.slice(1);
    if (rest.length === 0) {
      raw.length = 0;
      if (patch.op !== "remove" && Array.isArray(patch.value)) raw.push(...patch.value);
      touched = true;
      continue;
    }
    if (!applyPatchWithin(raw, rest, patch.op, patch.value)) {
      return { next: [...current], touched: false, supported: false };
    }
    touched = true;
  }
  return { next: raw, touched, supported: true };
}

/** Generic Immer-style patch application inside the requests array. */
function applyPatchWithin(
  root: unknown[],
  relativePath: readonly (string | number)[],
  op: unknown,
  value: unknown
): boolean {
  if (op !== "add" && op !== "replace" && op !== "remove") return false;
  let container: unknown = root;
  for (let index = 0; index < relativePath.length - 1; index += 1) {
    const key = relativePath[index]!;
    if (Array.isArray(container)) {
      const arrayIndex = toArrayIndex(key);
      if (arrayIndex === undefined || arrayIndex >= container.length) return false;
      container = container[arrayIndex];
    } else {
      const record = asRecord(container);
      if (!record) return false;
      container = record[String(key)];
    }
  }
  const leaf = relativePath[relativePath.length - 1]!;
  if (Array.isArray(container)) {
    if (leaf === "length") {
      if (op !== "replace" || typeof value !== "number" || !Number.isInteger(value) || value < 0) return false;
      container.length = Math.min(container.length, value);
      return true;
    }
    const arrayIndex = toArrayIndex(leaf);
    if (arrayIndex === undefined) return false;
    if (op === "add") container.splice(arrayIndex, 0, value);
    else if (op === "replace") container[arrayIndex] = value;
    else container.splice(arrayIndex, 1);
    return true;
  }
  const record = asRecord(container);
  if (!record) return false;
  const key = String(leaf);
  if (op === "remove") delete record[key];
  else record[key] = value;
  return true;
}

function toArrayIndex(key: string | number): number | undefined {
  const index = typeof key === "number" ? key : Number.parseInt(key, 10);
  return Number.isInteger(index) && index >= 0 ? index : undefined;
}

function structuredCloneSafe(value: unknown): unknown {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

function sameRequests(left: readonly PendingApproval[], right: readonly PendingApproval[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((request, index) => request.requestId === right[index]?.requestId
    && request.kind === right[index]?.kind);
}

function assertConversationId(value: string): void {
  if (!CONVERSATION_ID_PATTERN.test(value)) throw new Error("Codex task id is invalid");
}

async function waitForConnect(socket: Socket, timeoutMs: number): Promise<void> {
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

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(value!)));
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Codex Desktop IPC is unavailable");
}

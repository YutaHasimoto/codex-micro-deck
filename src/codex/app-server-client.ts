import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { createInterface, type Interface } from "node:readline";

import type { AgentPhase, ThreadSnapshot } from "../types.js";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
};

type AppServerResponse = {
  id?: string | number;
  result?: unknown;
  error?: { code?: number; message?: string };
};

type AppServerThread = {
  id?: unknown;
  name?: unknown;
  preview?: unknown;
  updatedAt?: unknown;
  status?: unknown;
};

export type AppServerLifecycle = "stopped" | "starting" | "running" | "stopping" | "failed";
export const DEFAULT_CODEX_CLI_CANDIDATES = [
  "/Applications/ChatGPT.app/Contents/Resources/codex",
  "/Applications/Codex.app/Contents/Resources/codex"
] as const;
// The local provider already selects the six user-owned tasks. Ask App Server
// for a wider metadata window so unrelated VS Code threads cannot displace one
// of those six IDs before its human-facing name is merged.
export const THREAD_NAME_LIST_LIMIT = 100;

/**
 * Optional, isolated Codex App Server transport.
 *
 * It starts one stdio child only when explicitly enabled, never uses the daemon,
 * and always terminates that child when disabled or when the plugin stops.
 * Settings persistence resumes each exact tracked thread in this isolated
 * child, then queues `thread/settings/update` for that same thread's next turn.
 * The Desktop follower may additionally hot-apply the currently followed
 * thread, but it is not the persistence authority. Neither path mutates a turn
 * already running and must not be described as a mid-turn hot reload.
 */
export class CodexAppServerClient {
  #child: ChildProcessWithoutNullStreams | undefined;
  #reader: Interface | undefined;
  #lifecycle: AppServerLifecycle = "stopped";
  #nextId = 1;
  readonly #pending = new Map<string, PendingRequest>();

  get lifecycle(): AppServerLifecycle { return this.#lifecycle; }

  async start(
    cliPath: string,
    options: { experimentalApi?: boolean } = {}
  ): Promise<void> {
    if (this.#lifecycle === "running") return;
    if (this.#lifecycle === "starting") throw new Error("Codex App Server is already starting");
    await validateCliPath(cliPath);
    this.#lifecycle = "starting";

    const child = spawn(cliPath, ["app-server", "--listen", "stdio://"], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env }
    });
    this.#child = child;
    this.#reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.#reader.on("line", (line) => this.#handleLine(line));
    child.stderr.on("data", () => {
      // stderr can include user paths; intentionally avoid logging its contents.
    });
    child.once("error", (error) => this.#handleTermination(error));
    child.once("exit", (code, signal) => {
      if (this.#lifecycle !== "stopping" && this.#lifecycle !== "stopped") {
        this.#handleTermination(new Error(`Codex App Server exited (${code ?? signal ?? "unknown"})`));
      }
    });

    try {
      await this.request("initialize", {
          clientInfo: {
            name: "codex-shortcuts-plugin",
            title: "Codex Shortcuts Plugin",
            version: "0.4.13"
          },
        capabilities: {
          experimentalApi: options.experimentalApi === true,
          requestAttestation: false,
          optOutNotificationMethods: [
            "agent/message/delta", "item/commandExecution/outputDelta", "item/fileChange/outputDelta"
          ]
        }
      }, 5000);
      this.#send({ method: "initialized" });
      this.#lifecycle = "running";
    } catch (error) {
      this.#lifecycle = "failed";
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    const child = this.#child;
    if (!child) {
      this.#lifecycle = "stopped";
      return;
    }
    this.#lifecycle = "stopping";
    this.#reader?.close();
    this.#reader = undefined;
    this.#rejectPending(new Error("Codex App Server stopped"));

    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise<void>((resolve) => child.once("exit", () => resolve())),
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 800);
          timer.unref();
        })
      ]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    this.#child = undefined;
    this.#lifecycle = "stopped";
  }

  async pollRecentThreads(): Promise<ThreadSnapshot[]> {
    if (this.#lifecycle !== "running") return [];
    const result = await this.request("thread/list", {
      limit: THREAD_NAME_LIST_LIMIT,
      archived: false,
      sortKey: "recency_at",
      sortDirection: "desc",
      useStateDbOnly: true,
      sourceKinds: ["vscode"]
    }, 2500) as { data?: AppServerThread[] };
    if (!Array.isArray(result?.data)) return [];
    return result.data.flatMap((thread): ThreadSnapshot[] => {
      if (typeof thread.id !== "string") return [];
      // `preview` is usually the first user message, not the task name. Keep
      // it out of this name-oriented projection so callers can safely merge
      // only a real App Server `thread.name` over local SQLite state.
      const title = typeof thread.name === "string" && thread.name.trim()
        ? thread.name.trim()
        : "Untitled";
      const seconds = typeof thread.updatedAt === "number" ? thread.updatedAt : 0;
      return [{
        id: thread.id,
        title,
        updatedAt: seconds * 1000,
        phase: phaseFromAppServer(thread.status)
      }];
    });
  }

  request(method: string, params: unknown, timeoutMs = 3000): Promise<unknown> {
    if (!this.#child || (this.#lifecycle !== "starting" && this.#lifecycle !== "running")) {
      return Promise.reject(new Error("Codex App Server is not running"));
    }
    const id = String(this.#nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Codex App Server request timed out: ${method}`));
      }, timeoutMs);
      timer.unref();
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  #send(message: Record<string, unknown>): void {
    const stdin = this.#child?.stdin;
    if (!stdin || stdin.destroyed) throw new Error("Codex App Server stdin is unavailable");
    stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleLine(line: string): void {
    let message: AppServerResponse;
    try { message = JSON.parse(line) as AppServerResponse; } catch { return; }
    if (message.id === undefined) return;
    const id = String(message.id);
    const pending = this.#pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pending.delete(id);
    if (message.error) {
      pending.reject(new Error(message.error.message || `App Server error ${message.error.code ?? ""}`));
    } else {
      pending.resolve(message.result);
    }
  }

  #handleTermination(error: Error): void {
    this.#reader?.close();
    this.#reader = undefined;
    this.#child = undefined;
    this.#lifecycle = "failed";
    this.#rejectPending(error);
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

export async function resolveCodexCliPath(
  candidates: readonly string[] = DEFAULT_CODEX_CLI_CANDIDATES,
  canExecute: (candidate: string) => Promise<boolean> = async (candidate) => {
    try {
      await access(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
): Promise<string> {
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate)
      && path.basename(candidate) === "codex"
      && await canExecute(candidate)) {
      return candidate;
    }
  }
  throw new Error("Codex Desktop bundled CLI was not found");
}

async function validateCliPath(cliPath: string): Promise<void> {
  if (!path.isAbsolute(cliPath) || path.basename(cliPath) !== "codex") {
    throw new Error("Codex CLI path must be an absolute path ending in /codex");
  }
  await access(cliPath, constants.X_OK);
}

function phaseFromAppServer(status: unknown): AgentPhase {
  if (!status || typeof status !== "object") return "idle";
  const value = status as { type?: unknown; activeFlags?: unknown };
  if (value.type === "systemError") return "error";
  if (value.type === "active") {
    return Array.isArray(value.activeFlags) && value.activeFlags.includes("waitingOnApproval")
      ? "approval" : "working";
  }
  return "idle";
}

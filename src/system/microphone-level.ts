import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import { safeActionError } from "../core/errors.js";

export const MICROPHONE_LEVEL_RETRY_MS = 5_000;

type SpawnMeter = (executable: string) => ChildProcess;

type MicrophoneLevelMonitorOptions = {
  executable?: string;
  logger?: (message: string) => void;
  onPermissionDenied?: () => void;
  now?: () => number;
  spawnMeter?: SpawnMeter;
};

export class MicrophoneLevelMonitor {
  readonly #executable: string;
  readonly #logger: (message: string) => void;
  readonly #onPermissionDenied: () => void;
  readonly #now: () => number;
  readonly #spawnMeter: SpawnMeter;
  #child: ChildProcess | undefined;
  #level = 0;
  #stdoutRemainder = "";
  #stderr = "";
  #retryAfter = 0;
  #permissionDeniedForSession = false;

  constructor(options: MicrophoneLevelMonitorOptions = {}) {
    this.#executable = options.executable
      ?? fileURLToPath(new URL("./mic-level-meter", import.meta.url));
    this.#logger = options.logger ?? (() => undefined);
    this.#onPermissionDenied = options.onPermissionDenied ?? (() => undefined);
    this.#now = options.now ?? Date.now;
    this.#spawnMeter = options.spawnMeter ?? ((executable) => spawn(executable, [], {
      stdio: ["ignore", "pipe", "pipe"]
    }));
  }

  get level(): number {
    return this.#level;
  }

  start(): void {
    if (this.#child
      || this.#permissionDeniedForSession
      || this.#now() < this.#retryAfter) return;

    let child: ChildProcess;
    try {
      child = this.#spawnMeter(this.#executable);
    } catch (error) {
      this.#scheduleRetry(`spawn-failed: ${safeActionError(error)}`);
      return;
    }

    this.#child = child;
    this.#stdoutRemainder = "";
    this.#stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string | Buffer) => {
      if (this.#child !== child) return;
      const parsed = consumeMicrophoneLevelOutput(this.#stdoutRemainder, String(chunk));
      this.#stdoutRemainder = parsed.remainder;
      for (const level of parsed.levels) {
        this.#level = smoothMicrophoneLevel(this.#level, level);
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string | Buffer) => {
      if (this.#child !== child || this.#stderr.length >= 160) return;
      this.#stderr = (this.#stderr + String(chunk)).slice(0, 160);
    });
    child.once("error", (error) => {
      if (this.#child !== child) return;
      this.#child = undefined;
      this.#level = 0;
      this.#scheduleRetry(`spawn-failed: ${safeActionError(error)}`);
    });
    child.once("close", (code) => {
      if (this.#child !== child) return;
      this.#child = undefined;
      this.#level = 0;
      const classification = classifyMicrophoneMeterFailure(code, this.#stderr);
      if (classification === "microphone-permission-denied") {
        this.#permissionDeniedForSession = true;
        this.#logger(`[mic-meter] ${classification}`);
        this.#onPermissionDenied();
        return;
      }
      this.#scheduleRetry(classification);
    });
  }

  stop(): void {
    const child = this.#child;
    this.#child = undefined;
    this.#level = 0;
    this.#stdoutRemainder = "";
    this.#stderr = "";
    this.#retryAfter = 0;
    this.#permissionDeniedForSession = false;
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }

  #scheduleRetry(reason: string): void {
    this.#retryAfter = this.#now() + MICROPHONE_LEVEL_RETRY_MS;
    this.#logger(`[mic-meter] ${reason}`);
  }
}

export function consumeMicrophoneLevelOutput(
  remainder: string,
  chunk: string
): { remainder: string; levels: number[] } {
  const lines = `${remainder}${chunk}`.split(/\r?\n/);
  const nextRemainder = lines.pop() ?? "";
  const levels: number[] = [];
  for (const line of lines) {
    const value = Number(line.trim());
    if (!Number.isFinite(value)) continue;
    levels.push(Math.max(0, Math.min(1, value)));
  }
  return {
    remainder: nextRemainder.slice(-32),
    levels
  };
}

export function smoothMicrophoneLevel(previous: number, next: number): number {
  const safePrevious = Number.isFinite(previous) ? Math.max(0, Math.min(1, previous)) : 0;
  const safeNext = Number.isFinite(next) ? Math.max(0, Math.min(1, next)) : 0;
  const weight = safeNext >= safePrevious ? 0.72 : 0.3;
  return safePrevious + (safeNext - safePrevious) * weight;
}

export function classifyMicrophoneMeterFailure(code: number | null, stderr: string): string {
  const firstLine = stderr.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (firstLine.includes("permission-denied")) return "microphone-permission-denied";
  if (firstLine.includes("no-input-device")) return "microphone-input-unavailable";
  if (firstLine.includes("engine-start-failed")) return "audio-engine-start-failed";
  return `meter-exited: code=${code ?? -1}`;
}

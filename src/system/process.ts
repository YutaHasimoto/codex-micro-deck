import { spawn } from "node:child_process";

export type ProcessResult = { exitCode: number; stdout: string; stderr: string };

const TERMINATION_GRACE_MS = 250;

export function runProcess(
  command: string,
  args: readonly string[],
  options: { timeoutMs?: number; maxOutputBytes?: number } = {}
): Promise<ProcessResult> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const maxOutputBytes = options.maxOutputBytes ?? 256 * 1024;

  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let settled = false;
    let timedOut = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const append = (
      current: Buffer<ArrayBufferLike>,
      chunk: Buffer<ArrayBufferLike>
    ): Buffer<ArrayBufferLike> => {
      if (current.length >= maxOutputBytes) return current;
      return Buffer.concat([current, chunk.subarray(0, maxOutputBytes - current.length)]);
    };
    const clearTimers = (): void => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
    };
    const finish = (complete: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      complete();
    };
    const killIfRunning = (signal: NodeJS.Signals): void => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        child.kill(signal);
      } catch {
        // A close/error event remains authoritative if the process exited
        // between the state check and kill.
      }
    };
    child.stdout.on("data", (chunk: Buffer<ArrayBufferLike>) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer<ArrayBufferLike>) => { stderr = append(stderr, chunk); });
    child.once("error", (error) => finish(() => reject(error)));
    timeoutTimer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      killIfRunning("SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (settled) return;
        killIfRunning("SIGKILL");
      }, TERMINATION_GRACE_MS);
      forceKillTimer.unref();
    }, timeoutMs);
    timeoutTimer.unref();
    child.once("close", (code) => {
      finish(() => resolve({
        exitCode: timedOut ? -1 : code ?? -1,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8")
      }));
    });
  });
}

import { spawn } from "node:child_process";

export type ProcessResult = { exitCode: number; stdout: string; stderr: string };

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
    const append = (
      current: Buffer<ArrayBufferLike>,
      chunk: Buffer<ArrayBufferLike>
    ): Buffer<ArrayBufferLike> => {
      if (current.length >= maxOutputBytes) return current;
      return Buffer.concat([current, chunk.subarray(0, maxOutputBytes - current.length)]);
    };
    child.stdout.on("data", (chunk: Buffer<ArrayBufferLike>) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer<ArrayBufferLike>) => { stderr = append(stderr, chunk); });
    child.once("error", reject);
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    timer.unref();
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? -1,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8")
      });
    });
  });
}

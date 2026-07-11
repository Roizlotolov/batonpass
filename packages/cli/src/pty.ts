import * as pty from 'node-pty';

export interface PtyProcess {
  pid: number;
  write(data: string): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  kill(signal?: string): void;
  resize(cols: number, rows: number): void;
}

export type PtySpawnFn = (cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }) => PtyProcess;

export const spawnPty: PtySpawnFn = (cmd, args, opts) => {
  const p = pty.spawn(cmd, args, {
    name: 'xterm-color',
    cols: 120,
    rows: 30,
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env } as { [key: string]: string },
  });
  return {
    pid: p.pid,
    write: (data: string) => p.write(data),
    onData: (cb) => {
      p.onData(cb);
    },
    onExit: (cb) => {
      p.onExit((e) => cb({ exitCode: e.exitCode, signal: e.signal }));
    },
    kill: (signal?: string) => p.kill(signal),
    resize: (cols: number, rows: number) => p.resize(cols, rows),
  };
};

/** Bounded rolling buffer of recent PTY output, used for sentinel detection and idle heuristics. */
export class RingBuffer {
  private buf = '';
  constructor(private readonly maxLen = 200_000) {}

  append(chunk: string): void {
    this.buf += chunk;
    if (this.buf.length > this.maxLen) this.buf = this.buf.slice(this.buf.length - this.maxLen);
  }

  get text(): string {
    return this.buf;
  }

  includes(sentinel: string): boolean {
    return this.buf.includes(sentinel);
  }

  clear(): void {
    this.buf = '';
  }
}

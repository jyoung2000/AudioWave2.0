import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface RotationOptions {
  dir: string;
  baseName: string;
  maxBytes: number;
  keep: number;
}

/** Size-rotated log file writer: `<base>.log`, `<base>.1.log` … `<base>.<keep-1>.log`. Synchronous appends keep ordering simple; volume is low. */
export class RotatingFile {
  private size = 0;
  private readonly path: string;
  private disabled = false;

  constructor(private readonly options: RotationOptions) {
    this.path = join(options.dir, `${options.baseName}.log`);
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      this.size = existsSync(this.path) ? statSync(this.path).size : 0;
    } catch {
      this.disabled = true;
    }
  }

  write(line: string): void {
    if (this.disabled) return;
    try {
      const bytes = Buffer.byteLength(line);
      if (this.size + bytes > this.options.maxBytes && this.size > 0) this.rotate();
      appendFileSync(this.path, line);
      this.size += bytes;
    } catch {
      this.disabled = true;
    }
  }

  private rotate(): void {
    for (let i = this.options.keep - 1; i >= 1; i -= 1) {
      const from = i === 1 ? this.path : join(this.options.dir, `${this.options.baseName}.${i - 1}.log`);
      const to = join(this.options.dir, `${this.options.baseName}.${i}.log`);
      if (existsSync(to) && i === this.options.keep - 1) unlinkSync(to);
      if (existsSync(from)) renameSync(from, to);
    }
    this.size = 0;
  }

  get currentPath(): string {
    return this.path;
  }
}

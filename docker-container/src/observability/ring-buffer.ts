export interface LogLine {
  time: string;
  level: string;
  msg: string;
  correlationId: string | null;
  module: string | null;
  data: Record<string, unknown>;
}

/** Fixed-capacity ring of recent log lines for `GET /logs` and the diagnostics bundle. */
export class RingBuffer<T> {
  private readonly items: (T | undefined)[];
  private head = 0;
  private count = 0;

  constructor(readonly capacity: number) {
    this.items = new Array<T | undefined>(capacity);
  }

  push(item: T): void {
    this.items[(this.head + this.count) % this.capacity] = item;
    if (this.count < this.capacity) this.count += 1;
    else this.head = (this.head + 1) % this.capacity;
  }

  toArray(): T[] {
    const out: T[] = [];
    for (let i = 0; i < this.count; i += 1) out.push(this.items[(this.head + i) % this.capacity] as T);
    return out;
  }

  get size(): number {
    return this.count;
  }
}

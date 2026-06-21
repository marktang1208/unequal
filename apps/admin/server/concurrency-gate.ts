/**
 * CP-7-C: ConcurrencyGate — 3 个 semaphore 限流器
 *
 * 3 个独立 semaphore：
 *   - parserSem: max 1 (mineru 1 本/次)
 *   - embedSem: max 3 (OMLX 限流)
 *   - pushSem: max 5 (CloudBase HTTP)
 *
 * 轻量实现：Semaphore class + 3 个实例
 */

class Semaphore {
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(public readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
  }

  release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }

  get activeCount(): number {
    return this.active;
  }

  get queueLength(): number {
    return this.queue.length;
  }
}

export interface GateStats {
  parser: { active: number; max: number; queue: number };
  embed: { active: number; max: number; queue: number };
  push: { active: number; max: number; queue: number };
}

export class ConcurrencyGate {
  readonly parserSem: Semaphore;
  readonly embedSem: Semaphore;
  readonly pushSem: Semaphore;

  constructor(opts?: { parserMax?: number; embedMax?: number; pushMax?: number }) {
    this.parserSem = new Semaphore(opts?.parserMax ?? 1);
    this.embedSem = new Semaphore(opts?.embedMax ?? 3);
    this.pushSem = new Semaphore(opts?.pushMax ?? 5);
  }

  async parser<T>(fn: () => Promise<T>): Promise<T> {
    await this.parserSem.acquire();
    try {
      return await fn();
    } finally {
      this.parserSem.release();
    }
  }

  async embed<T>(fn: () => Promise<T>): Promise<T> {
    await this.embedSem.acquire();
    try {
      return await fn();
    } finally {
      this.embedSem.release();
    }
  }

  async push<T>(fn: () => Promise<T>): Promise<T> {
    await this.pushSem.acquire();
    try {
      return await fn();
    } finally {
      this.pushSem.release();
    }
  }

  getStats(): GateStats {
    return {
      parser: { active: this.parserSem.activeCount, max: this.parserSem.max, queue: this.parserSem.queueLength },
      embed: { active: this.embedSem.activeCount, max: this.embedSem.max, queue: this.embedSem.queueLength },
      push: { active: this.pushSem.activeCount, max: this.pushSem.max, queue: this.pushSem.queueLength },
    };
  }
}

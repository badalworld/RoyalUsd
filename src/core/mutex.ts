export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(work: () => Promise<T> | T): Promise<T> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const previous = this.tail;
    this.tail = previous.then(() => gate, () => gate);
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
}

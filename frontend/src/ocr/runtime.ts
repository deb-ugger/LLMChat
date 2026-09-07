/** Own one lazily initialized engine and release it after its active work settles. */
export class OcrRuntime<T> {
  private resource: Promise<T> | null = null;
  private tasks = new Set<Promise<unknown>>();
  private controller = new AbortController();
  private closing: Promise<void> | null = null;

  constructor(
    private readonly initialize: () => Promise<T>,
    private readonly release: (value: T) => Promise<unknown>,
  ) {}

  run<R>(work: (value: T, signal: AbortSignal) => Promise<R>): Promise<R> {
    if (this.controller.signal.aborted)
      return Promise.reject(new Error("识别已取消"));
    if (!this.resource) {
      this.resource = this.initialize().catch((error) => {
        this.resource = null;
        throw error;
      });
    }
    const task = this.resource.then(async (value) => {
      this.checkCancelled();
      const result = await work(value, this.controller.signal);
      this.checkCancelled();
      return result;
    });
    this.tasks.add(task);
    void task.then(() => this.tasks.delete(task), () => this.tasks.delete(task));
    return task;
  }

  private checkCancelled() {
    if (this.controller.signal.aborted) throw new Error("识别已取消");
  }

  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    this.controller.abort();
    const pending = this.resource;
    this.closing = (async () => {
      await Promise.allSettled([...this.tasks]);
      if (!pending) return;
      // Failed initialization has no resource to release.
      const result = await Promise.allSettled([pending]);
      if (result[0].status === "fulfilled") await this.release(result[0].value);
      this.resource = null;
    })();
    return this.closing;
  }
}

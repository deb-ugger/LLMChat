/** Cancel superseded work without letting its completion remove a newer task. */
export class TaskScope {
  private tasks = new Map<string, AbortController>();

  start(key: string): AbortController {
    this.cancel(key);
    const controller = new AbortController();
    this.tasks.set(key, controller);
    return controller;
  }

  finish(key: string, controller: AbortController): void {
    if (this.tasks.get(key) === controller) this.tasks.delete(key);
  }

  isCurrent(key: string, controller: AbortController): boolean {
    return this.tasks.get(key) === controller;
  }

  cancel(key: string): void {
    this.tasks.get(key)?.abort();
    this.tasks.delete(key);
  }

  cancelAll(): void {
    for (const controller of this.tasks.values()) controller.abort();
    this.tasks.clear();
  }

  get active(): boolean {
    return this.tasks.size > 0;
  }
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("操作已取消", "AbortError");
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (
    error.name === "AbortError" || (error as Error & { code?: string }).code === "CANCELLED"
  );
}

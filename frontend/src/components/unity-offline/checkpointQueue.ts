type PendingWrite<T> = { stage: string; job: T };

export function createCheckpointQueue<T>() {
  const taskWrites = { current: Promise.resolve() as Promise<unknown> };
  const projectWrites = { current: Promise.resolve() as Promise<unknown> };
  let waitingWrite: PendingWrite<T> | null = null;

  function queueTaskWrite(stage: string, job: T, running: boolean, save: (value: T) => Promise<unknown>, onError: (error: unknown) => void) {
    const waiting = waitingWrite;
    if (running && waiting?.stage === stage) {
      waiting.job = job;
      return;
    }
    const write = { stage, job };
    waitingWrite = write;
    taskWrites.current = taskWrites.current.catch(() => {}).then(() => {
      if (waitingWrite === write) waitingWrite = null;
      return save(write.job);
    });
    void taskWrites.current.catch(onError);
  }

  function queueProjectWrite<Result>(job: () => Promise<Result>): Promise<Result> {
    const next = projectWrites.current.catch(() => {}).then(job); projectWrites.current = next; return next;
  }

  return { taskWrites, projectWrites, queueTaskWrite, queueProjectWrite };
}

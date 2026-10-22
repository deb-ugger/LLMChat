import { useCallback, useEffect, useRef, useState } from "react";
import { api, type OcrMode, type OcrModelStatus } from "../api";
import { toFriendlyError } from "../friendlyError";

/** Model status and download polling shared by settings and image OCR. */
export function useOcrModels() {
  const [status, setStatus] = useState<OcrModelStatus | null>(null);
  const [error, setError] = useState<{ source: "status" | "download"; message: string } | null>(null);
  const mounted = useRef(false);
  const revision = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const operation = useRef(false);

  const publish = useCallback((next: OcrModelStatus) => {
    revision.current += 1;
    if (mounted.current) {
      setStatus(next);
      setError(null);
    }
    return next;
  }, []);

  const refresh = useCallback(async () => {
    const request = ++revision.current;
    try {
      const next = await api.getOcrModelStatus();
      if (mounted.current && request === revision.current) {
        setStatus(next);
        // Status polling succeeding does not mean a failed download recovered.
        setError(previous => previous?.source === "download" ? previous : null);
      }
      return next;
    } catch (cause) {
      if (mounted.current && request === revision.current)
        setError({ source: "status", message: toFriendlyError(cause, "模型状态读取失败") });
      return null;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      revision.current += 1;
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, [refresh]);

  const ensure = useCallback(async (mode: OcrMode) => {
    if (operation.current) throw new Error("模型操作正在进行，请稍候");
    operation.current = true;
    if (mounted.current) setError(null);
    let polling = true;
    const poll = async () => {
      await refresh();
      if (polling && mounted.current) timer.current = setTimeout(poll, 350);
    };
    void poll();
    try {
      return publish(await api.ensureOcrMode(mode));
    } catch (cause) {
      if (mounted.current)
        setError({ source: "download", message: toFriendlyError(cause, "模型下载失败，请检查网络和代理设置后重试") });
      throw cause;
    } finally {
      polling = false;
      operation.current = false;
      revision.current += 1;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    }
  }, [publish, refresh]);

  const remove = useCallback(async (mode: Exclude<OcrMode, "fast">) => {
    if (operation.current) throw new Error("模型操作正在进行，请稍候");
    operation.current = true;
    try {
      return publish(await api.removeOcrMode(mode));
    } finally {
      operation.current = false;
    }
  }, [publish]);

  return { status, error: error?.message ?? null, refresh, ensure, remove };
}

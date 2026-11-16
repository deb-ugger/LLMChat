import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

type Notice = { message: string; kind: "success" | "error" };
const noticeEvent = "llmchat:notice";

export function showAppNotice(message: string, kind: Notice["kind"] = "success") {
  window.dispatchEvent(new CustomEvent<Notice>(noticeEvent, { detail: { message, kind } }));
}

export function AppNotice() {
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => {
    let timer: number | undefined;
    const receive = (event: Event) => {
      const next = (event as CustomEvent<Notice>).detail;
      window.clearTimeout(timer);
      setNotice(next);
      timer = window.setTimeout(() => setNotice(null), next.kind === "error" ? 5200 : 2800);
    };
    window.addEventListener(noticeEvent, receive);
    return () => {
      window.removeEventListener(noticeEvent, receive);
      window.clearTimeout(timer);
    };
  }, []);

  if (!notice) return null;
  const failed = notice.kind === "error";
  return createPortal(
    <div className={`settings-toast app-notice ${failed ? "is-fail" : "is-ok"}`} role={failed ? "alert" : "status"}>
      <span className="settings-toast-mark" aria-hidden="true" />
      <div>{notice.message}</div>
    </div>,
    document.body,
  );
}

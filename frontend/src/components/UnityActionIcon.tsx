export function UnityActionIcon({ kind }: { kind: "save" | "run" | "remove" | "settings" | "check" | "cancel" }) {
  return <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === "save" ? <><path d="M4 3h13l4 4v14H3V3h1Z"/><path d="M7 3v6h10V3M7 21v-8h10v8"/></>
      : kind === "run" ? <><path d="m5 4 15 8-15 8V4Z"/><path d="M22 5v14"/></>
      : kind === "remove" ? <><path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6"/></>
      : kind === "check" ? <path d="m4 12 5 5L20 6"/>
      : kind === "cancel" ? <path d="m6 6 12 12M18 6 6 18"/>
      : <><path d="M10 2h4l.7 3 2 .9 2.7-1.2 2 3.4-2.1 2.1v2.4l2.1 2.1-2 3.4-2.7-1.2-2 .9-.7 3h-4l-.7-3-2-.9-2.7 1.2-2-3.4 2.1-2.1v-2.4L2.6 8.1l2-3.4 2.7 1.2 2-.9.7-3Z"/><circle cx="12" cy="11.5" r="3.2"/></>}
  </svg>;
}

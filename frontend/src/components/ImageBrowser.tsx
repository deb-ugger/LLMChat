import type { ComponentPropsWithRef, KeyboardEventHandler, PointerEventHandler, ReactNode } from "react";
import "./imageBrowser.css";

const previewPane = "[data-game-image-preview-pane]";
const controls = "button, a, input, textarea, select, [contenteditable]";

/** Route browsing keys only after the preview's editor has had a chance to consume them. */
export function routeImageBrowserKey(event: Parameters<KeyboardEventHandler<HTMLDivElement>>[0], navigate?: KeyboardEventHandler<HTMLDivElement>) {
  if (!navigate || event.defaultPrevented || event.nativeEvent.isComposing ||
      !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
  const target = event.target as Element;
  if (!event.currentTarget.contains(target) || !target.closest(previewPane) ||
      target.closest(controls) || target.closest("[data-image-preview-dragging]")) return;
  navigate(event);
}

export function ImageBrowser({ list, listProps, divider, children, onListKeyDown, onPreviewKeyDown, ...props }:
  ComponentPropsWithRef<"div"> & {
    list: ReactNode;
    listProps?: ComponentPropsWithRef<"div">;
    divider?: ReactNode;
    onListKeyDown?: KeyboardEventHandler<HTMLDivElement>;
    onPreviewKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  }) {
  return <div {...props} className={["image-browser", props.className].filter(Boolean).join(" ")} onKeyDown={event => {
    props.onKeyDown?.(event);
    if (list != null) routeImageBrowserKey(event, onPreviewKeyDown ?? onListKeyDown);
  }}>
    {list != null && <>
      <div {...listProps} className={["image-browser-list", listProps?.className].filter(Boolean).join(" ")}
        onKeyDown={event => { listProps?.onKeyDown?.(event); if (!event.defaultPrevented) onListKeyDown?.(event); }}>
        {list}
      </div>
      {divider}
    </>}
    {children}
  </div>;
}

export const focusImagePreview: PointerEventHandler<HTMLElement> = event => {
  const target = event.target as Element;
  if (event.button === 0 && target.closest(previewPane) === event.currentTarget && !target.closest(controls)) {
    event.currentTarget.focus({ preventScroll: true });
  }
};

export function ImagePreviewFrame({ caption, fallback, children, keyboardPane, ...props }: ComponentPropsWithRef<"figure"> & {
  caption?: ReactNode; fallback?: ReactNode; keyboardPane?: boolean;
}) {
  return <figure {...props} tabIndex={keyboardPane ? 0 : props.tabIndex}
    data-game-image-preview-pane={keyboardPane ? "" : undefined}
    onPointerDown={keyboardPane ? event => { focusImagePreview(event); props.onPointerDown?.(event); } : props.onPointerDown}>
    {caption && <figcaption>{caption}</figcaption>}
    {children ? <div className="unity-image-preview-surface">{children}</div> : fallback}
  </figure>;
}

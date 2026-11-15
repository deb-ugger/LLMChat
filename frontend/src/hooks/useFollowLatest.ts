import { useLayoutEffect, useRef, useState, type RefCallback } from "react";

type FollowState = { following: boolean; top: number };

/** Follow appended content until the reader scrolls away, independently per pane. */
export function observeLatestContent(element: HTMLElement, state: FollowState) {
  let frame: number | undefined;
  const originalAnchor = element.style.overflowAnchor;
  const visible = () => element.clientHeight > 0;
  const setFollowing = (following: boolean) => {
    state.following = following;
    const anchor = following ? "none" : originalAnchor;
    if (element.style.overflowAnchor !== anchor) element.style.overflowAnchor = anchor;
  };
  const scroll = () => {
    frame = undefined;
    if (!visible() || !state.following) return;
    element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    state.top = element.scrollTop;
  };
  const schedule = () => { if (frame === undefined && visible() && state.following) frame = requestAnimationFrame(scroll); };
  const onScroll = () => {
    if (!visible()) return;
    const top = element.scrollTop;
    if (element.scrollHeight - element.clientHeight - top <= 4) setFollowing(true);
    else if (Math.abs(top - state.top) > .5) setFollowing(false);
    state.top = top;
  };
  const onWheel = (event: WheelEvent) => {
    if (event.deltaY < 0 && element.scrollHeight > element.clientHeight) setFollowing(false);
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.target !== element) return;
    if (["ArrowUp", "PageUp", "Home"].includes(event.key) && element.scrollHeight > element.clientHeight) setFollowing(false);
  };
  setFollowing(state.following);
  if (state.following) scroll(); else element.scrollTop = state.top;
  const mutations = new MutationObserver(schedule);
  mutations.observe(element, { childList: true, subtree: true, characterData: true, attributes: true });
  const resize = new ResizeObserver(schedule); resize.observe(element);
  element.addEventListener("scroll", onScroll, { passive: true });
  element.addEventListener("wheel", onWheel, { passive: true });
  element.addEventListener("keydown", onKey);
  element.addEventListener("load", schedule, true);
  return () => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    mutations.disconnect(); resize.disconnect();
    element.removeEventListener("scroll", onScroll); element.removeEventListener("wheel", onWheel);
    element.removeEventListener("keydown", onKey); element.removeEventListener("load", schedule, true);
    element.style.overflowAnchor = originalAnchor;
  };
}

export function useFollowLatest<T extends HTMLElement>(active = true): RefCallback<T> {
  const [element, setElement] = useState<T | null>(null);
  const state = useRef<FollowState>({ following: true, top: 0 });
  useLayoutEffect(() => {
    if (!element || !active) return;
    return observeLatestContent(element, state.current);
  }, [element, active]);
  return setElement;
}

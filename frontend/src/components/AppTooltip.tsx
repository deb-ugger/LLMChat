import { getLayoutRect, getLayoutViewport } from "../viewportLayout";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type Hint = { element: HTMLElement; text: string };

type Pointer = {x:number;y:number};
function placeHint(element:HTMLElement,anchor:HTMLElement,pointer:Pointer|null){
  const { scale, width, height } = getLayoutViewport();
  const box = getLayoutRect(element.getBoundingClientRect(), scale);
  const rect = getLayoutRect(anchor.getBoundingClientRect(), scale);
  const x = pointer ? pointer.x / scale : rect.left + rect.width / 2;
  const y = pointer ? pointer.y / scale : rect.bottom;
  const left = pointer ? (x + box.width + 12 <= width - 8 ? x + 12 : x - box.width - 12) : x - box.width / 2;
  const top = pointer ? (y + box.height + 16 <= height - 8 ? y + 16 : y - box.height - 12)
    : (y + box.height + 8 <= height - 8 ? y + 8 : rect.top - box.height - 8);
  element.style.left=Math.max(8,Math.min(left,width-box.width-8))+"px";
  element.style.top=Math.max(8,Math.min(top,height-box.height-8))+"px";
}

/** One delegated tooltip also covers lazy pages, portals and disabled controls. */
export function AppTooltip() {
  const id = useId();
  const [hint, setHint] = useState<Hint | null>(null);
  const tip = useRef<HTMLDivElement>(null),pointer=useRef<Pointer|null>(null),frame=useRef(0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let target: HTMLElement | null = null;
    const hide = () => { clearTimeout(timer);cancelAnimationFrame(frame.current);frame.current=0;pointer.current=null; target = null; setHint(null); };
    let pressedAt=-Infinity;
    const down=()=>{pressedAt=performance.now();hide();};
    const find = (element: EventTarget | null) => element instanceof Element ? element.closest<HTMLElement>("[data-tooltip]") : null;
    const show = (element: HTMLElement | null, delay: number, position:Pointer|null=null) => {
      if (element === target) return;
      hide();
      if (!element?.dataset.tooltip?.trim()) return;
      target = element;pointer.current=position;
      timer = setTimeout(() => {
        if (element.isConnected && element.dataset.tooltip?.trim()) setHint({ element, text: element.dataset.tooltip });
      }, delay);
    };
    const over = (event: PointerEvent) => { if (event.pointerType !== "touch" && !event.buttons) show(find(event.target), 350,{x:event.clientX,y:event.clientY}); };
    const out = (event: PointerEvent) => { if (target && !(event.relatedTarget instanceof Node && target.contains(event.relatedTarget))) hide(); };
    const focus = (event: FocusEvent) => { const element = find(event.target); if (performance.now()-pressedAt>250 && element && event.target instanceof Element && event.target.matches(":focus-visible")) show(element, 100); };
    const move=(event:PointerEvent)=>{if(!target||!pointer.current)return;pointer.current={x:event.clientX,y:event.clientY};if(!frame.current&&tip.current)frame.current=requestAnimationFrame(()=>{frame.current=0;if(tip.current&&target)placeHint(tip.current,target,pointer.current);});};
    const key = (event: KeyboardEvent) => { if(event.key==="Tab")pressedAt=-Infinity; if (["Escape", "Enter", " "].includes(event.key)) hide(); };
    document.addEventListener("pointerover", over, true);
    document.addEventListener("pointerout", out, true);
    document.addEventListener("pointermove",move,true);
    document.addEventListener("focusin", focus, true);
    document.addEventListener("focusout", hide, true);
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key, true);
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    window.addEventListener("blur", hide);
    return () => {
      hide();
      document.removeEventListener("pointerover", over, true);
      document.removeEventListener("pointerout", out, true);
      document.removeEventListener("pointermove",move,true);
      document.removeEventListener("focusin", focus, true);
      document.removeEventListener("focusout", hide, true);
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("visibilitychange", hide);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
      window.removeEventListener("blur", hide);
    };
  }, []);

  useLayoutEffect(() => {
    const element = tip.current;
    if (!hint || !element) return;
    element.showPopover();
    placeHint(element,hint.element,pointer.current);
    element.style.visibility = "visible";
    const describedBy = new Set((hint.element.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean));
    describedBy.add(id); hint.element.setAttribute("aria-describedby", [...describedBy].join(" "));
    const observer = new MutationObserver(() => {
      if (!hint.element.isConnected || !hint.element.dataset.tooltip?.trim()) setHint(null);
      else if (hint.element.dataset.tooltip !== hint.text) setHint({ element: hint.element, text: hint.element.dataset.tooltip });
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-tooltip"] });
    return () => {
      observer.disconnect();
      if (element.matches(":popover-open")) element.hidePopover();
      const descriptions = (hint.element.getAttribute("aria-describedby") || "").split(/\s+/).filter(value => value && value !== id);
      if (descriptions.length) hint.element.setAttribute("aria-describedby", descriptions.join(" "));
      else hint.element.removeAttribute("aria-describedby");
    };
  }, [hint, id]);

  return hint && createPortal(<div ref={tip} id={id} role="tooltip" popover="manual" className="app-tooltip" style={{ visibility: "hidden" }}>{hint.text}</div>, document.body);
}

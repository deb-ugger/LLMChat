import { Image as NativeImage } from "@tauri-apps/api/image";
import { isTauri } from "@tauri-apps/api/core";
import { writeImage } from "@tauri-apps/plugin-clipboard-manager";
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import type { AnnotatedImage, AnnotatedSampleSet } from "../benchmark/imageSampleSet";
import { datasetParts, type DatasetPart } from "../benchmark/trainingDatasets";
import type { MosaicBox } from "../gameMosaic";
import { getFixedMenuPoint } from "../viewportLayout";
import { showAppNotice } from "./AppNotice";

export type DatasetMask = { box: MosaicBox; part: DatasetPart | "" };

export function useSamplePicture(image: AnnotatedImage, read: AnnotatedSampleSet["read"]) {
  const [picture, setPicture] = useState<{ blob?: Blob; url: string; failed: boolean }>({ url: "", failed: false });
  useEffect(() => {
    const controller = new AbortController();
    let url = "";
    setPicture({ url: "", failed: false });
    void read(image, controller.signal).then(blob => {
      if (controller.signal.aborted) return;
      url = URL.createObjectURL(blob);
      setPicture({ blob, url, failed: false });
    }).catch(() => { if (!controller.signal.aborted) setPicture({ url: "", failed: true }); });
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [image.id, image.sourceHash, read]);
  return picture;
}

export function SamplePicture({ image, read }: { image: AnnotatedImage; read: AnnotatedSampleSet["read"] }) {
  const picture = useSamplePicture(image, read);
  return picture.url ? <img src={picture.url} alt="" draggable={false} />
    : <span className="training-dataset-picture-state">{picture.failed ? "图片读取失败" : "读取中…"}</span>;
}

export async function copyDatasetPicture(image: AnnotatedImage, read: AnnotatedSampleSet["read"]) {
  const blob = await read(image, new AbortController().signal);
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法读取图片像素");
    context.drawImage(bitmap, 0, 0);
    if (isTauri()) {
      const native = await NativeImage.new(new Uint8Array(context.getImageData(0, 0, bitmap.width, bitmap.height).data.buffer), bitmap.width, bitmap.height);
      try { await writeImage(native); } finally { await native.close(); }
    } else {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": await canvas.convertToBlob({ type: "image/png" }) })]);
    }
    showAppNotice("已复制图片", "success");
  } finally { bitmap.close(); }
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const rectangle = (a: number[], b: number[]): MosaicBox => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];

export function TrainingDatasetImage({ image, read, masks, editable, busy, onChange, onUndo, canUndo, onPreview, onContextMenu, readOnlyHint }: {
  image: AnnotatedImage; read: AnnotatedSampleSet["read"]; masks: DatasetMask[]; editable: boolean; busy: boolean;
  onChange: (masks: DatasetMask[]) => Promise<void>; onUndo: () => void; canUndo: boolean;
  onPreview: () => void; onContextMenu: (event: MouseEvent<HTMLDivElement>) => void; readOnlyHint?: string;
}) {
  const picture = useSamplePicture(image, read);
  const viewport = useRef<HTMLDivElement>(null), bitmap = useRef<HTMLDivElement>(null), table = useRef<HTMLDivElement>(null);
  const partsMenu = useRef<HTMLDivElement>(null), contextMenu = useRef<HTMLDivElement>(null);
  const [drafts, setDrafts] = useState(() => masks.map(mask => ({ ...mask, box: [...mask.box] as MosaicBox })));
  const current = useRef(drafts), pending = useRef(0), [saving, setSaving] = useState(false), [error, setError] = useState("");
  const [selected, setSelected] = useState(-1), selectedRef = useRef(-1), pointerHit = useRef(-1);
  const [fit, setFit] = useState(1), [manualZoom, setManualZoom] = useState<number>();
  const zoom = manualZoom ?? fit;
  const signature = JSON.stringify(masks);
  const drag = useRef<{ mode: "draw" | "move" | "resize"; index: number; handle: number; start: [number,number]; before: DatasetMask[]; box?: MosaicBox } | undefined>(undefined);
  const handles = [[0,0],[.5,0],[1,0],[1,.5],[1,1],[.5,1],[0,1],[0,.5]];
  const copy = (values: DatasetMask[]) => values.map(mask => ({ ...mask, box: [...mask.box] as MosaicBox }));
  function display(values: DatasetMask[]) { current.current = values; setDrafts(values); }
  useLayoutEffect(() => {
    if (!pending.current && !drag.current && (!error || signature === JSON.stringify(current.current))) {
      display(copy(masks));
      setError("");
      if (selectedRef.current >= masks.length) { selectedRef.current = masks.length - 1; setSelected(masks.length - 1); }
    }
  }, [signature]);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => setFit(Math.max(.01, Math.min(
      (element.offsetWidth - 26) / image.width, (element.offsetHeight - 26) / image.height,
    )));
    measure(); const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, [image.width, image.height]);
  function persist(values: DatasetMask[]) {
    const next = copy(values); display(next); pending.current++; setSaving(true);
    void onChange(next).then(() => setError("")).catch(cause => {
      setError(String(cause)); showAppNotice("标注写入失败：" + String(cause), "error");
    }).finally(() => { pending.current--; if (!pending.current) setSaving(false); });
  }
  function selectMask(index: number, reveal = false) {
    selectedRef.current = index; setSelected(index);
    requestAnimationFrame(() => {
      const row = table.current?.querySelector<HTMLElement>('[data-mask-row="' + index + '"]');
      if (row && table.current) {
        const r = row.getBoundingClientRect(), v = table.current.getBoundingClientRect();
        const top = v.top + (table.current.querySelector("thead")?.getBoundingClientRect().height ?? 0);
        if (r.top < top) table.current.scrollTop += r.top - top;
        else if (r.bottom > v.bottom) table.current.scrollTop += r.bottom - v.bottom;
      }
      const mask = current.current[index], view = viewport.current, picture = bitmap.current;
      if (!reveal || !mask || !view || !picture) return;
      const left = picture.offsetLeft + mask.box[0] * zoom, top = picture.offsetTop + mask.box[1] * zoom;
      const right = picture.offsetLeft + mask.box[2] * zoom, bottom = picture.offsetTop + mask.box[3] * zoom;
      if (left < view.scrollLeft) view.scrollLeft = Math.max(0,left-12);
      else if (right > view.scrollLeft+view.clientWidth) view.scrollLeft = right-view.clientWidth+12;
      if (top < view.scrollTop) view.scrollTop = Math.max(0,top-12);
      else if (bottom > view.scrollTop+view.clientHeight) view.scrollTop = bottom-view.clientHeight+12;
    });
  }
  function menuPosition(menu: HTMLDivElement | null, x: number, y: number, height: number) {
    if (!menu) return;
    const p = getFixedMenuPoint(x,y,170,height);
    menu.style.left = p.x+"px"; menu.style.top = p.y+"px"; menu.showPopover();
    menu.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll:true });
  }
  function choosePart(index: number, x: number, y: number) {
    if (!editable || busy) return;
    selectMask(index); contextMenu.current?.hidePopover(); requestAnimationFrame(() => menuPosition(partsMenu.current,x,y,160));
  }
  function updatePart(index: number, part: DatasetPart | "") {
    if (!editable || busy || !current.current[index]) return;
    selectMask(index); persist(current.current.map((mask,i) => i === index ? { ...mask,part } : mask));
    partsMenu.current?.hidePopover(); viewport.current?.focus({ preventScroll:true });
  }
  function remove(index: number) {
    if (!editable || busy || !current.current[index]) return;
    persist(current.current.filter((_,i) => i !== index));
    selectMask(Math.min(index,current.current.length-1)); contextMenu.current?.hidePopover();
    viewport.current?.focus({ preventScroll:true });
  }
  function point(event: PointerEvent): [number,number] {
    const r = bitmap.current!.getBoundingClientRect();
    return [clamp(Math.round((event.clientX-r.left)/r.width*image.width),0,image.width),
      clamp(Math.round((event.clientY-r.top)/r.height*image.height),0,image.height)];
  }
  function move(event: PointerEvent) {
    const gesture = drag.current;
    if (!gesture) return;
    const p = point(event), values = copy(current.current);
    let box: MosaicBox;
    if (gesture.mode === "draw") box = rectangle(gesture.start,p);
    else {
      const original = gesture.box!, dx = p[0]-gesture.start[0], dy = p[1]-gesture.start[1];
      box = [...original];
      if (gesture.mode === "move") {
        const x = clamp(dx,-original[0],image.width-original[2]), y = clamp(dy,-original[1],image.height-original[3]);
        box = [original[0]+x,original[1]+y,original[2]+x,original[3]+y];
      } else {
        const [horizontal,vertical] = handles[gesture.handle];
        if (horizontal === 0) box[0] = clamp(original[0]+dx,0,original[2]-1);
        if (horizontal === 1) box[2] = clamp(original[2]+dx,original[0]+1,image.width);
        if (vertical === 0) box[1] = clamp(original[1]+dy,0,original[3]-1);
        if (vertical === 1) box[3] = clamp(original[3]+dy,original[1]+1,image.height);
      }
    }
    values[gesture.index] = { ...values[gesture.index],box }; display(values);
  }
  function finish(event: PointerEvent) {
    const gesture = drag.current;
    if (!gesture) return;
    move(event); drag.current = undefined;
    const mask = current.current[gesture.index];
    if (!mask || mask.box[2] <= mask.box[0] || mask.box[3] <= mask.box[1]) { display(gesture.before); return; }
    if (JSON.stringify(current.current) !== JSON.stringify(gesture.before)) persist(current.current);
    if (gesture.mode === "draw") choosePart(gesture.index,event.clientX,event.clientY);
  }
  const known = drafts.filter(mask => !!mask.part).length;
  return <section className="training-dataset-editor" style={{ flex: "1 1 0" }} aria-label="图片标注" onKeyDown={event => {
    if (partsMenu.current?.matches(":popover-open") || contextMenu.current?.matches(":popover-open")) return;
    if (event.key === "Delete" && !(event.target instanceof Element && event.target.closest("input,textarea,select,[contenteditable]"))) {
      event.preventDefault(); event.stopPropagation(); remove(selectedRef.current);
    }
  }}>
    <header className="training-dataset-editor-tools">
      <div className="training-dataset-editor-identity">
        <strong title={image.sourceDirectory || image.file}>{image.name}</strong>
        <span>{image.width} × {image.height}</span>
      </div>
      <div className="training-dataset-zoom">
        <button className="unity-btn" type="button" aria-label="缩小标注画布" onClick={() => setManualZoom(Math.max(.01, zoom - Math.min(.25, zoom * .25)))}>−</button>
        <button className="unity-btn" type="button" aria-label="恢复100%比例" onClick={() => setManualZoom(1)}>{Math.round(zoom*100)}%</button>
        <button className="unity-btn" type="button" aria-label="放大标注画布" onClick={() => setManualZoom(zoom + Math.min(.25, zoom * .25))}>+</button>
        <button className="unity-btn" type="button" aria-pressed={manualZoom === undefined} onClick={() => setManualZoom(undefined)}>适应</button>
      </div>
      <button className="unity-btn" type="button" disabled={!canUndo || busy} onClick={onUndo} data-tooltip="撤销标注 · Ctrl+Z">撤销</button>
      <button className="unity-btn" type="button" onClick={onPreview}>查看原图</button>
      <span className="hint">已标部位 {known} / {drafts.length} 框</span>
    </header>
    <div ref={viewport} tabIndex={0} className="training-dataset-canvas" aria-label="图片画布" onContextMenu={onContextMenu}
      onDoubleClick={event => { if (pointerHit.current >= 0) { event.stopPropagation(); choosePart(pointerHit.current,event.clientX,event.clientY); } }}
      onPointerDown={event => {
        pointerHit.current = -1;
        if (event.button !== 0 || busy || !bitmap.current?.contains(event.target as Node)) return;
        const index = (event.target as HTMLElement).closest<HTMLElement>("[data-canvas-mask]")?.dataset.canvasMask;
        pointerHit.current = index === undefined ? -1 : Number(index);
        if (index !== undefined) selectMask(Number(index));
        if (!editable) return;
        event.preventDefault(); event.currentTarget.focus({ preventScroll:true }); event.currentTarget.setPointerCapture(event.pointerId);
        partsMenu.current?.hidePopover(); contextMenu.current?.hidePopover();
        const p = point(event), before = copy(current.current);
        if (index !== undefined) {
          const handle = (event.target as HTMLElement).dataset.handle;
          drag.current = { mode:handle === undefined ? "move" : "resize",index:Number(index),handle:Number(handle),start:p,before,box:[...current.current[Number(index)].box] };
        } else {
          const i = current.current.length; display([...current.current,{box:[p[0],p[1],p[0],p[1]],part:""}]); selectMask(i);
          drag.current = { mode:"draw",index:i,handle:0,start:p,before };
        }
      }} onPointerMove={move} onPointerUp={finish} onPointerCancel={() => { if (drag.current) display(drag.current.before); drag.current = undefined; }}
      onLostPointerCapture={() => { if (drag.current) display(drag.current.before); drag.current = undefined; }}>
      <div className="training-dataset-canvas-track"><div ref={bitmap} className="training-dataset-canvas-image" style={{width:image.width*zoom,height:image.height*zoom}}>
        {picture.url ? <img src={picture.url} alt={image.name} draggable={false} /> : <span>{picture.failed ? "图片读取失败" : "正在读取图片…"}</span>}
        {drafts.map((mask,index) => <span key={index} className="training-dataset-canvas-mask" role="button" tabIndex={0}
          aria-label={"蒙版 "+(index+1)+"："+(mask.part ? datasetParts[mask.part] : "未知")} aria-pressed={selected === index}
          data-canvas-mask={index} data-selected={selected === index}
          style={{left:mask.box[0]*zoom,top:mask.box[1]*zoom,width:(mask.box[2]-mask.box[0])*zoom,height:(mask.box[3]-mask.box[1])*zoom}}
          onDoubleClick={event => { event.stopPropagation(); choosePart(index,event.clientX,event.clientY); }}
          onContextMenu={event => {
            if (!editable || busy) return;
            event.preventDefault(); event.stopPropagation();
            selectMask(index); menuPosition(contextMenu.current,event.clientX,event.clientY,88);
          }} onKeyDown={event => {
            if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); const r=event.currentTarget.getBoundingClientRect();choosePart(index,r.left,r.bottom); }
          }}>
          <b>{index+1} {mask.part ? datasetParts[mask.part] : "未知"}</b>
          {editable && selected === index && handles.map(([x,y],handle) => <i key={handle} data-handle={handle} style={{left:x*100+"%",top:y*100+"%"}} />)}
        </span>)}
      </div></div>
    </div>
    <div className="training-dataset-write-state" role="status">{error ? <>写入失败：{error} <button className="unity-btn" type="button" onClick={() => persist(current.current)}>重试写入</button></>
      : saving ? "正在写入工作副本…" : editable ? "拖空白处画框，双击框改部位；改动自动写入 · Ctrl+Z 撤销" : readOnlyHint || "只读数据集，创建标注副本后可编辑"}</div>
    <section className="training-dataset-regions" aria-label="区域清单">
      <div ref={table} className="training-dataset-region-table"><table><thead><tr>
        <th>#</th><th>部位</th><th>左</th><th>上</th><th>右</th><th>下</th><th>操作</th>
      </tr></thead><tbody>{drafts.map((mask,index) => <tr key={index} data-mask-row={index} aria-selected={selected === index} tabIndex={0}
        onClick={() => selectMask(index,true)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault();selectMask(index,true); } }}>
        <td>{index+1}</td><td><select aria-label={"蒙版 "+(index+1)+" 部位"} value={mask.part} disabled={!editable || busy}
          onChange={event => updatePart(index,event.target.value as DatasetPart | "")}><option value="">未知</option>
          {Object.entries(datasetParts).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></td>
        {mask.box.map((coordinate,i) => <td key={i}>{coordinate}</td>)}
        <td><button type="button" className="unity-btn" disabled={!editable || busy} onClick={event => {event.stopPropagation();remove(index);}}>删除</button></td>
      </tr>)}</tbody></table>{!drafts.length && <p className="hint">暂无蒙版框</p>}</div>
    </section>
    <div ref={partsMenu} popover="auto" className="unity-gallery-menu" role="menu" aria-label="选择部位" style={{inset:"auto",margin:0}}
      onKeyDown={event => { event.stopPropagation(); if (["ArrowUp","ArrowDown","Home","End"].includes(event.key)) {
        event.preventDefault();const buttons=[...event.currentTarget.querySelectorAll("button")],i=buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next=event.key==="Home"?0:event.key==="End"?3:(i+(event.key==="ArrowDown"?1:3))%4;buttons[next]?.focus();
      } }}>
      {([...Object.entries(datasetParts),["","未知"]] as [DatasetPart | "",string][]).map(([part,label]) => <button key={part} type="button" role="menuitemradio"
        aria-checked={current.current[selected]?.part === part} onClick={() => updatePart(selectedRef.current,part)}>{label}</button>)}
    </div>
    <div ref={contextMenu} popover="auto" className="unity-gallery-menu" role="menu" aria-label="蒙版操作" style={{inset:"auto",margin:0}} onKeyDown={event => event.stopPropagation()}>
      <button type="button" role="menuitem" onClick={() => {const r=contextMenu.current!.getBoundingClientRect();choosePart(selectedRef.current,r.left,r.top);}}>改部位</button>
      <button type="button" role="menuitem" onClick={() => remove(selectedRef.current)}>删除框</button>
    </div>
  </section>;
}

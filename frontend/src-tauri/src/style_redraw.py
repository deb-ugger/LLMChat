"""Single-image ComfyUI redraw worker. stdin/stdout use UTF-8 JSON lines."""
import asyncio
import base64
import io
import os
import json
from pathlib import Path
import secrets
import subprocess
import sys
import time
import uuid

import aiohttp
import numpy as np
from PIL import Image

BASE = "http://127.0.0.1:8188"


def emit(kind, value):
    print(json.dumps({"type": kind, "value": value}, ensure_ascii=True), flush=True)


def png(image):
    buffer = io.BytesIO()
    image.save(buffer, "PNG")
    return buffer.getvalue()


async def request(session, method, route, **kwargs):
    async with session.request(method, BASE + route, allow_redirects=False, **kwargs) as response:
        if response.status != 200:
            raise RuntimeError(f"ComfyUI {route} ({response.status}) {str(await response.text())[:1400]}")
        if route == "/view":
            return await response.read()
        return await response.json()


async def ready(session, root):
    try:
        stats = await request(session, "GET", "/system_stats")
    except aiohttp.ClientConnectorError:
        main = root / "ComfyUI" / "main.py"
        if not main.is_file():
            raise ValueError("请在模块设置中选择 ComfyUI 便携版目录")
        emit("status", "正在启动本地 ComfyUI")
        log_path = root / "llmchat-comfy.log"
        with log_path.open("ab") as log:
            child = subprocess.Popen([sys.executable, "-s", str(main), "--windows-standalone-build",
                                      "--listen", "127.0.0.1", "--port", "8188", "--disable-auto-launch"],
                                     cwd=root, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                     creationflags=subprocess.CREATE_NO_WINDOW)
        for _ in range(180):
            await asyncio.sleep(1)
            if child.poll() is not None:
                raise RuntimeError(f"ComfyUI 启动失败，日志：{log_path}")
            try:
                stats = await request(session, "GET", "/system_stats")
                break
            except aiohttp.ClientConnectorError:
                continue
        else:
            raise TimeoutError(f"ComfyUI 启动超时，日志：{log_path}")
    if "system" not in stats:
        raise RuntimeError("8188 端口上的服务不是 ComfyUI")


def workflow(upload, reference, translation, steps, matte, profile):
    text = f"Replace the lettering in this image with exactly this Chinese text: «{translation}». Image 1 is the authoritative Chinese glyph draft. Keep its glyphs, layout, scale and tilt. Use image 2 only for ink style. Match the original calligraphic strokes, colors, outline, orientation and layout. Do not add any extra words."
    if matte:
        text += f" Keep the background perfectly flat solid RGB{matte}."
    def node(kind, **inputs):
        return {"class_type": kind, "inputs": inputs}
    def encode(prompt):
        return node("TextEncodeQwenImageEditPlus", clip=["2", 0], vae=["3", 0], image1=["5", 0], image2=["16", 0], prompt=prompt)
    def condition(source):
        return node("FluxKontextMultiReferenceLatentMethod", reference_latents_method="index_timestep_zero", conditioning=[source, 0])
    kind = profile["kind"]
    if kind == "custom":
        graph = json.loads(profile["graph"])
        if "nodes" in graph or not all(isinstance(n, dict) and "class_type" in n for n in graph.values()):
            raise ValueError("请导入 ComfyUI 导出的 API 格式工作流")
        tokens = {"{{draft}}": upload, "{{original}}": reference, "{{translation}}": translation,
                  "{{prompt}}": text, "{{steps}}": steps, "{{model}}": profile["model"],
                  "{{clip}}": profile["clip"], "{{vae}}": profile["vae"]}
        present = set()
        for n in graph.values():
            for field, value in n["inputs"].items():
                if isinstance(value, str) and value in tokens:
                    n["inputs"][field] = tokens[value]
                    present.add(value)
        if "{{draft}}" not in present or not present.intersection(("{{prompt}}", "{{translation}}")):
            raise ValueError("工作流需要 {{draft}} 和 {{prompt}} 或 {{translation}} 输入")
        return graph
    if kind == "turbo":
        return {
            "1": node("UNETLoader", unet_name=profile["model"], weight_dtype="default"),
            "2": node("CLIPLoader", clip_name=profile["clip"], type="qwen_image", device="default"),
            "3": node("VAELoader", vae_name=profile["vae"]),
            "4": node("LoadImage", image=upload), "16": node("LoadImage", image=reference),
            "5": node("TextEncodeQwenImage21", clip=["2",0], vae=["3",0], prompt=text, negative_prompt="",
                      resolution=1024, **{"images.image_1":["4",0], "images.image_2":["16",0]}),
            "6": node("QwenImage21Cache", model=["1",0], device="auto", dtype="default"),
            "7": node("CFGGuider", model=["6",0], positive=["5",0], negative=["5",1], cfg=1.0),
            "8": node("RandomNoise", noise_seed=secrets.randbits(48)),
            "9": node("KSamplerSelect", sampler_name="euler"),
            "10": node("ManualSigmas", sigmas="1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0"),
            "13": node("SamplerCustomAdvanced", noise=["8",0], guider=["7",0], sampler=["9",0], sigmas=["10",0], latent_image=["5",2]),
            "14": node("VAEDecode", samples=["13",0], vae=["3",0]), "15": node("PreviewImage", images=["14",0]),
        }
    return {
        "16": node("LoadImage", image=reference),
        "1": node("UnetLoaderGGUF", unet_name=profile["model"]),
        "2": node("CLIPLoader", clip_name=profile["clip"], type="qwen_image", device="default"),
        "3": node("VAELoader", vae_name=profile["vae"]),
        "4": node("LoadImage", image=upload),
        "5": node("FluxKontextImageScale", image=["4", 0]),
        "6": encode(text), "7": encode(""),
        "8": condition("6"), "9": condition("7"),
        "10": node("ModelSamplingAuraFlow", shift=3.1, model=["1", 0]),
        "11": node("CFGNorm", strength=1.0, model=["10", 0]),
        "12": node("VAEEncode", pixels=["5", 0], vae=["3", 0]),
        "13": node("KSampler", seed=secrets.randbits(48), steps=steps, cfg=4.0, sampler_name="euler",
                   scheduler="simple", denoise=1.0, model=["11", 0], positive=["8", 0], negative=["9", 0], latent_image=["12", 0]),
        "14": node("VAEDecode", samples=["13", 0], vae=["3", 0]),
        "15": node("PreviewImage", images=["14", 0]),
    }


def prepare(crop):
    pixels = np.asarray(crop)
    if pixels[:, :, 3].min() == 255:
        return crop.convert("RGB"), None
    visible = pixels[:, :, :3][pixels[:, :, 3] > 64].astype(np.int16)
    colors = [(0, 255, 0), (255, 0, 255), (0, 255, 255)]
    matte = max(colors, key=lambda c: np.percentile(np.abs(visible - c).max(axis=1), 5)) if visible.size else colors[0]
    backdrop = Image.new("RGBA", crop.size, matte + (255,))
    return Image.alpha_composite(backdrop, crop).convert("RGB"), matte


def extract(result, matte, size):
    layer = result.convert("RGBA")
    if matte:
        pixels = np.asarray(layer, dtype=np.float32)
        rgb = pixels[:, :, :3]
        # ComfyUI can return the key color at a lower brightness than the input.
        key_channels = np.asarray(matte) == 255
        brightness = np.clip(rgb[:, :, key_channels].mean(axis=2, keepdims=True), 192, 255)
        bg = brightness * key_channels
        distance = np.max(np.abs(rgb - bg), axis=2, keepdims=True)
        key_alpha = np.clip((distance - 48) / 80, 0, 1)
        foreground = np.clip((rgb - bg * (1 - key_alpha)) / np.maximum(key_alpha, 0.001), 0, 255)
        alpha = pixels[:, :, 3:4] * key_alpha
        layer = Image.fromarray(np.concatenate((foreground, alpha), axis=2).astype(np.uint8))
    return layer.resize(size, Image.Resampling.LANCZOS)


async def upload_image(session, reference):
    form = aiohttp.FormData()
    form.add_field("type", "temp")
    form.add_field("image", png(reference), filename=f"llmchat-{uuid.uuid4().hex}.png", content_type="image/png")
    uploaded = await request(session, "POST", "/upload/image", data=form)
    name = "/".join(filter(None, [uploaded.get("subfolder"), uploaded["name"]]))
    if uploaded.get("type") == "temp":
        name += " [temp]"
    return name


def refine_transparent_lettering(crop, draft, layer, protected):
    from scipy import ndimage

    original = np.asarray(crop)
    guide = np.asarray(draft)
    candidate = np.array(layer, dtype=np.float32)
    guide_alpha = np.where(protected, 0, guide[:, :, 3]).astype(np.float32)
    model_alpha = np.minimum(candidate[:, :, 3], ndimage.maximum_filter(guide_alpha, size=3))
    model_alpha[protected] = 0
    guide_ink = guide_alpha.sum()
    if model_alpha.sum() < guide_ink * .25:
        raise ValueError("模型笔画与中文字形底稿偏差过大，请采用程序版或重新生成")

    # Keep the draft strokes readable while allowing a one-pixel variation at the edges.
    base_alpha = guide_alpha * .65
    style_alpha = np.maximum(model_alpha - base_alpha, 0)
    ink_budget = guide_ink * 1.12 - base_alpha.sum()
    candidate[:, :, 3] = base_alpha + style_alpha * min(1., ink_budget / max(1., style_alpha.sum()))
    candidate[model_alpha < base_alpha, :3] = guide[model_alpha < base_alpha, :3]

    visible = original[(original[:, :, 3] >= 128) & ~protected, :3].astype(np.float32)
    if visible.size:
        color = np.median(visible, axis=0)
        if np.mean(np.max(np.abs(visible - color), axis=1) <= 25) >= .7:
            candidate[:, :, :3] = candidate[:, :, :3] * .28 + color * .72
    return Image.fromarray(np.rint(candidate).astype(np.uint8))


async def render(session, crop, draft, translation, steps, label, profile):
    reference, matte = prepare(crop)
    if matte:
        backdrop = Image.new("RGBA", draft.size, matte + (255,))
        draft_input = Image.alpha_composite(backdrop, draft).convert("RGB")
    else:
        draft_input = draft.convert("RGB")
    draft_name = await upload_image(session, draft_input)
    ref_name = await upload_image(session, reference)
    graph = workflow(draft_name, ref_name, translation, steps, matte, profile)
    outputs = [key for key,n in graph.items() if n["class_type"] in ("PreviewImage","SaveImage","SaveImageAdvanced")]
    output_id = profile.get("output") or (outputs[0] if len(outputs)==1 else "")
    if output_id not in graph:
        raise ValueError("请选择工作流的图像输出节点 ID")
    client = uuid.uuid4().hex
    async with session.ws_connect(BASE + "/ws", params={"clientId": client}) as ws:
        job = await request(session, "POST", "/prompt", json={"client_id": client, "prompt": graph})
        pid = job["prompt_id"]
        emit("status", f"{label} · 已提交，等待 ComfyUI")
        deadline = time.monotonic() + 3600
        while time.monotonic() < deadline:
            try:
                packet = await ws.receive(timeout=4)
            except asyncio.TimeoutError:
                packet = None
            if packet is not None:
                if packet.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.ERROR):
                    raise RuntimeError("ComfyUI 进度连接已关闭")
                if packet.type != aiohttp.WSMsgType.TEXT:
                    continue
                event = packet.json()
                data = event.get("data", {})
                if data.get("prompt_id") != pid:
                    continue
                if event["type"] == "progress":
                    emit("status", f"{label} · 采样 {data['value']} / {data['max']}")
                if event["type"] == "execution_error":
                    raise RuntimeError(data.get("exception_message") or "ComfyUI 执行失败")
                if event["type"] == "execution_interrupted":
                    raise RuntimeError("ComfyUI 任务已中止")
                if event["type"] not in ("execution_success", "executing") or data.get("node") is not None:
                    continue
            record = (await request(session, "GET", "/history/" + pid)).get(pid)
            if not record:
                continue
            if record.get("status", {}).get("status_str") == "error":
                raise RuntimeError(str(record["status"].get("messages", []))[-1200:])
            image = record["outputs"][output_id]["images"][0]
            raw = await request(session, "GET", "/view", params={k: image[k] for k in ("filename", "subfolder", "type")})
            with Image.open(io.BytesIO(raw)) as output:
                return extract(output, matte, crop.size)
        raise TimeoutError("等待 ComfyUI 结果超时")


def ink_components(crop):
    from scipy import ndimage
    from PIL import ImageDraw
    alpha = np.asarray(crop)[:, :, 3]
    components, _ = ndimage.label(alpha > 40, np.ones((3, 3)))
    protected = np.zeros(alpha.shape, dtype=bool)
    t = np.linspace(0, np.pi * 2, 120)
    x = 16 * np.sin(t) ** 3
    y = -(13*np.cos(t)-5*np.cos(2*t)-2*np.cos(3*t)-np.cos(4*t))
    templates = []
    # Closed heart outlines have a single counter and an indented top. Match across rotations.
    for angle in range(0, 360, 10):
        rad = np.deg2rad(angle)
        u, v = x*np.cos(rad)-y*np.sin(rad), x*np.sin(rad)+y*np.cos(rad)
        pts = list(zip(3+25*(u-u.min())/np.ptp(u), 3+25*(v-v.min())/np.ptp(v)))
        template = Image.new("L", (32,32))
        ImageDraw.Draw(template).line(pts+[pts[0]], fill=255, width=5)
        templates.append(np.asarray(template.resize((32,32))) > 0)
    for label, bounds in enumerate(ndimage.find_objects(components), 1):
        if bounds is None:
            continue
        item = components[bounds] == label
        h,w = item.shape
        if min(h,w) < 6 or not 0.48 < w/h < 2 or ndimage.label(ndimage.binary_fill_holes(item) & ~item)[1] != 1:
            continue
        fitted = np.zeros((32,32),dtype=bool)
        fitted[1:31,1:31] = np.asarray(Image.fromarray(item).resize((30,30),Image.Resampling.NEAREST))
        score = max(np.count_nonzero(fitted & template)/np.count_nonzero(fitted | template) for template in templates)
        if score >= 0.55:
            protected[bounds] = True
    return ndimage.binary_dilation(protected, iterations=2)


def lettering_orientation(axis, writing_mode):
    if writing_mode not in {"auto", "horizontal", "horizontal-reverse", "vertical", "vertical-reverse"}:
        raise ValueError("未知的字形方向")
    # The line angle alone cannot identify writing mode. Use vertical type only near upright by default.
    near_upright = abs(axis[0]) <= np.sin(np.deg2rad(15))
    vertical = writing_mode.startswith("vertical") or (writing_mode == "auto" and near_upright)
    if axis[1] < 0 and (vertical or abs(axis[0]) < 1e-6):
        axis = -axis
    angle = np.degrees(np.arctan2(axis[1], axis[0]))
    rotation = 90 - angle if vertical else -angle
    if writing_mode.endswith("-reverse"):
        rotation += 180
    return vertical, rotation


def program_layer(crop, translation, font_path, protected, writing_mode="auto"):
    from PIL import ImageDraw, ImageFont
    rgba = np.asarray(crop)
    transparent = rgba[:, :, 3].min() < 255
    if transparent:
        ink = (rgba[:,:,3] > 48) & ~protected
        base = Image.new("RGBA", crop.size)
    else:
        edge = np.concatenate((rgba[0], rgba[-1], rgba[:,0], rgba[:,-1]))
        background = np.median(edge,axis=0).astype(np.uint8)
        ink = np.max(np.abs(rgba[:,:,:3].astype(float)-background[:3]),axis=2)>35
        base = Image.new("RGBA",crop.size,tuple(map(int,background)))
    ys,xs = np.nonzero(ink)
    if len(xs) < 2:
        raise ValueError("选区没有足够的可见笔画，请调整范围")
    coords = np.column_stack((xs,ys))
    vals,vecs = np.linalg.eigh(np.cov(coords.T))
    axis = vecs[:,-1] if vals[-1] > 1.35*vals[0] else np.array([1.,0.])
    if axis[0] < 0: axis = -axis
    normal = np.array([-axis[1],axis[0]])
    along, across = coords @ axis, coords @ normal
    center = axis*(along.min()+along.max())/2 + normal*(across.min()+across.max())/2
    colors,counts=np.unique(rgba[ys,xs,:3],axis=0,return_counts=True)
    color=tuple(map(int,colors[counts.argmax()]))+(255,)
    font=ImageFont.truetype(font_path, 128)
    vertical, rotation = lettering_orientation(axis, writing_mode)
    text = "\n".join(ch for ch in translation.strip() if ch != "\n") if vertical else translation.strip()
    draw=ImageDraw.Draw(Image.new("L",(1,1)))
    bounds=draw.multiline_textbbox((0,0),text,font=font,align="center")
    stamp=Image.new("RGBA",(max(1,int(np.ceil(bounds[2]-bounds[0]))),max(1,int(np.ceil(bounds[3]-bounds[1])))))
    ImageDraw.Draw(stamp).multiline_text((-bounds[0],-bounds[1]),text,font=font,fill=color,align="center")
    length, width = np.ptp(along)+1, np.ptp(across)+1
    scale = min(width/stamp.width,length/stamp.height) if vertical else min(length/stamp.width,width/stamp.height)
    stamp=stamp.resize((max(1,round(stamp.width*scale*3)),max(1,round(stamp.height*scale*3))),Image.Resampling.LANCZOS)
    stamp=stamp.rotate(rotation,expand=True,resample=Image.Resampling.BICUBIC)
    stamp=stamp.resize((max(1,round(stamp.width/3)),max(1,round(stamp.height/3))),Image.Resampling.LANCZOS)
    # Keep the new text clear of protected ornaments, including their transparent counters.
    original_stamp = stamp
    for factor in (1, .92, .84, .76, .68, .60, .52, .44, .36):
        stamp = original_stamp.resize((max(1, round(original_stamp.width*factor)), max(1, round(original_stamp.height*factor))), Image.Resampling.LANCZOS)
        placed = False
        for offset in (0, 2, -2, 4, -4, 6, -6, 8, -8, 12, -12):
            xy = center + normal * offset
            pos = (round(xy[0]-stamp.width/2), round(xy[1]-stamp.height/2))
            if pos[0] < 0 or pos[1] < 0 or pos[0]+stamp.width > crop.width or pos[1]+stamp.height > crop.height:
                continue
            footprint = Image.new("L",crop.size)
            footprint.paste(stamp.getchannel("A"),pos)
            if not np.any((np.asarray(footprint)>12) & protected):
                placed = True
                break
        if placed:
            break
    else:
        raise ValueError("选区空间不足，无法避开装饰，请调整选区")
    lettering = Image.new("RGBA", crop.size)
    lettering.alpha_composite(stamp,pos)
    base.alpha_composite(lettering)
    base.paste(crop,(0,0),Image.fromarray(protected))
    return base, lettering


async def run(data):
    steps = int(data["steps"])
    if data["mode"] != "program" and not 1 <= steps <= 100:
        raise ValueError("采样步数须为 1–100")
    with Image.open(io.BytesIO(base64.b64decode(data["image"], validate=True))) as source:
        original = source.convert("RGBA")
    regions = data["regions"]
    if not regions:
        raise ValueError("请勾选需要重绘的文字区域")
    for region in regions:
        x, y, right, bottom = region["box"]
        if not (0 <= x < right <= original.width and 0 <= y < bottom <= original.height and region["translation"].strip()):
            raise ValueError("请检查文字区域坐标和译文")
    composed = original.copy()
    lettering_canvas = Image.new("RGBA", original.size)
    drafts = []
    fonts = Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts"
    font = next((str(fonts / name) for name in ("simkai.ttf", "msyh.ttc", "simhei.ttf") if (fonts / name).is_file()), None)
    if not font:
        raise ValueError("缺少中文字体，请安装楷体、微软雅黑或黑体")
    for region in regions:
        box = tuple(region["box"])
        crop = original.crop(box)
        transparent = crop.getchannel("A").getextrema()[0] < 255
        protected = ink_components(crop) if transparent else np.zeros((crop.height,crop.width),dtype=bool)
        draft, lettering = program_layer(crop, region["translation"], font, protected, region.get("writingMode", "auto"))
        lettering_canvas.paste(lettering, box)
        drafts.append((crop, lettering if transparent else draft, protected, transparent))
        composed.paste(draft, box)
    if data["mode"] == "program":
        emit("result", {"image": base64.b64encode(png(composed)).decode("ascii"), "layer": base64.b64encode(png(lettering_canvas)).decode("ascii")})
        return
    profile = data["profile"]
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=120)) as session:
        await ready(session, Path(data["directory"]))
        for i, region in enumerate(regions, 1):
            box = tuple(region["box"])
            label = f"区域 {i} / {len(regions)}"
            try:
                crop, draft, protected, transparent = drafts[i-1]
                layer = await render(session, crop, draft, region["translation"].strip(), steps, label, profile)
                if transparent:
                    layer = refine_transparent_lettering(crop, draft, layer, protected)
                layer.paste(crop, (0,0), Image.fromarray(protected))
            except Exception as exc:
                raise RuntimeError(f"{label}：{exc}") from exc
            composed.paste(layer, box)
    emit("result", {"image": base64.b64encode(png(composed)).decode("ascii")})


if __name__ == "__main__":
    try:
        asyncio.run(run(json.load(sys.stdin)))
    except Exception as exc:
        emit("error", str(exc) or type(exc).__name__)
        sys.exit(1)

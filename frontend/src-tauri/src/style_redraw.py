"""Single-image ComfyUI redraw worker. stdin/stdout use UTF-8 JSON lines."""
import asyncio
import base64
import hashlib
import io
import os
import json
import shutil
from contextlib import asynccontextmanager
from functools import lru_cache
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


def mosaic_redraw_diagnostic(stage, **fields):
    emit("diagnostic", json.dumps({"stage": stage, **fields}, separators=(",", ":")))


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


def mosaic_cancelled(cancel_path):
    return cancel_path and Path(cancel_path).exists()


async def check_mosaic_cancel(session, cancel_path, prompt_id=None):
    if mosaic_cancelled(cancel_path):
        if prompt_id:
            await request(session, "POST", f"/api/jobs/{prompt_id}/cancel")
        raise RuntimeError("重绘任务已取消")


async def ready(session, root, cancel_path=None, report_gpu=False):
    await check_mosaic_cancel(session, cancel_path)
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
            await check_mosaic_cancel(session, cancel_path)
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
    argv = stats["system"].get("argv", [])
    if argv and Path(argv[0]).is_absolute() and Path(argv[0]).resolve() != (root / "ComfyUI/main.py").resolve():
        raise RuntimeError("8188 端口上的 ComfyUI 不属于所选目录，请切换目录或退出该实例后重试")
    if report_gpu:
        mosaic_redraw_diagnostic("comfy_ready", devices=[
            {key: device.get(key) for key in ("type", "vram_total", "vram_free", "torch_vram_total", "torch_vram_free")}
            for device in stats.get("devices", [])
        ])
    return argv


def workflow(upload, reference, translation, steps, matte, profile, edit_prompt=None):
    text = f"Replace the lettering in this image with exactly this Chinese text: «{translation}». Image 1 is the authoritative Chinese glyph draft. Keep its glyphs, layout, scale and tilt. Use image 2 only for ink style. Match the original calligraphic strokes, colors, outline, orientation and layout. Do not add any extra words."
    if edit_prompt:
        text = edit_prompt
    if matte:
        text += f" Keep the background perfectly flat solid RGB{matte}."
    def node(kind, **inputs):
        return {"class_type": kind, "inputs": inputs}
    def encode(prompt):
        images = {"image1": ["5", 0]}
        if reference is not None:
            images["image2"] = ["16", 0]
        return node("TextEncodeQwenImageEditPlus", clip=["2", 0], vae=["3", 0], prompt=prompt, **images)
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
        if reference is None and not edit_prompt:
            text = (f"The input is finished lettering on a solid RGB{matte} background. "
                    "Very subtly refine the existing ink color and texture in its current palette. "
                    "Keep the exact glyph shapes, line breaks, position and slant. Preserve the exact background.")
        graph = {
            "1": node("UNETLoader", unet_name=profile["model"], weight_dtype="default"),
            "2": node("CLIPLoader", clip_name=profile["clip"], type="qwen_image", device="default"),
            "3": node("VAELoader", vae_name=profile["vae"]),
            "4": node("LoadImage", image=upload),
            "5": node("TextEncodeQwenImage21", clip=["2",0], vae=["3",0], prompt=text, negative_prompt="",
                      resolution=1024, **{"images.image_1":["4",0]}),
            "6": node("QwenImage21Cache", model=["1",0], device="auto", dtype="default"),
            "7": node("CFGGuider", model=["6",0], positive=["5",0], negative=["5",1], cfg=1.0),
            "8": node("RandomNoise", noise_seed=profile.get("seed", secrets.randbits(48))),
            "9": node("KSamplerSelect", sampler_name="euler"),
            "10": node("ManualSigmas", sigmas="1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0"),
            "13": node("SamplerCustomAdvanced", noise=["8",0], guider=["7",0], sampler=["9",0], sigmas=["10",0], latent_image=["5",2]),
            "14": node("VAEDecode", samples=["13",0], vae=["3",0]), "15": node("PreviewImage", images=["14",0]),
        }
        if reference is not None:
            graph["16"] = node("LoadImage", image=reference)
            graph["5"]["inputs"]["images.image_2"] = ["16",0]
        return graph
    graph = {
        **({"16": node("LoadImage", image=reference)} if reference is not None else {}),
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
        "13": node("KSampler", seed=profile.get("seed", secrets.randbits(48)), steps=steps, cfg=4.0, sampler_name="euler",
                   scheduler="simple", denoise=1.0, model=["11", 0], positive=["8", 0], negative=["9", 0], latent_image=["12", 0]),
        "14": node("VAEDecode", samples=["13", 0], vae=["3", 0]),
        "15": node("PreviewImage", images=["14", 0]),
    }
    if kind == "2511-lightning":
        graph["29"] = node("LoraLoaderModelOnly", model=["1", 0],
                           lora_name=EDIT_LIGHTNING_LORA, strength_model=1.0)
        graph["10"]["inputs"]["model"] = ["29", 0]
        graph["13"]["inputs"].update(steps=4, cfg=1.0)
    return graph


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


async def upload_image(session, reference, kind="temp", filename=None, subfolder=None):
    form = aiohttp.FormData()
    form.add_field("type", kind)
    if subfolder:
        form.add_field("subfolder", subfolder)
    form.add_field("image", png(reference), filename=filename or f"llmchat-{uuid.uuid4().hex}.png", content_type="image/png")
    uploaded = await request(session, "POST", "/upload/image", data=form)
    name = "/".join(filter(None, [uploaded.get("subfolder"), uploaded["name"]]))
    if uploaded.get("type") == "temp":
        name += " [temp]"
    return name


def workflow_input_name(name):
    stem = Path(str(name)).stem[:120]
    stem = "".join(c if c not in '<>:"/\\|?*' and ord(c) >= 32 else "_" for c in stem).strip(" .")
    return f"llmchat-{stem}.png" if stem else None


def refine_transparent_lettering(draft, layer, protected):
    result = np.array(draft)
    model = np.asarray(layer, dtype=np.float32)
    guide_alpha = np.where(protected, 0, result[:, :, 3]).astype(np.float32)
    overlap = np.minimum(guide_alpha, model[:, :, 3])
    if overlap.sum() < guide_alpha.sum() * .25:
        raise ValueError("模型笔画与中文字形底稿偏差过大，请采用程序版或重新生成")

    # Keep a single glyph silhouette. Transfer ink variation only where the model covers the draft.
    ink = result[:, :, :3].astype(np.float32)
    tone_delta = np.clip(model[:, :, :3] - ink, -48, 48)
    result[:, :, :3] = np.rint(ink + tone_delta * (overlap[:, :, None] / 510)).astype(np.uint8)
    return Image.fromarray(result)


async def render(session, crop, draft, translation, steps, label, profile, workflow_times):
    reference, matte = prepare(crop)
    if matte:
        backdrop = Image.new("RGBA", draft.size, matte + (255,))
        draft_input = Image.alpha_composite(backdrop, draft).convert("RGB")
    else:
        draft_input = draft.convert("RGB")
    draft_name = await upload_image(session, draft_input)
    # A complete Japanese reference tends to replace the Chinese draft on transparent sprites.
    ref_name = None if matte and profile["kind"] == "turbo" else await upload_image(session, reference)
    graph = workflow(draft_name, ref_name, translation, steps, matte, profile)
    raw = await run_image_graph(session, graph, profile.get("output"), label, workflow_times)
    with Image.open(io.BytesIO(raw)) as output:
        return extract(output, matte, crop.size)


async def read_graph_history(session, prompt_id):
    return (await request(session, "GET", "/history/" + prompt_id)).get(prompt_id)


async def graph_history_image(session, record, output_id, workflow_times, allow_missing=False):
    if record.get("status", {}).get("status_str") == "error":
        raise RuntimeError(str(record["status"].get("messages", []))[-1200:])
    image = record["outputs"][output_id]["images"][0]
    params = {key: image[key] for key in ("filename", "subfolder", "type")}
    if allow_missing:
        async with session.get(BASE + "/view", params=params, allow_redirects=False) as response:
            if response.status == 404:
                return None
            response.raise_for_status()
            raw = await response.read()
    else:
        raw = await request(session, "GET", "/view", params=params)
    start = end = None
    for message in record.get("status", {}).get("messages") or []:
        if not isinstance(message, list) or len(message) != 2 or not isinstance(message[1], dict):
            continue
        event, details = message
        if event == "execution_start":
            start = details.get("timestamp")
        elif event == "execution_success":
            end = details.get("timestamp")
    if isinstance(start, int) and isinstance(end, int) and end >= start:
        workflow_times.append(end - start)
    return raw


async def recover_image_graph(session, prompt_id, output_id, label, workflow_times, cancel_path=None):
    if not prompt_id:
        return None, None
    deadline = time.monotonic() + 3600
    waiting = False
    while time.monotonic() < deadline:
        await check_mosaic_cancel(session, cancel_path, prompt_id)
        record = await read_graph_history(session, prompt_id)
        if record and record.get("status", {}).get("status_str") == "success":
            return await graph_history_image(session, record, output_id, workflow_times, allow_missing=True), record
        queue = await request(session, "GET", "/queue")
        jobs = [*queue["queue_running"], *queue["queue_pending"]]
        if not any(job[1] == prompt_id for job in jobs):
            latest = await read_graph_history(session, prompt_id)
            if latest and latest.get("status", {}).get("status_str") == "success":
                return await graph_history_image(session, latest, output_id, workflow_times, allow_missing=True), latest
            return None, latest or record
        if not waiting:
            emit("status", f"{label} · 正在接回 ComfyUI 中的任务")
            waiting = True
        await asyncio.sleep(1)
    raise TimeoutError("等待 ComfyUI 恢复任务超时")


async def run_image_graph(session, graph, output_id, label, workflow_times, prompt_ids=None,
                          resume_id=None, old_history=None, cancel_path=None, trace=False):
    outputs = [key for key,n in graph.items() if n["class_type"] in ("PreviewImage","SaveImage","SaveImageAdvanced")]
    output_id = output_id or (outputs[0] if len(outputs)==1 else "")
    if output_id not in graph:
        raise ValueError("请选择工作流的图像输出节点 ID")
    client = uuid.uuid4().hex
    started = time.monotonic()
    pid = resume_id

    def log(stage, **details):
        if trace:
            mosaic_redraw_diagnostic(stage, promptId=pid, elapsedMs=round((time.monotonic() - started) * 1000), **details)

    log("connect")
    async with session.ws_connect(BASE + "/ws", params={"clientId": client}) as ws:
        payload = {"client_id": client, "prompt": graph}
        if resume_id:
            payload["prompt_id"] = resume_id
        await check_mosaic_cancel(session, cancel_path)
        log("submit")
        job = await request(session, "POST", "/prompt", json=payload)
        pid = job["prompt_id"]
        if trace:
            sampling_steps = sorted({node["inputs"]["steps"] for node in graph.values()
                                     if node["class_type"] == "KSampler"})
            log("queued", samplingSteps=sampling_steps)
        await check_mosaic_cancel(session, cancel_path, pid)
        if prompt_ids is not None:
            prompt_ids.append(pid)
        emit("status", f"{label} · 已提交，等待 ComfyUI")
        last_activity = time.monotonic()
        deadline = last_activity + 3600
        node_type = None
        first_progress = True
        stalled = False
        while time.monotonic() < deadline:
            try:
                packet = await ws.receive(timeout=4)
            except asyncio.TimeoutError:
                packet = None
            if trace and not stalled and time.monotonic() - last_activity >= 30:
                log("waiting", nodeType=node_type, idleMs=round((time.monotonic() - last_activity) * 1000))
                stalled = True
            await check_mosaic_cancel(session, cancel_path, pid)
            if packet is not None:
                if packet.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.ERROR):
                    log("socket_closed", nodeType=node_type)
                    raise RuntimeError("ComfyUI 进度连接已关闭")
                if packet.type != aiohttp.WSMsgType.TEXT:
                    continue
                event = packet.json()
                data = event.get("data", {})
                if data.get("prompt_id") != pid:
                    continue
                kind = event["type"]
                if trace and kind in ("execution_start", "executing", "progress"):
                    last_activity = time.monotonic()
                    node_type = graph.get(str(data.get("node")), {}).get("class_type") or node_type
                    if kind == "execution_start":
                        log("execution_start")
                    if kind == "progress" and first_progress:
                        log("first_progress", nodeType=node_type, step=data["value"], totalSteps=data["max"])
                        first_progress = False
                if kind == "progress":
                    emit("status", f"{label} · 采样 {data['value']} / {data['max']}")
                if kind == "execution_error":
                    log("execution_error", nodeType=node_type)
                    raise RuntimeError(data.get("exception_message") or "ComfyUI 执行失败")
                if kind == "execution_interrupted":
                    log("execution_interrupted", nodeType=node_type)
                    raise RuntimeError("ComfyUI 任务已中止")
                if kind not in ("execution_success", "executing") or data.get("node") is not None:
                    continue
            record = await read_graph_history(session, pid)
            if record and record != old_history:
                log("history_ready", status=record.get("status", {}).get("status_str"))
                return await graph_history_image(session, record, output_id, workflow_times)
        log("wait_timeout", nodeType=node_type)
        raise TimeoutError("等待 ComfyUI 结果超时")


def mosaic_region_boxes(original, regions):
    boxes = [region["box"] for region in regions]
    if not boxes:
        raise ValueError("去码蒙版没有覆盖可编辑像素")
    for left, top, right, bottom in boxes:
        if not (0 <= left < right <= original.width and 0 <= top < bottom <= original.height):
            raise ValueError("请检查去码蒙版坐标")
    return boxes


def mosaic_mask_margin(boxes, *, illustrious=False):
    span = max(min(right - left, bottom - top) for left, top, right, bottom in boxes)
    grow = max(2, min(6, round(span * .05)))
    if illustrious:
        feather = max(8, min(32, round(span * .16)))
        # Finish compositing before the latent mask boundary can affect the patch.
        return grow, feather, grow + feather + max(12, feather)
    feather = max(3, min(10, round(span * .08)))
    return grow, feather, grow + feather + 2


def mosaic_region_groups(original, regions, *, illustrious=False):
    boxes = mosaic_region_boxes(original, regions)
    _, _, margin = mosaic_mask_margin(boxes, illustrious=illustrious)
    parents = list(range(len(boxes)))

    def root(index):
        while parents[index] != index:
            parents[index] = parents[parents[index]]
            index = parents[index]
        return index

    ordered = sorted(range(len(boxes)), key=lambda index: tuple(boxes[index]))
    for position, index in enumerate(ordered):
        left, top, right, bottom = boxes[index]
        for other in ordered[position + 1:]:
            x, y, r, b = boxes[other]
            if x > right + 2 * margin:
                break
            if y <= bottom + 2 * margin and b >= top - 2 * margin:
                parents[root(other)] = root(index)
    grouped = {}
    for index in ordered:
        grouped.setdefault(root(index), []).append(regions[index])
    return list(grouped.values())


def mosaic_redraw_area(original, regions, protected, preserve_edges=False, allow_empty=False, *, illustrious=False, strict_mask=False):
    from scipy import ndimage

    boxes = mosaic_region_boxes(original, regions)

    left = min(box[0] for box in boxes)
    top = min(box[1] for box in boxes)
    right = max(box[2] for box in boxes)
    bottom = max(box[3] for box in boxes)
    grow, feather, expansion = mosaic_mask_margin(boxes, illustrious=illustrious)
    padding = expansion + max(48, round(max(right - left, bottom - top) * .25))
    bounds = (max(0, left - padding), max(0, top - padding),
              min(original.width, right + padding), min(original.height, bottom + padding))
    crop = original.crop(bounds)
    alpha = np.asarray(crop.getchannel("A"))
    editable = alpha > 0
    user_mask = np.zeros(alpha.shape, dtype=bool)
    x0, y0, x1, y1 = bounds
    for left, top, right, bottom in boxes:
        user_mask[top - y0:bottom - y0, left - x0:right - x0] = True
    for left, top, right, bottom in protected:
        left, top = max(left, x0), max(top, y0)
        right, bottom = min(right, x1), min(bottom, y1)
        if left < right and top < bottom:
            editable[top - y0:bottom - y0, left - x0:right - x0] = False

    core = user_mask & editable
    if not core.any():
        if allow_empty:
            return None
        raise ValueError("去码蒙版没有覆盖可编辑像素")
    if strict_mask:
        # Feather inward so neither sampling nor compositing crosses the user's boxes.
        inward = np.clip(ndimage.distance_transform_edt(core) / 2, 0, 1)
        blend = inward * inward * (3 - 2 * inward)
        samples = np.zeros_like(core)
        return bounds, crop, core, Image.fromarray(np.rint(blend * 255).astype(np.uint8)), samples
    distance = ndimage.distance_transform_edt(~core)
    generation = editable & (distance <= expansion)
    blend = np.clip(1 - (distance - grow) / feather, 0, 1)
    blend = blend * blend * (3 - 2 * blend)
    if preserve_edges and ((distance > grow) & (distance < grow + feather) & editable).any():
        rgb = ndimage.gaussian_filter(np.asarray(crop.convert("RGB"), dtype=np.float32), (.8, .8, 0))
        strength = np.hypot(ndimage.sobel(rgb, axis=0), ndimage.sobel(rgb, axis=1)).max(axis=2) / 8
        edges = np.clip((strength - 4) / 14, 0, 1)
        edges = ndimage.gaussian_filter(ndimage.maximum_filter(edges, size=3), .8)
        ramp = np.clip((distance - grow) / feather, 0, 1)
        # Keep clean contours in the transition band, with a smooth return to the original blend.
        blend *= 1 - .7 * edges * (4 * ramp * (1 - ramp)) ** 2
    blend[~editable] = 0
    # Sample intact, nearly opaque pixels within the generated border.
    samples = generation & (alpha >= 224) & (distance >= grow + feather) & (distance <= expansion)
    return bounds, crop, generation, Image.fromarray(np.rint(blend * 255).astype(np.uint8)), samples


def benchmark_storage_paths(root, argv):
    def option(name):
        for index, argument in enumerate(argv[1:], 1):
            if argument == name:
                return Path(argv[index + 1])
            if argument.startswith(name + "="):
                return Path(argument.split("=", 1)[1])
        return None

    # Relative overrides resolve from the server's current directory, which is not part of system_stats.
    base = option("--base-directory") or root / "ComfyUI"
    temp = option("--temp-directory")
    output = option("--output-directory")
    if any(value is not None and not value.is_absolute() for value in (base, temp, output)):
        raise ValueError("运行重绘测试时，ComfyUI 的 base、temp 和 output 自定义目录须使用绝对路径")
    return (temp / "temp" if temp else base / "temp").resolve(), (output or base / "output").resolve()


def remove_benchmark_directory(parent, subfolder):
    path = parent / subfolder
    if path.resolve().parent != parent:
        raise ValueError(f"无法安全清理测试临时目录：{path}")
    try:
        shutil.rmtree(path)
    except FileNotFoundError:
        pass


async def remove_benchmark_prompt(session, prompt_id):
    async def delete(route):
        async with session.post(BASE + route, json={"delete": [prompt_id]}, allow_redirects=False) as response:
            response.raise_for_status()

    # A transport failure can leave the submitted prompt in flight. Wait for its last write.
    await delete("/queue")
    while any(item[1] == prompt_id for item in (await request(session, "GET", "/queue"))["queue_running"]):
        await asyncio.sleep(1)
    await delete("/history")


@asynccontextmanager
async def benchmark_redraw_storage(session, root, argv, enabled):
    if not enabled:
        yield None, None
        return
    temp, output = benchmark_storage_paths(root, argv)
    subfolder = "llmchat-benchmark-" + uuid.uuid4().hex
    prompt_ids = []
    try:
        yield subfolder, prompt_ids
    finally:
        try:
            for prompt_id in prompt_ids:
                await remove_benchmark_prompt(session, prompt_id)
        finally:
            try:
                remove_benchmark_directory(temp, subfolder)
            finally:
                remove_benchmark_directory(output, subfolder)


def match_mosaic_colors(crop, restored, generation, samples):
    from scipy import ndimage

    original_rgb = np.asarray(crop.convert("RGB"))
    matched = np.array(restored)
    groups, _ = ndimage.label(generation)
    for label, region in enumerate(ndimage.find_objects(groups), 1):
        in_region = groups[region] == label
        sample = samples[region] & in_region
        if np.count_nonzero(sample) < 32:
            continue
        generated = matched[region]
        difference = original_rgb[region][sample].astype(np.int16) - generated[sample]
        bias = np.median(difference, axis=0)
        variation = np.median(np.abs(difference - bias), axis=0)
        # Inconsistent differences likely describe changed details rather than a color cast.
        reliability = np.clip((24 - variation) / 18, 0, 1)
        correction = np.rint(np.clip(bias, -24, 24) * reliability).astype(np.int16)
        if correction.any():
            generated[in_region] = np.clip(generated[in_region].astype(np.int16) + correction, 0, 255)
    return Image.fromarray(matched)


def edit_mosaic_size(crop_size):
    longest = max(crop_size)
    scale = min(768, max(512, longest)) / longest
    return tuple(max(16, round(side * scale / 16) * 16) for side in crop_size)


MOSAIC_WORKFLOW_KEYS = {"2511": "aligned-edit-regions-v2", "2511-lightning": "aligned-edit-lightning-regions-v2",
                        "turbo": "expanded-regions-v2",
                        "diffusion-cream": "diffusion-cream-regions-v2", "illustrious": "illustrious-regions-v4"}
ILLUSTRIOUS_CONTOUR_WORKFLOW_KEY = "illustrious-contours-v9"
EDIT_LIGHTNING_LORA = "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors"

ILLUSTRIOUS_WEIGHTS = ("checkpoints/Illustrious-XL-v2.0.safetensors",
                       "controlnet/controlnet-union-sdxl-1.0.safetensors")
SDXL_REFERENCE_WEIGHTS = ("clip_vision/CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors",
                          "ipadapter/ip-adapter-plus_sdxl_vit-h.safetensors")


def validate_mosaic_weights(directory, profile):
    if profile["kind"] == "illustrious":
        models = Path(directory) / "ComfyUI/models"
        weights = ILLUSTRIOUS_WEIGHTS + SDXL_REFERENCE_WEIGHTS if profile.get("referenceImage") else ILLUSTRIOUS_WEIGHTS
        missing = [name for name in weights if not (models / name).is_file()]
        if missing:
            raise ValueError("缺少本地权重：" + "、".join(missing))


def diffusion_mosaic_size(crop_size, illustrious):
    longest = max(crop_size)
    scale = (min(1024, max(768, longest)) if illustrious else 1152) / longest
    return tuple(max(64, round(side * scale / 8) * 8) for side in crop_size)


def mosaic_contour_blur(crop, mask, size):
    from scipy import ndimage, signal

    pixels = np.asarray(crop.convert("RGB").resize(size, Image.Resampling.LANCZOS), dtype=np.float32)
    editable = np.asarray(mask.resize(size, Image.Resampling.NEAREST)) > 0
    widths = []
    for axis in (1, 0):
        difference = np.abs(np.diff(pixels, axis=axis)).mean(axis=2)
        pairs = np.diff(editable.astype(np.int8), axis=axis) == 0
        pairs &= np.take(editable, range(editable.shape[axis] - 1), axis=axis)
        across = 1 - axis
        edges = (difference * pairs).sum(axis=across) / np.maximum(pairs.sum(axis=across), 1)
        edges = ndimage.gaussian_filter1d(edges, .8)
        positive = edges[edges > 0]
        prominence = max(1.0, float(np.percentile(positive, 90)) * .25) if positive.size else 1.0
        peaks, _ = signal.find_peaks(edges, prominence=prominence, distance=2)
        gaps = np.diff(peaks)
        if len(gaps) < 2:
            widths.append(None)
            continue
        width = float(np.median(gaps))
        regular = np.abs(gaps - width) <= max(2, width * .2)
        widths.append(round(float(np.median(gaps[regular])), 2) if regular.mean() >= .6 else None)
    measured = [width for width in widths if width is not None]
    if not measured:
        raise ValueError("无法从蒙版内测得重复的马赛克格宽，请检查蒙版是否覆盖足够的马赛克格")
    # An odd kernel slightly larger than one measured cell, in sampling-resolution pixels.
    kernel = int(np.ceil(max(measured) * 1.2)) | 1
    return {"cellWidthX": widths[0], "cellWidthY": widths[1], "blurKernel": max(3, kernel),
            "width": size[0], "height": size[1]}


def diffusion_cream_workflow(source_name, reference_name, mask_name, steps, seed, crop_size, guide_mask_name, kind="diffusion-cream"):
    # DiffusionCreamPy Mosaic-CNet++, using the game workbench's existing crop and final blend.
    illustrious = kind == "illustrious"
    width, height = diffusion_mosaic_size(crop_size, illustrious)

    def node(kind, **inputs):
        return {"class_type": kind, "inputs": inputs}

    graph = {
        "4": node("LoadImage", image=source_name),
        "17": node("LoadImage", image=mask_name),
        "18": node("ImageToMask", image=["17", 0], channel="red"),
        "5": node("ImageAndMaskResizeNode", image=["4", 0], mask=["18", 0], width=width, height=height,
                  resize_method="lanczos", crop="disabled", mask_blur_radius=0),
        "30": node("CheckpointLoaderSimple", ckpt_name="animagine-xl-4.0-opt.safetensors"),
        "6": node("CLIPTextEncode", clip=["30", 1],
                  text="Anime game illustration, continuous linework, coherent proportions and shading, fine local texture"),
        "7": node("CLIPTextEncode", clip=["30", 1],
                  text="mosaic artifacts, flat color fills, distorted proportions, broken outlines, duplicated forms"),
        "43": node("LoadImage", image=guide_mask_name),
        "44": node("ImageScale", image=["43", 0], width=width, height=height, upscale_method="nearest-exact", crop="disabled"),
        "45": node("ImageToMask", image=["44", 0], channel="red"),
        "32": node("ACN_ControlNet++InputNode", image=["41" if illustrious else "31", 0], control_type="tile"),
        "33": node("ACN_ControlNet++LoaderAdvanced", plus_input=["32", 0], name="controlnet-union-sdxl-1.0.safetensors"),
        "34": node("InpaintModelConditioning", positive=["6", 0], negative=["7", 0], vae=["30", 2],
                   pixels=["41", 0], mask=["5", 1], noise_mask=True),
        "35": node("ACN_AdvancedControlNetApply_v2", positive=["34", 0], negative=["34", 1], control_net=["33", 0],
                   image=["33", 1], strength=0.74, start_percent=0.0, end_percent=0.8),
        "13": node("KSampler", model=["30", 0], seed=seed, steps=steps, cfg=7, sampler_name="euler", scheduler="beta",
                   positive=["35", 0], negative=["35", 1], latent_image=["34", 2], denoise=0.78),
        "36": node("VAEDecode", samples=["13", 0], vae=["30", 2]),
        "14": node("INPAINT_ColorMatch", target=["36", 0], reference=["5", 0], exclude_mask=["5", 1], strength=1.0),
        "15": node("PreviewImage", images=["14", 0]),
    }
    if illustrious:
        graph["30"]["inputs"]["ckpt_name"] = "Illustrious-XL-v2.0.safetensors"
        graph["6"]["inputs"]["text"] = (
            "anime illustration, crisp ink outlines, coherent silhouettes, continuous linework, consistent line weight and "
            "shading, same hues and materials, highlights following the original lighting, smooth surface, preserve occlusion")
        graph["7"]["inputs"]["text"] = (
            "pixelation, checkerboard, grid lines, broken outlines, unrelated objects, smeared colors, blocky edges")
        # Carry the coarse silhouette and palette into sampling, with Tile limited to earlier timesteps.
        graph["41"] = node("INPAINT_MaskedBlur", image=["5", 0], mask=["45", 0], blur=47, falloff=9)
        graph["35"]["inputs"].update(strength=0.65, end_percent=0.52)
        graph["13"]["inputs"].update(steps=22, cfg=5, scheduler="karras", denoise=0.67)
        graph["14"]["inputs"]["exclude_mask"] = ["45", 0]
    else:
        guide_blur = max(31, min(97, round(min(width, height) * .073)))
        graph["41"] = node("INPAINT_MaskedBlur", image=["5", 0], mask=["45", 0], blur=guide_blur, falloff=0)
        graph["31"] = node("TilePreprocessor", image=["41", 0], pyrUp_iters=3, resolution=512)
    if reference_name:
        graph["16"] = node("LoadImage", image=reference_name)
        graph["37"] = node("CLIPVisionLoader", clip_name="CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors")
        graph["38"] = node("IPAdapterModelLoader", ipadapter_file="ip-adapter-plus_sdxl_vit-h.safetensors")
        graph["39"] = node("IPAdapterEncoder", ipadapter=["38", 0], image=["16", 0], clip_vision=["37", 0], weight=1.0)
        graph["40"] = node("IPAdapterEmbeds", model=["30", 0], ipadapter=["38", 0], pos_embed=["39", 0],
                           neg_embed=["39", 1], attn_mask=["5", 1], weight=0.35, weight_type="style transfer",
                           start_at=0.4, end_at=0.85, embeds_scaling="V only")
        graph["13"]["inputs"]["model"] = ["40", 0]
    return graph


def add_illustrious_edge_refinement(graph):
    def node(kind, **inputs):
        return {"class_type": kind, "inputs": inputs}

    first_image = graph["15"]["inputs"]["images"]
    sampler = graph["13"]["inputs"]
    graph.update({
        "51": node("CLIPTextEncode", clip=["30", 1],
                   text="preserve the input illustration's existing silhouettes, positions, occlusion, hues and materials, "
                        "continuous ink lines matching the surrounding line weight, crisp ink outlines and hard-edged highlights"),
        "52": node("CLIPTextEncode", clip=["30", 1],
                   text="soft focus, blurred contours, airbrushed shading, pixel grid, new forms, changed silhouettes"),
        "53": node("INPAINT_MaskedFill", image=["5", 0], mask=["45", 0], fill="neutral", falloff=0),
        "54": node("InvertMask", mask=["45", 0]),
        "55": node("ACN_ControlNet++InputNode", image=["53", 0], control_type="tile"),
        "56": node("ACN_ControlNet++LoaderAdvanced", plus_input=["55", 0], name=graph["33"]["inputs"]["name"]),
        "57": node("InpaintModelConditioning", positive=["51", 0], negative=["52", 0], vae=["30", 2],
                   pixels=["36", 0], mask=["5", 1], noise_mask=True),
        "58": node("ACN_AdvancedControlNetApply_v2", positive=["57", 0], negative=["57", 1], control_net=["56", 0],
                   image=["56", 1], mask_optional=["54", 0], strength=0.45, start_percent=0.0, end_percent=1.0),
        "59": node("KSampler", **{**sampler, "steps": 12, "denoise": 0.50,
                                  "positive": ["58", 0], "negative": ["58", 1], "latent_image": ["57", 2]}),
        "60": node("VAEDecode", samples=["59", 0], vae=["30", 2]),
        "61": node("PreviewImage", images=first_image),
    })
    graph["61"]["_meta"] = {"title": "轮廓底图"}
    graph["59"]["_meta"] = {"title": "边缘重绘"}
    graph["15"]["inputs"]["images"] = ["60", 0]


def mosaic_target_prompt(profile):
    return " Repair only inside the mask. Follow existing contours and occlusion. Keep pixels outside the mask unchanged."


def mosaic_workflow(source_name, reference_name, mask_name, steps, profile, crop_size=None, guide_mask_name=None, contour_blur=None):
    target = mosaic_target_prompt(profile) if mask_name is not None and profile["kind"] != "illustrious" else ""
    target_negative = "mosaic artifacts, flat color fills, broken outlines, distorted proportions, duplicated forms"
    if profile["kind"] in ("diffusion-cream", "illustrious"):
        graph = diffusion_cream_workflow(source_name, reference_name, mask_name, steps,
                                        profile.get("seed", 1), crop_size, guide_mask_name, profile["kind"])
        if profile["kind"] == "illustrious" and profile.get("preserveContours"):
            # Keep visible contours in the guide and retain Tile through the low-noise steps.
            if contour_blur is None:
                raise ValueError("轮廓重绘需要先测量当前裁剪的马赛克格宽")
            graph["41"]["inputs"].update(blur=contour_blur, falloff=3)
            graph["35"]["inputs"].update(strength=0.65, end_percent=1.0)
            graph["13"]["inputs"].update(denoise=0.45)
            graph["6"]["inputs"]["text"] = (
                "anime illustration, preserve existing silhouettes, positions and occlusion boundaries, "
                "continuous ink outlines matching surrounding line weight, same hues and materials, "
                "hard-edged highlights following the original lighting")
        if target:
            graph["6"]["inputs"]["text"] += target
        return graph
    local_edit = profile["kind"] in ("2511", "2511-lightning") and mask_name is not None
    prompt = ("Remove the mosaic or pixelation within the masked area of image 1 and reconstruct continuous linework and shading. "
              "Preserve the pose, composition, outline, palette and the existing illustration style. "
              "Match the colors, shading and brightness immediately around the repaired area in image 1. "
              "Keep everything outside the mask unchanged.")
    if mask_name is None:
        prompt = prompt.replace("within the masked area of image 1", "in image 1").replace(
            "outside the mask", "away from the pixelation")
    if local_edit:
        prompt += (" Follow the visible contours into the mask. Preserve the target's silhouette, proportions, "
                   "placement, and occlusion boundaries. For human figures, keep anatomy and connected body parts coherent. "
                   "Rebuild fine contours, texture, and shading transitions.")
    if reference_name:
        prompt += (" Use image 2 only as a guide to linework and rendering style. "
                   "Use image 1 for all proportions, placement and local colors." if local_edit
                   else " Use image 2 for style and retain the local colors of image 1.")
    graph = workflow(source_name, reference_name, "", steps, None, profile, edit_prompt=prompt + target)
    if target and profile["kind"] == "turbo":
        graph["5"]["inputs"]["negative_prompt"] = target_negative
    if mask_name is not None:
        sampler = graph["13"]["inputs"]
        graph["17"] = {"class_type": "LoadImage", "inputs": {"image": mask_name}}
        graph["18"] = {"class_type": "ImageToMask", "inputs": {"image": ["17", 0], "channel": "red"}}
        graph["19"] = {"class_type": "SetLatentNoiseMask", "inputs": {"samples": sampler["latent_image"], "mask": ["18", 0]}}
        sampler["latent_image"] = ["19", 0]
    if local_edit:
        width, height = edit_mosaic_size(crop_size)
        scale = {"width": width, "height": height, "crop": "disabled"}
        graph["5"] = {"class_type": "ImageScale", "inputs": {
            **scale, "image": ["4", 0], "upscale_method": "lanczos"}}
        graph["26"] = {"class_type": "ImageScale", "inputs": {
            **scale, "image": ["17", 0], "upscale_method": "nearest-exact"}}
        graph["18"]["inputs"]["image"] = ["26", 0]
        graph["7"]["inputs"]["prompt"] = "Flat color fill, missing texture, broken outlines, distorted proportions, duplicated forms."
        if target:
            graph["7"]["inputs"]["prompt"] += " " + target_negative + "."
        # Reuse the aligned target latent. The style image stays in the vision encoder.
        for encoder, conditioner, ref in (("6", "8", "27"), ("7", "9", "28")):
            del graph[encoder]["inputs"]["vae"]
            graph[ref] = {"class_type": "ReferenceLatent", "inputs": {
                "conditioning": [encoder, 0], "latent": ["12", 0]}}
            graph[conditioner]["inputs"]["conditioning"] = [ref, 0]
    if profile["kind"] == "2511-lightning":
        # CFG=1 uses only the positive prediction. Avoid a second image/text encoding.
        graph["13"]["inputs"]["negative"] = graph["13"]["inputs"]["positive"]
        for key in ("7", "9", "28"):
            graph.pop(key, None)
    return graph


def mosaic_reference_input(reference, original, bounds, kind):
    with Image.open(io.BytesIO(base64.b64decode(reference, validate=True))) as image:
        if kind in ("diffusion-cream", "illustrious"):
            reference_image = image.convert("RGB")
            reference_image.thumbnail((640, 640), Image.Resampling.LANCZOS)
            # Reuse the ComfyUI image and vision-encoder cache for later images in the group.
            digest = hashlib.sha256(png(reference_image)).hexdigest()
            return reference_image, f"llmchat-style-{digest}.png"
        ref_bounds = tuple(round(value * (image.width / original.width if index % 2 == 0 else image.height / original.height))
                           for index, value in enumerate(bounds))
        return image.crop(ref_bounds).convert("RGB"), None


def mosaic_core_mask(blend, threshold=255):
    return blend.point([0] * threshold + [255] * (256 - threshold))


def mosaic_redraw_areas(original, regions, profile):
    areas = []
    illustrious = profile["kind"] == "illustrious"
    for group in mosaic_region_groups(original, regions, illustrious=illustrious):
        area = mosaic_redraw_area(original, group, profile.get("keep", []),
                                  preserve_edges=illustrious or profile["kind"] == "diffusion-cream",
                                  allow_empty=True, illustrious=illustrious, strict_mask=illustrious and bool(profile.get("preserveContours")))
        if area is not None:
            areas.append(area)
    if not areas:
        raise ValueError("去码蒙版没有覆盖可编辑像素")
    return areas


def remap_mosaic_nodes(graph, ids):
    result = {}
    for key, node in graph.items():
        inputs = {name: [ids[value[0]], value[1]]
                  if isinstance(value, list) and len(value) == 2 and isinstance(value[0], str) and value[0] in ids
                  else value for name, value in node["inputs"].items()}
        result[ids[key]] = {**node, "inputs": inputs}
    return result


async def mosaic_region_graphs(original, areas, profile, steps, upload):
    source_name = await upload(original, workflow_input_name(profile.get("name", "")))
    graph = {"original": {"class_type": "LoadImage", "inputs": {"image": source_name},
                           "_meta": {"title": "目标原图"}}}
    outputs = []
    illustrious = profile["kind"] == "illustrious"
    reference = profile.get("referenceImage")
    for index, (bounds, crop, generation, blend, _) in enumerate(areas):
        if illustrious:
            # Apply the full sampling mask in the core and taper through the blend and overscan.
            noise_mask = np.where(generation, np.rint(51 + np.asarray(blend) * .8), 0).astype(np.uint8)
        else:
            noise_mask = generation.astype(np.uint8) * 255
        mask_name = await upload(Image.fromarray(noise_mask).convert("RGB"))
        guide_name = None
        guide = None
        if illustrious or profile["kind"] == "diffusion-cream":
            guide = mosaic_core_mask(blend, 128 if illustrious else 255)
            guide_name = await upload(guide)
        reference_name = await upload(*mosaic_reference_input(reference, original, bounds, profile["kind"])) if reference else None
        contour_blur = None
        if illustrious and profile.get("preserveContours"):
            measured = mosaic_contour_blur(crop, Image.fromarray(generation.astype(np.uint8) * 255),
                                           diffusion_mosaic_size(crop.size, True))
            contour_blur = measured["blurKernel"]
            mosaic_redraw_diagnostic("contour_grid_measurement", region=index + 1, seed=profile.get("seed", 1), **measured)
            widths = " / ".join(f"{axis} {measured[key]:g}" for axis, key in
                                (("横", "cellWidthX"), ("纵", "cellWidthY")) if measured[key] is not None)
            emit("status", f"区域 {index + 1} · 放大后格宽 {widths} 像素 · 模糊核 {contour_blur}")
        local = mosaic_workflow(source_name, reference_name, mask_name, steps, profile, crop.size, guide_name, contour_blur)
        if illustrious and guide.getextrema() == (255, 255):
            # There are no original pixels for color matching when the guide covers the entire crop.
            del local["14"]
            local["15"]["inputs"]["images"] = ["36", 0]
        if illustrious and profile.get("preserveContours"):
            add_illustrious_edge_refinement(local)
        left, top, _, _ = bounds
        local["4"] = {"class_type": "ImageCrop", "inputs": {
            "image": ["original", 0], "width": crop.width, "height": crop.height, "x": left, "y": top}}
        prefix = f"region_{index}_"
        local["4"]["_meta"] = {"title": f"区域 {index + 1} · 原图裁剪"}
        local["17"]["_meta"] = {"title": f"区域 {index + 1} · 生成蒙版"}
        graph.update(remap_mosaic_nodes(local, {key: prefix + key for key in local}))
        outputs.append(prefix + "15")
    # One ComfyUI job keeps cancellation and recovery atomic across all local regions.
    graph["15"] = {"class_type": "PreviewImage", "inputs": {
        "images": graph[outputs[0]]["inputs"]["images"]}}
    return graph, outputs


async def prepare_mosaic_workflow(original, data, steps):
    profile = data["profile"]
    if profile["kind"] not in MOSAIC_WORKFLOW_KEYS:
        raise ValueError("请选择可用的去码重绘模型")
    validate_mosaic_weights(data["directory"], profile)
    masked = bool(data["regions"])
    if not masked and profile["kind"] in ("diffusion-cream", "illustrious"):
        raise ValueError("使用动漫局部修复前，请先为当前图片添加蒙版")
    areas = mosaic_redraw_areas(original, data["regions"], profile) if masked else []
    reference = profile.get("referenceImage")
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=120)) as session:
        await ready(session, Path(data["directory"]))
        async def upload(image, filename=None):
            return await upload_image(session, image, "input", filename, "llmchat-mosaic")

        if not masked:
            source_name = await upload(original, workflow_input_name(profile.get("name", "")))
            reference_name = await upload(*mosaic_reference_input(reference, original,
                (0, 0, original.width, original.height), profile["kind"])) if reference else None
            graph = mosaic_workflow(source_name, reference_name, None, steps, profile)
            graph["4"]["_meta"] = {"title": "目标原图"}
            if original.getchannel("A").getextrema() != (255, 255):
                graph["25"] = {"class_type": "JoinImageWithAlpha", "inputs": {
                    "image": graph["15"]["inputs"]["images"], "alpha": ["4", 1]}}
                graph["15"]["inputs"]["images"] = ["25", 0]
            return graph

        graph, outputs = await mosaic_region_graphs(original, areas, profile, steps, upload)
        destination = ["original", 0]
        for index, ((bounds, crop, _, blend, _), output) in enumerate(zip(areas, outputs)):
            left, top, _, _ = bounds
            prefix = f"merge_{index}_"
            graph[prefix + "image"] = {"class_type": "ImageScale", "inputs": {
                "image": graph[output]["inputs"]["images"], "upscale_method": "lanczos",
                "width": crop.width, "height": crop.height, "crop": "disabled"}}
            graph[prefix + "mask"] = {"class_type": "LoadImage", "inputs": {"image": await upload(blend)}}
            graph[prefix + "alpha"] = {"class_type": "ImageToMask", "inputs": {"image": [prefix + "mask", 0], "channel": "red"}}
            graph[prefix + "composite"] = {"class_type": "ImageCompositeMasked", "inputs": {
                "destination": destination, "source": [prefix + "image", 0], "mask": [prefix + "alpha", 0],
                "x": left, "y": top, "resize_source": False}}
            destination = [prefix + "composite", 0]
            del graph[output]
        graph["15"]["inputs"]["images"] = destination
        if original.getchannel("A").getextrema() != (255, 255):
            graph["25"] = {"class_type": "JoinImageWithAlpha", "inputs": {
                "image": graph["15"]["inputs"]["images"], "alpha": ["original", 1]}}
            graph["15"]["inputs"]["images"] = ["25", 0]
        ids = {key: key if key.isdecimal() else str(index + 100) for index, key in enumerate(graph)}
        return remap_mosaic_nodes(graph, ids)


async def repair_mosaic(original, data, steps, workflow_times):
    profile = data["profile"]
    if profile["kind"] not in MOSAIC_WORKFLOW_KEYS:
        raise ValueError("请选择可用的去码重绘模型")
    validate_mosaic_weights(data["directory"], profile)
    preserve_edges = profile["kind"] in ("diffusion-cream", "illustrious")
    areas = mosaic_redraw_areas(original, data["regions"], profile)
    mosaic_redraw_diagnostic("redraw_prepare", model=profile["kind"], regions=len(areas), requestedSteps=steps)
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=120)) as session:
        root = Path(data["directory"])
        cancel_path = data.get("cancelPath")
        argv = await ready(session, root, cancel_path, True)
        async with benchmark_redraw_storage(session, root, argv, profile.get("benchmark")) as (subfolder, prompt_ids):
            prompt_id = profile.get("promptId")
            workflow_key = MOSAIC_WORKFLOW_KEYS[profile["kind"]]
            if profile["kind"] == "illustrious" and profile.get("preserveContours"):
                workflow_key = ILLUSTRIOUS_CONTOUR_WORKFLOW_KEY
            resume_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"urn:llmchat:mosaic:{workflow_key}:{prompt_id}")) if prompt_id else None
            raw, history = await recover_image_graph(session, resume_id, "15", "蒙版重绘", workflow_times, cancel_path)
            patches = [raw] if raw is not None else []
            if raw is not None:
                for index in range(1, len(areas)):
                    await check_mosaic_cancel(session, cancel_path)
                    extra = await graph_history_image(session, history, f"region_{index}_15", [], allow_missing=True)
                    if extra is None:
                        patches = []
                        workflow_times.clear()
                        break
                    patches.append(extra)
            if not patches:
                async def upload(image, filename=None):
                    return await upload_image(session, image, filename=filename, subfolder=subfolder)

                graph, outputs = await mosaic_region_graphs(original, areas, profile, steps, upload)
                if subfolder:
                    for output, node in list(graph.items()):
                        if node["class_type"] == "PreviewImage":
                            graph[output] = {"class_type": "SaveImage", "inputs": {
                                "images": node["inputs"]["images"], "filename_prefix": subfolder + "/" + output}}
                submitted = prompt_ids if prompt_ids is not None else []
                raw = await run_image_graph(session, graph, "15", "蒙版重绘", workflow_times, submitted,
                                            resume_id=resume_id, old_history=history, cancel_path=cancel_path, trace=True)
                patches = [raw]
                if len(areas) > 1:
                    history = await read_graph_history(session, submitted[-1])
                    for output in outputs[1:]:
                        await check_mosaic_cancel(session, cancel_path)
                        patches.append(await graph_history_image(session, history, output, []))
    result = original.copy()
    for raw, (bounds, crop, generation, blend, samples) in zip(patches, areas):
        with Image.open(io.BytesIO(raw)) as output:
            restored = output.convert("RGB").resize(crop.size, Image.Resampling.LANCZOS)
        if not preserve_edges:
            restored = match_mosaic_colors(crop, restored, generation, samples)
        restored.putalpha(crop.getchannel("A"))
        result.paste(Image.composite(restored, result.crop(bounds), blend), bounds)
    return result


def ink_components(crop):
    from scipy import ndimage
    from PIL import ImageDraw
    alpha = np.asarray(crop)[:, :, 3]
    components, _ = ndimage.label(alpha > 40, np.ones((3, 3)))
    protected = np.zeros(alpha.shape, dtype=bool)
    t = np.linspace(0, np.pi * 2, 120)
    x = 16 * np.sin(t) ** 3
    y = -(13*np.cos(t)-5*np.cos(2*t)-2*np.cos(3*t)-np.cos(4*t))
    def shapes(strokes, weight):
        points = np.concatenate(strokes)
        for angle in range(0, 360, 10):
            rad = np.deg2rad(angle)
            rotated = points @ np.array([[np.cos(rad),np.sin(rad)],[-np.sin(rad),np.cos(rad)]])
            normalized = 3 + 25 * (rotated-rotated.min(axis=0)) / np.ptp(rotated,axis=0)
            template = Image.new("L",(32,32))
            draw = ImageDraw.Draw(template)
            start=0
            for stroke in strokes:
                end=start+len(stroke)
                draw.line([tuple(p) for p in normalized[start:end]],fill=255,width=weight)
                start=end
            yield np.asarray(template)>0

    heart = np.column_stack((x,y))
    hearts = list(shapes([np.vstack((heart,heart[0]))], 5))
    arrows = list(shapes([np.array([[0,4],[18,4]]),np.array([[0,10],[18,10]]),
                          np.array([[12,0],[22,7],[12,14]])],5))
    for label, bounds in enumerate(ndimage.find_objects(components), 1):
        if bounds is None:
            continue
        item = components[bounds] == label
        h,w = item.shape
        if min(h,w) < 6 or not 0.48 < w/h < 2:
            continue
        holes = ndimage.binary_fill_holes(item) & ~item
        count = ndimage.label(holes)[1]
        area = np.count_nonzero(item)
        if count == 1 and holes.sum() >= area * .4:
            templates, threshold = hearts, .40
        elif not count and min(h,w) >= 11 and .78 <= w/h <= 1.28 and .32 <= area/(w*h) <= .55:
            templates, threshold = arrows, .42
        else:
            continue
        fitted = np.zeros((32,32),dtype=bool)
        fitted[1:31,1:31] = np.asarray(Image.fromarray(item).resize((30,30),Image.Resampling.NEAREST))
        score = max(np.count_nonzero(fitted & template)/np.count_nonzero(fitted | template) for template in templates)
        if score >= threshold:
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


@lru_cache(maxsize=16)
def font_glyph_probe(path):
    from PIL import ImageFont

    font = ImageFont.truetype(path, 32)
    mask = font.getmask("\U0010ffff")
    return font, (mask.size, bytes(mask))


@lru_cache(maxsize=4096)
def font_has_glyph(path, char):
    font, missing = font_glyph_probe(path)
    mask = font.getmask(char)
    return (mask.size, bytes(mask)) != missing


def font_for_lettering(path, text):
    chars = {char for char in text if not char.isspace()}
    missing = sum(not font_has_glyph(path, char) for char in chars)
    if not missing:
        return path
    fonts = Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts"
    best = path
    for name in ("msyh.ttc", "simhei.ttf", "seguisym.ttf", "msgothic.ttc"):
        candidate = str(fonts / name)
        if candidate == path or not Path(candidate).is_file():
            continue
        unsupported = sum(not font_has_glyph(candidate, char) for char in chars)
        if unsupported < missing:
            best, missing = candidate, unsupported
            if not missing:
                break
    return best


class InsufficientInk(ValueError):
    pass


def nearby_opaque_ink(original, box, occupied):
    from scipy import ndimage

    x, y, right, bottom = box
    width, height = right-x, bottom-y
    dx = min(80, max(12, round(max(height*1.4, width*.65))))
    dy = min(45, max(8, round(height*1.45)))
    l, t = max(0,x-dx), max(0,y-dy)
    r, b = min(original.width,right+dx), min(original.height,bottom+dy)
    pixels = np.asarray(original.crop((l,t,r,b)))
    if pixels[:,:,3].min() < 255:
        return None
    rgb = pixels[:,:,:3].astype(np.int16)
    background = np.median(rgb[y-t:bottom-t,x-l:right-l].reshape(-1,3), axis=0)
    delta = rgb-background

    def find_line(mask, max_component_height):
        labels, count = ndimage.label(mask)
        keep = np.zeros(count+1,dtype=bool)
        for label, bounds in enumerate(ndimage.find_objects(labels), 1):
            if bounds is None:
                continue
            yy, xx = bounds
            w, h = xx.stop-xx.start, yy.stop-yy.start
            if h > max_component_height or (w > max(12,height*2.2) and w > h*4):
                continue
            keep[label] = np.count_nonzero(labels[bounds]==label) >= 3
        ink = keep[labels]
        joined, _ = ndimage.label(ndimage.maximum_filter(ink, size=(1, round(max(3,height*.6))|1)))
        candidates = []
        for label,bounds in enumerate(ndimage.find_objects(joined),1):
            if bounds is None:
                continue
            yy, xx = bounds
            ys, xs = np.where(ink[bounds] & (joined[bounds]==label))
            if not len(xs):
                continue
            left, top = l+xx.start+int(xs.min()), t+yy.start+int(ys.min())
            end, low = l+xx.start+int(xs.max())+1, t+yy.start+int(ys.max())+1
            w, h = end-left, low-top
            if not max(5,height*.35) <= h <= height*1.45 or not max(10,width*.19) <= w <= width*1.55 or len(xs) < w*h*.09:
                continue
            horizontal_gap, vertical_gap = max(0,left-right,x-end), max(0,top-bottom,y-low)
            if horizontal_gap > dx*.65 or vertical_gap > height*.75:
                continue
            distance = np.hypot((left+end-x-right)/(2*max(width,35)), (top+low-y-bottom)/(2*height))
            score = distance + horizontal_gap/dx + vertical_gap/dy + abs(np.log(w/width))*.24
            candidate = (max(0,left-2),max(0,top-2),min(original.width,end+2),min(original.height,low+2))
            candidates.append((score,candidate))
        candidates.sort()
        if not candidates or candidates[0][0] > 1.55 or (len(candidates)>1 and candidates[1][0]-candidates[0][0] < .10):
            return None
        return candidates[0][1]

    mask = np.max(np.abs(delta),axis=2)>35
    # Reserve competing labels of the same scale. A long line's OCR box can be much wider than its text.
    for left,top,end,low in occupied:
        if end-left > width*1.6:
            continue
        a,c,d,e = max(0,left-l),max(0,top-t),min(r-l,end-l),min(b-t,low-t)
        if a<d and c<e:
            mask[c:e,a:d] = False
    found = find_line(mask,max(5,height*1.5))
    if found:
        return found
    # Separate dark text from a nearby colored label when both were included in one wide OCR box.
    return find_line((delta.min(axis=2)<-35) & (delta.max(axis=2)<-18),max(5,height*1.12))



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
        raise InsufficientInk("选区没有足够的可见笔画，请调整范围")
    coords = np.column_stack((xs,ys))
    vals,vecs = np.linalg.eigh(np.cov(coords.T))
    axis = vecs[:,-1] if vals[-1] > 1.35*vals[0] else np.array([1.,0.])
    if axis[0] < 0: axis = -axis
    normal = np.array([-axis[1],axis[0]])
    along, across = coords @ axis, coords @ normal
    center = axis*(along.min()+along.max())/2 + normal*(across.min()+across.max())/2
    colors,counts=np.unique(rgba[ys,xs,:3],axis=0,return_counts=True)
    color=tuple(map(int,colors[counts.argmax()]))+(255,)
    font=ImageFont.truetype(font_for_lettering(font_path, translation), 128)
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


def game_image_kind(original, name):
    alpha = np.asarray(original)[:, :, 3]
    clear_ratio = np.mean(alpha < 16)
    if clear_ratio < .10:
        return "background"
    if any(word in name.lower().replace("_", "") for word in ("logo", "title", "wordmark")):
        return "logo"
    return "lettering" if np.mean(alpha > 40) < .06 else "background"


def transparent_ocr_sheet(original, name):
    from scipy import ndimage

    if game_image_kind(original, name) != "lettering":
        return {"regions": []}
    alpha = np.asarray(original)[:, :, 3]
    ink = alpha > 40
    padding = max(4, min(15, round(max(original.size) / 80)))
    components, _ = ndimage.label(ndimage.maximum_filter(ink, size=padding * 2 + 1))
    tiles = []
    for index, bounds in enumerate(ndimage.find_objects(components), 1):
        if bounds is None:
            continue
        y, x = bounds
        mask = (components[bounds] == index) & ink[bounds]
        ys, xs = np.nonzero(mask)
        if len(xs) < 12:
            continue
        left, top = x.start + int(xs.min()), y.start + int(ys.min())
        right, bottom = x.start + int(xs.max()) + 1, y.start + int(ys.max()) + 1
        box = (max(0, left-5), max(0, top-5), min(original.width, right+5), min(original.height, bottom+5))
        selection = (slice(box[1],box[3]),slice(box[0],box[2]))
        tile = np.array(original.crop(box))
        tile[:, :, 3][components[selection] != index] = 0
        angle = 0.
        ornaments = ink_components(Image.fromarray(tile))
        gy,gx = np.nonzero((tile[:,:,3]>40)&~ornaments)
        vals, axes = np.linalg.eigh(np.cov(np.column_stack((gx,gy)).T)) if len(gx)>=2 else (np.zeros(2),np.eye(2))
        if vals[-1] > 1.5 * vals[0]:
            axis = axes[:, -1] * (-1 if axes[0,-1] < 0 else 1)
            tilt = np.degrees(np.arctan2(axis[1],axis[0]))
            if 11 <= abs(tilt) <= 76:
                angle = float(tilt)
        tile[:,:,3][ornaments]=0
        if not np.any(tile[:,:,3]>40):
            continue
        enlarged = Image.fromarray(tile).resize((tile.shape[1]*4,tile.shape[0]*4),Image.Resampling.NEAREST).rotate(angle,expand=True)
        enlarged = enlarged.crop(enlarged.getchannel("A").getbbox())
        enlarged.thumbnail((480,224),Image.Resampling.LANCZOS)
        tiles.append((box, angle, enlarged))
    return numbered_ocr_sheet(tiles, "lettering")


def numbered_ocr_sheet(tiles, kind):
    from PIL import ImageDraw

    if not 1 <= len(tiles) <= 10:
        return {"regions": []}
    tiles.sort(key=lambda entry: (entry[0][1],entry[0][0]))
    rows = [(i+1,box,angle,tile) for i,(box,angle,tile) in enumerate(tiles)]
    row_height = max(tile.height for _,_,_,tile in rows) + 35
    column_width = max(tile.width for _,_,_,tile in rows) + 20
    columns = 1 if len(rows) == 1 else 2
    sheet = Image.new("RGBA",(columns*column_width,((len(rows)+columns-1)//columns)*row_height),"#545464")
    draw = ImageDraw.Draw(sheet)
    regions = []
    for number,box,angle,tile in rows:
        x = ((number-1)%columns)*column_width + 9
        y = ((number-1)//columns)*row_height
        draw.text((x,y+4),f"[{number}]",fill="white")
        sheet.alpha_composite(tile,(x,y+23))
        regions.append({"box":box,"angle":round(angle,1),"tile":[x-5,y,x+tile.width+5,y+tile.height+26]})
    return {"kind": kind, "image": base64.b64encode(png(sheet)).decode("ascii"),"regions":regions}


def annotated_ocr_sheet(original, encoded_background):
    from scipy import ndimage

    pixels = np.asarray(original)
    background = matching_game_background(pixels,encoded_background,[])
    if background is None:
        return {"regions": []}
    delta = np.max(np.abs(pixels[:,:,:3].astype(np.int16)-background[:,:,:3]),axis=2) > 9
    rgb = pixels[:,:,:3]
    white = delta & (rgb.min(axis=2)>=187) & (np.ptp(rgb,axis=2)<45)
    scale = max(.55, min(2.,original.width / 1366))
    groups, _ = ndimage.label(ndimage.maximum_filter(white,size=(3, max(9,round(21*scale)|1))))
    tiles=[]
    for index,bounds in enumerate(ndimage.find_objects(groups),1):
        if bounds is None:
            continue
        y,x=bounds
        text = white[bounds] & (groups[bounds]==index)
        ys,xs=np.where(text)
        if not xs.size:
            continue
        w,h=np.ptp(xs)+1,np.ptp(ys)+1
        if w<42*scale or h<8*scale or h>300*scale or w/h<.8 or text.sum()/(w*h)<.14:
            continue
        dense = text.sum(axis=1) >= max(6,min(32,round(w*.08)))
        rows = np.where(dense[:-2] & dense[1:-1] & dense[2:])[0]
        if not rows.size:
            continue
        kept=(ys>=rows[0])&(ys<=rows[-1]+2)
        if not kept.any(): continue
        pad=max(3,round(5*scale))
        box=(max(0,x.start+int(xs[kept].min())-pad),max(0,y.start+int(ys[kept].min())-pad),
             min(original.width,x.start+int(xs[kept].max())+pad+1),min(original.height,y.start+int(ys[kept].max())+pad+1))
        x0,y0,x1,y1=box
        note=np.array(original.crop(box))
        note[:,:,3]=np.where(delta[y0:y1,x0:x1],255,0)
        tile=Image.fromarray(note)
        zoom=min(1.45,620/tile.width,280/tile.height)
        tile=tile.resize((max(1,round(tile.width*zoom)),max(1,round(tile.height*zoom))),Image.Resampling.LANCZOS)
        tiles.append((box,0.,tile))
    if len(tiles)<2:
        return {"regions":[]}
    result=numbered_ocr_sheet(tiles,"annotated")
    if result.get("image"):
        # OCR on the base reads the original headings and button labels, without the annotations.
        result["contextImage"]=base64.b64encode(png(Image.fromarray(background))).decode("ascii")
    return result


def matching_game_background(original_pixels, encoded, regions):
    if not encoded:
        return None
    with Image.open(io.BytesIO(base64.b64decode(encoded,validate=True))) as image:
        candidate = np.asarray(image.convert("RGBA"))
    if candidate.shape != original_pixels.shape:
        emit("status","已找到同名底图，但尺寸不一致，改为局部修补")
        return None
    outside = np.ones(original_pixels.shape[:2],dtype=bool)
    for region in regions:
        x,y,r,b = region["box"]
        outside[y:b,x:r] = False
    difference = np.max(np.abs(original_pixels.astype(np.int16)-candidate),axis=2)
    agreement = (difference[outside] <= 6).mean() if outside.any() else 0.
    emit("status",f"底图校验 · 文字范围外相似像素 {agreement:.1%}")
    return candidate if agreement >= .82 else None


def repair_game_region(patch, reference, heading=False):
    import cv2
    from scipy import ndimage

    rgb = patch[:, :, :3].astype(np.float32)
    if reference is not None:
        changed = np.any(patch != reference, axis=2)
        patch[changed] = reference[changed]
        return changed, True
    size = 15 if heading else 7
    local = ndimage.median_filter(rgb,size=(size,size,1))
    contrast = np.max(np.abs(rgb-local),axis=2)
    changed = ndimage.binary_dilation(contrast > 32,iterations=2 if heading else 1)
    if heading:
        changed = ndimage.binary_fill_holes(changed)
    if not changed.any() or changed.all():
        return changed & False, False
    # Inpainting follows the neighbouring colour gradients. Only publish masked pixels.
    restored = cv2.inpaint(np.ascontiguousarray(patch[:, :, :3]), changed.astype(np.uint8) * 255, 3, cv2.INPAINT_NS)
    patch[:, :, :3][changed] = restored[changed]
    return changed, False


def game_ink(pixels, logo=False):
    if not pixels.size:
        return (40,25,40)
    values = pixels[:, :3].astype(np.int16)
    vivid = (np.ptp(values,axis=1)>65) & (values.max(axis=1)>165)
    if vivid.mean() >= .18:
        return tuple(np.median(values[vivid],axis=0).astype(int))
    if not logo:
        return tuple(np.median(values, axis=0).astype(int))
    return (220,225,236) if logo else (40,25,40)


def repair_bright_panel_label(source, background, result, box):
    from scipy import ndimage

    x, y, right, bottom = box
    height = max(12, bottom - y)
    left, top = max(0, x-height), max(0, y-height)
    px1, py1 = min(source.shape[1], right+round(.8*height)), min(source.shape[0], bottom+height)
    roi = source[top:py1, left:px1, :3].astype(np.int16)
    red, green, blue = np.moveaxis(roi, 2, 0)
    unchanged = np.max(np.abs(roi-background[top:py1, left:px1, :3]), axis=2) <= 5
    ink = (red>=215) & (blue>=170) & (red-green>=85) & (blue-green>=68) & unchanged
    anchor = ink[:,max(0,x-left-height//6):right-left+height//6]
    edges = np.flatnonzero(np.diff(np.r_[False, anchor.sum(axis=1)>=6, False]))
    bands = [(start, stop) for start, stop in edges.reshape(-1, 2) if stop-start >= max(8, height//3)]
    if not bands:
        return None
    start, stop = min(bands, key=lambda band: abs((band[0]+band[1])/2+top-(y+bottom)/2))
    counts = ink[start:stop].sum(axis=0)
    columns = np.flatnonzero(counts>=3)
    groups = np.split(columns,np.flatnonzero(np.diff(columns)>max(10,height//4))+1)
    columns = max(groups,key=lambda group: counts[group].sum())
    if counts[columns].sum() < 40 or columns[-1]-columns[0] > 2*(right-x+height):
        return None
    x0, y0 = int(left+columns.min()-4), int(top+start-4)
    x1, y1 = int(left+columns.max()+5), int(top+stop+4)
    if not (0 <= x0 < x1 < source.shape[1] and 0 <= y0 < y1 < source.shape[0]):
        return None
    lx, ly = max(0, x0-5), max(0, y0-5)
    patch = result[ly:y1+5, lx:x1+5]
    text = np.zeros(patch.shape[:2], dtype=bool)
    text[y0-ly:y1-ly, x0-lx:x1-lx] = True
    nearest = ndimage.distance_transform_edt(text, return_distances=False, return_indices=True)
    restored = ndimage.gaussian_filter(patch[tuple(nearest)].astype(np.float32), sigma=(1,1,0))
    patch[text] = np.rint(restored[text]).astype(np.uint8)
    ink_slice = (slice(start,stop),slice(columns[0],columns[-1]+1))
    return (x0, y0, x1, y1), game_ink(roi[ink_slice][ink[ink_slice]])


def game_reference_font_size(mask, height, source_text):
    from scipy import ndimage

    labels, _ = ndimage.label(mask)
    heights = [area[0].stop - area[0].start for area in ndimage.find_objects(labels)
               if area and area[0].stop - area[0].start >= max(3, height * .12)
               and area[1].stop - area[1].start <= height * 4]
    source_lines = max(1, len(source_text.splitlines()))
    return max(8, round(min(height / source_lines, np.median(heights) * 1.15 if heights else height / source_lines)))


def game_wrap_lines(translation, font, width):
    import re

    lines = []
    closing = "，。！？、：；,.!?;:）)]】」』"
    opening = "（([【「『"
    for paragraph in translation.split("\n"):
        line = ""
        for part in re.findall(r"[A-Za-z0-9]+(?:['’.-][A-Za-z0-9]+)*|\s+|.", paragraph):
            if line and font.getlength(line + part) > width and part[0] not in closing:
                if line[-1] in opening:
                    carry = line[-1]
                    line = line[:-1]
                else:
                    carry = ""
                if line:
                    lines.append(line)
                line = carry
            line += part
        lines.append(line)
    return lines


def game_layout_plan(translation, size, font_path, logo=False, heading=False, source_size=None):
    from PIL import ImageFont

    w, h = size
    initial = max(8, min(140, round(source_size if source_size is not None else h - 3)))
    minimum = 6 if logo else max(8, round(initial * .75))
    for fsize in range(initial, minimum - 1, -1):
        font = ImageFont.truetype(font_path, fsize)
        stroke = max(1, round(fsize * (.08 if logo else .04))) if logo or heading else 0
        lines = game_wrap_lines(translation, font, w - 2 * stroke - 4)
        line_step = round(fsize * 1.2)
        boxes = [font.getbbox(line or " ", stroke_width=stroke) for line in lines]
        top = min(box[1] for box in boxes)
        bottom = max(index * line_step + box[3] for index, box in enumerate(boxes))
        widths = [font.getlength(line) + 2 * stroke for line in lines]
        if max(widths) <= w - 4 and bottom - top <= h - 2:
            return {"font": font, "size": fsize, "stroke": stroke, "lines": lines,
                    "line_step": line_step, "top": top, "height": bottom - top}
    raise ValueError("译文无法以可读字号放入区域，请调整文字区域或译文断行")


def game_layout_stamp(translation, size, font_path, color, logo=False, heading=False, centered=False, source_size=None):
    from PIL import ImageDraw, ImageFont, ImageFilter

    w,h=size
    stamp=Image.new("RGBA",size)
    draw=ImageDraw.Draw(stamp)
    font_path = font_for_lettering(font_path, translation if logo else translation.replace("♡", ""))
    plan = game_layout_plan(translation, size, font_path, logo, heading, source_size)
    font, fsize, stroke, lines = (plan[key] for key in ("font", "size", "stroke", "lines"))
    text = "\n".join(lines)
    bounds=draw.multiline_textbbox((0,0),text,font=font,stroke_width=stroke,spacing=0)
    x=2*stroke-bounds[0] if heading else (w-bounds[2]-bounds[0])/2 if logo or centered else stroke-bounds[0]
    y=(h-bounds[3]-bounds[1])/2
    if logo:
        mask=Image.new("L",size)
        ImageDraw.Draw(mask).multiline_text((x,y),text,font=font,fill=255,spacing=0)
        halo=Image.new("RGBA",size,"#9f26df");halo.putalpha(mask.filter(ImageFilter.MaxFilter(stroke*2+1)).filter(ImageFilter.GaussianBlur(stroke)))
        stamp.alpha_composite(halo)
        draw.multiline_text((x,y),text,font=font,fill=color+ (255,),stroke_width=stroke,stroke_fill="#301239",spacing=0)
        gradient=np.empty((h,w,4),dtype=np.uint8)
        gradient[:,:,:3]=np.rint(np.asarray(color)[None,None,:]+(255-np.asarray(color)[None,None,:])*np.linspace(.75,0,h)[:,None,None]).astype(np.uint8)
        gradient[:,:,3]=np.asarray(mask)
        stamp.alpha_composite(Image.fromarray(gradient))
    else:
        outline="#fffaff" if max(color)-min(color)>55 or max(color)<130 else "#292130"
        y = (h - plan["height"]) / 2 - plan["top"]
        for row,line in enumerate(lines):
            x = (w - font.getlength(line)) / 2 if heading or centered else stroke + 2
            edge=x
            parts=line.split("♡")
            for part_i,part in enumerate(parts):
                draw.text((edge,y+row*plan["line_step"]),part,font=font,fill=color+(255,),stroke_width=stroke,stroke_fill=outline)
                edge+=font.getlength(part)
                if part_i<len(parts)-1:
                    symbol=ImageFont.truetype(str(Path(font_path).with_name("seguisym.ttf")),fsize)
                    draw.text((edge,y+row*plan["line_step"]),"♡",font=symbol,fill=color+(255,),stroke_width=stroke,stroke_fill=outline)
                    edge+=symbol.getlength("♡")
    return stamp


def game_logo_stamp(translation, size, font_path, color):
    from PIL import ImageFilter

    width, height = size
    inset = min(max(8, round(height*.14)), min(width,height)//3)
    inner = game_layout_stamp(translation, (width-2*inset, height-2*inset), font_path, color, True)
    halo_mask = Image.new("L", size)
    halo_mask.paste(inner.getchannel("A"), (inset,inset))
    stamp = Image.new("RGBA", size, "#9f26df")
    stamp.putalpha(halo_mask.filter(ImageFilter.GaussianBlur(max(2,inset//3))).point(lambda value: round(value*.55)))
    stamp.alpha_composite(inner, (inset,inset))
    return stamp


def feather_game_logo(source, result, erase, protected):
    from scipy import ndimage

    height, width = erase.shape
    falloff = max(4,min(12,round(min(width,height)*.015)))
    strength = np.minimum(ndimage.distance_transform_edt(~erase)/falloff,1)
    keep = np.zeros(erase.shape, dtype=np.float32)
    pad = falloff-2
    for x,y,right,bottom in protected:
        left,top = max(0,x-pad),max(0,y-pad)
        right,bottom = min(width,right+pad),min(height,bottom+pad)
        if min(right-left,bottom-top) <= 0:
            continue
        dx = np.minimum(np.arange(1,right-left+1),np.arange(right-left,0,-1))
        dy = np.minimum(np.arange(1,bottom-top+1),np.arange(bottom-top,0,-1))
        area = keep[top:bottom,left:right]
        np.maximum(area,np.minimum(np.minimum(dx[None,:],dy[:,None])/pad,1),out=area)
    result[:,:,3] = np.rint(source[:,:,3]*np.maximum(strength,keep)).astype(np.uint8)
    return Image.fromarray(np.rint(keep*(source[:,:,3]>12)*255).astype(np.uint8))



def logo_facet_lines(patch, donors, missing):
    from scipy import ndimage

    rgb=patch[:,:,:3].astype(np.float32)
    light=rgb@np.array([.24,.62,.14],np.float32)
    gy=ndimage.sobel(light,axis=0)
    gx=ndimage.sobel(light,axis=1)
    strength=np.hypot(gx,gy)
    safe=ndimage.binary_erosion(donors,iterations=2)
    edges=safe&(strength>=100)&(ndimage.distance_transform_edt(~missing)<min(patch.shape[:2])*.33)
    y,x=np.where(edges)
    if len(x)<28:
        return []
    ny,nx=patch.shape[:2]
    angles=np.arange(0,np.pi,np.pi/72)
    normals=np.column_stack((np.cos(angles),np.sin(angles)))
    radius=int(np.ceil(np.hypot(nx,ny)))
    scores=np.zeros((len(angles),2*radius+1),dtype=np.int32)
    for i,(a,b) in enumerate(normals):
        aligned=np.abs(a*gx[y,x]+b*gy[y,x])>=strength[y,x]*.94
        bins=np.rint(a*x[aligned]+b*y[aligned]).astype(int)+radius
        scores[i]=np.bincount(bins,minlength=scores.shape[1])
    peaks=(scores==ndimage.maximum_filter(scores,size=(5,7)))&(scores>=9)
    indexes=np.argwhere(peaks)
    iy,ix=np.where(missing)
    lines=[]
    for angle,bin_index in sorted(indexes,key=lambda pair:-scores[tuple(pair)])[:55]:
        a,b=normals[angle]
        r=bin_index-radius
        aligned=np.abs(a*gx[y,x]+b*gy[y,x])>=strength[y,x]*.9
        along=-b*x+a*y
        close=aligned&(np.abs(a*x+b*y-r)<=2)
        swept=-b*ix+a*iy
        crossing=np.abs(a*ix+b*iy-r)<=1.5
        if close.sum()<14 or crossing.sum()<12:
            continue
        runs=np.unique(np.rint(swept[crossing]).astype(int))
        for extension in np.split(runs,np.flatnonzero(np.diff(runs)>1)+1):
            if extension.size<12:
                continue
            lo,hi=extension[0],extension[-1]
            length=hi-lo
            reach=min(65,max(24,length*1.55))
            near=along[close]
            before=near[(near>=lo-reach)&(near<lo)]
            after=near[(near>hi)&(near<=hi+reach)]
            attached=lambda support,end: support.size>=10 and np.ptp(support)>=10 and np.min(np.abs(support-end))<=13
            left,right=attached(before,lo),attached(after,hi)
            if not (left and right or left and np.ptp(before)>=.9*length or right and np.ptp(after)>=.9*length):
                continue
            if any(abs(a*c+b*d)>.992 and abs(r-(a*c+b*d)*s)<7 and lo<=end+16 and start<=hi+16
                   for c,d,s,start,end in lines):
                continue
            lines.append((a,b,r,lo,hi))
            if len(lines)>=5:
                return lines
    return lines


def fill_logo_planes(patch, donors, missing):
    from scipy import ndimage
    from scipy.spatial import cKDTree

    # Only extrapolate edges supported by visible pixels. Pixels on each side borrow
    # separate donors, so a fold does not inherit the colour of its adjacent facet.
    lines=logo_facet_lines(patch,donors,missing)
    y,x=np.indices(missing.shape,dtype=np.float32)
    groups=np.zeros(missing.shape,np.uint8)
    for bit,(a,b,r,start,end) in enumerate(lines):
        along=-b*x+a*y
        # Apply the line around its visible and missing interval rather than partition
        # unrelated parts of the stone.
        side=(a*x+b*y>=r)&(along>=start-42)&(along<=end+42)
        groups|=side.astype(np.uint8)<<bit
    sy,sx=np.nonzero(donors)
    ty,tx=np.nonzero(missing)
    donor_locations=np.column_stack((sy,sx))
    donor_colors=patch[sy,sx,:3].astype(np.float32)
    donor_group=groups[sy,sx]
    dest_groups=groups[ty,tx]
    colors=np.empty((len(ty),3),np.float32)
    for group in np.unique(dest_groups):
        eligible=donor_group==group
        if eligible.sum()<24:
            eligible=np.ones(len(donor_group),bool)
        targets=dest_groups==group
        pixels=np.column_stack((ty[targets],tx[targets]))
        tree=cKDTree(donor_locations[eligible])
        distances,indices=tree.query(pixels,k=24)
        # Keep nearest colour changes sharp, interpolating only nearby compatible
        # samples to avoid drawing the donor boundary through the crystal.
        palette=donor_colors[eligible][indices]
        delta=np.linalg.norm(palette-palette[:,:1],axis=2)
        weights=np.exp(-np.maximum(0,distances-distances[:,:1])*.26)*np.exp(-delta*.036)
        colors[targets]=(palette*weights[:,:,None]).sum(axis=1)/weights.sum(axis=1,keepdims=True)
    return np.rint(colors).clip(0,255).astype(np.uint8)


def repair_logo_facets(source, result, distance, erase, fixed):
    from PIL import ImageDraw
    from scipy import ndimage
    from scipy.spatial import ConvexHull

    red,green,blue=np.moveaxis(source[:,:,:3].astype(np.int16),2,0)
    # Read the original facets, including edges falling inside the coarse initial boxes.
    contour=(source[:,:,3]>=185)&(red<67)&(green<60)&(blue<64)&(blue-red<10)&(blue-green<28)
    labels,_=ndimage.label(ndimage.maximum_filter(contour,size=35))
    repaired=0
    for index,bounds in enumerate(ndimage.find_objects(labels),1):
        y,x=np.where(contour[bounds]&(labels[bounds]==index))
        if len(x)<85 or min(np.ptp(x),np.ptp(y))<23:
            continue
        points=np.column_stack((x,y))
        if np.linalg.matrix_rank(points-points[0])<2:
            continue
        hull=ConvexHull(points)
        patch=result[bounds]
        original=source[bounds]
        mask=Image.new("L",patch.shape[1::-1])
        ImageDraw.Draw(mask).polygon([tuple(point) for point in points[hull.vertices]],fill=255)
        inside=np.asarray(mask)>0
        missing=inside&erase[bounds]&(patch[:,:,3]<195)&(original[:,:,3]>=175)&~fixed[bounds]
        donors=inside&(patch[:,:,3]>=225)&(distance[bounds]>2.5)&~fixed[bounds]
        if missing.sum()<25 or donors.sum()<max(48,missing.sum()*.28):
            continue
        patch[missing,:3]=fill_logo_planes(patch,donors,missing)
        patch[missing,3]=original[missing,3]
        repaired+=1
    return repaired


def compact_logo_symbol(source, box):
    from scipy import ndimage

    x,y,right,bottom=box
    radius=max(4,min(12,round((bottom-y)*.1)))
    x0,y0=max(0,x-2*radius),max(0,y-2*radius)
    x1,y1=min(source.shape[1],right+2*radius),min(source.shape[0],bottom+2*radius)
    patch=source[y0:y1,x0:x1]
    rgb=patch[:,:,:3]
    white=(patch[:,:,3]>=224)&(rgb.min(axis=2)>=180)&(np.ptp(rgb,axis=2)<=27)
    labels,_=ndimage.label(white,structure=np.ones((3,3),bool))
    counts=np.bincount(labels.ravel())
    inside=np.bincount(labels[y-y0:bottom-y0,x-x0:right-x0].ravel(),minlength=len(counts))
    eligible=(np.arange(len(counts))!=0)&(counts>=24)&(inside>=.42*counts)
    if not eligible.any():
        return None
    seeds=np.isin(labels,np.flatnonzero(eligible&(counts>=.23*counts[eligible].max())))
    core=(ndimage.distance_transform_edt(~seeds)<=radius)&(patch[:,:,3]>=210)
    return (slice(y0,y1),slice(x0,x1)),core


def tall_logo_mark(source, box):
    from scipy import ndimage

    x,y,right,bottom=box
    height=bottom-y
    if height<70:
        return None
    radius=max(5,min(12,round(height*.05)))
    bounds=(slice(max(0,y-2*radius),bottom+2*radius),slice(max(0,x-radius),right+radius))
    patch=source[bounds]
    red,green,blue=np.moveaxis(patch[:,:,:3].astype(np.int16),2,0)
    bright=(patch[:,:,3]>=220)&(red>=170)&(blue>=125)&(blue>=green-12)&(red>=green)
    labels,_=ndimage.label(bright,structure=np.ones((3,3),bool))
    counts=np.bincount(labels.ravel())
    counts[0]=0
    if counts.max()<height*2:
        return None
    largest=labels==counts.argmax()
    if np.count_nonzero(largest.any(axis=1))<height*.55:
        return None
    chosen=np.isin(labels,np.flatnonzero(counts>=max(40,counts.max()*.05)))
    if chosen.sum()<.4*np.count_nonzero(patch[:,:,3]>=220):
        return None
    core=(ndimage.distance_transform_edt(~chosen)<=radius)&(patch[:,:,3]>=195)
    return bounds,core


def separate_logo_outline(source, result, erase, protected, symbols):
    from scipy import ndimage

    rgb=source[:,:,:3].astype(np.int16)
    alpha=source[:,:,3]
    keep=np.zeros(alpha.shape,bool)
    for x,y,right,bottom in protected:
        box=[x,y,right,bottom]
        symbol=compact_logo_symbol(source,box) if box in symbols else tall_logo_mark(source,box)
        if symbol is not None:
            bounds,core=symbol
            keep[bounds]|=core
        else:
            padding_y=min(19,max(9,round((bottom-y)*.18)))
            padding_x=min(14,max(6,round((right-x)*.025)))
            keep[max(0,y-padding_y):bottom+padding_y,max(0,x-padding_x):right+padding_x]=True
    peak=rgb.max(axis=2)
    chroma=np.ptp(rgb,axis=2)
    samples=rgb[(alpha>=180)&(peak<125)&(chroma>29)&erase&~keep]
    if len(samples)<180:
        return None
    colors,counts=np.unique(samples//8,axis=0,return_counts=True)
    mode=counts.argmax()
    if counts[mode]<.25*len(samples):
        return None
    shade=np.median(samples[np.all(samples//8==colors[mode],axis=1)],axis=0)
    outline=(np.max(np.abs(rgb-shade),axis=2)<=32)&(alpha>=150)&(chroma>max(26,np.ptp(shade)*.5))&(peak<shade.max()+33)
    closed=ndimage.binary_fill_holes(ndimage.binary_closing(outline,iterations=2))
    labels,_=ndimage.label(closed,structure=np.ones((3,3),bool))
    glyphs=np.zeros(alpha.shape,bool)
    fixed=keep&(alpha>=218)
    for index,bounds in enumerate(ndimage.find_objects(labels),1):
        piece=labels[bounds]==index
        size=piece.sum()
        if (piece&keep[bounds]).sum()>=size*.32:
            fixed[bounds]|=piece
        elif size>=25 and (piece&erase[bounds]).sum()>=size*.2:
            glyphs[bounds]|=piece
    glyphs&=~fixed
    if (glyphs&erase).sum()<.25*np.count_nonzero((alpha>=180)&erase&~keep):
        return None
    distance=ndimage.distance_transform_edt(~glyphs)
    fade=np.where((alpha<246)&(ndimage.distance_transform_edt(~fixed)>5),np.clip((distance-29)/18,0,1),1.)
    fade[(distance<=1.7)&~fixed]=0
    result[:,:,3]=np.rint(alpha*fade).astype(np.uint8)
    repaired=repair_logo_facets(source,result,distance,erase,fixed)
    return Image.fromarray((fixed*255).astype(np.uint8)),glyphs,outline,tuple(np.rint(shade).astype(int)),repaired



def logo_fill_texture(pixels, inside):
    from scipy import ndimage

    height=inside.shape[0]
    rgb=pixels[:,:,:3].astype(np.float32)
    palette=np.zeros((height,3),np.float32)
    rows=np.flatnonzero(inside.sum(axis=1)>=3)
    for y in rows:
        palette[y]=np.median(rgb[y,inside[y]],axis=0)
    rows_axis=np.arange(height)
    palette=np.column_stack([np.interp(rows_axis,rows,palette[rows,c]) for c in range(3)])
    palette=ndimage.gaussian_filter1d(palette,max(1,height*.035),axis=0)
    nearest=ndimage.distance_transform_edt(~inside,return_distances=False,return_indices=True)
    sampled=ndimage.gaussian_filter(rgb[tuple(nearest)],(.65,.65,0))
    facets=sampled-ndimage.gaussian_filter(sampled,(4.5,4.5,0))
    return np.rint(np.clip(palette[:,None,:]+np.clip(facets,-54,54)*.68,0,255)).astype(np.uint8)


def textured_logo_stamp(translation, crop, glyphs, outline, stroke_color, font_path, color):
    from PIL import ImageDraw, ImageFilter, ImageFont
    from scipy import ndimage

    width,height=crop.size
    pixels=np.asarray(crop)
    inside=glyphs&~outline&(pixels[:,:,3]>=225)&(pixels[:,:,:3].max(axis=2)>115)
    if width<32 or height<22 or inside.sum()<75 or "\n" in translation:
        return game_logo_stamp(translation,crop.size,font_path,color)
    rows=np.flatnonzero(inside.sum(axis=1)>=3)
    xs=np.flatnonzero(inside.sum(axis=0)>=3)
    if rows.size<6 or xs.size<8:
        return game_logo_stamp(translation,crop.size,font_path,color)
    texture=logo_fill_texture(pixels,inside)

    # Match the measured source footprint, including a supported stem slant.
    edge_x=ndimage.sobel(glyphs.astype(float),axis=1)
    edge_y=ndimage.sobel(glyphs.astype(float),axis=0)
    vertical=np.abs(edge_x)>2
    slopes=edge_y[vertical]/edge_x[vertical]
    right=np.count_nonzero((slopes>=.22)&(slopes<=.72))
    left=np.count_nonzero((slopes<=-.22)&(slopes>=-.72))
    slant=.17 if right>1.14*left else -.17 if left>1.14*right else 0.
    rim=ndimage.distance_transform_edt(outline&glyphs)
    local_rim=rim[rim>0]
    stroke=max(2,min(round(height*.085),round(np.percentile(local_rim,80)*1.85))) if local_rim.size else max(2,round(height*.06))
    font=ImageFont.truetype(font_for_lettering(font_path, translation),120)
    bounds=font.getbbox(translation)
    letter=Image.new("L",(max(1,bounds[2]-bounds[0]),max(1,bounds[3]-bounds[1])))
    ImageDraw.Draw(letter).text((-bounds[0],-bounds[1]),translation,font=font,fill=255)
    ink_box=letter.getbbox()
    if not ink_box:
        return game_logo_stamp(translation,crop.size,font_path,color)
    letter=letter.crop(ink_box)
    h=round(np.clip(rows[-1]-rows[0]+1,height*.56,height*.79))
    origin_w=xs[-1]-xs[0]+1
    natural_w=letter.width*h/letter.height
    w=round(min(width-2*stroke-round(abs(slant)*h),np.clip(natural_w,origin_w*.83,origin_w*1.02)))
    if w<8:
        return game_logo_stamp(translation,crop.size,font_path,color)
    letter=letter.resize((w,h),Image.Resampling.LANCZOS)
    pad=stroke*3
    mask=Image.new("L",(width+2*pad,height+2*pad))
    anchor_x=np.clip((int(xs[0])+int(xs[-1]))/2,w*.5,width-w*.5)
    anchor_y=np.clip((int(rows[0])+int(rows[-1]))/2,h*.5,height-h*.5)
    mask.paste(letter,(pad+round(anchor_x-w/2),pad+round(anchor_y-h/2)))
    if slant:
        mask=mask.transform(mask.size,Image.Transform.AFFINE,(1,slant,-slant*(pad+anchor_y),0,1,0),Image.Resampling.BICUBIC)
    outline_mask=mask.filter(ImageFilter.MaxFilter(stroke*2+1))
    distance=ndimage.distance_transform_edt(~glyphs)
    halo=(distance>=3)&(distance<=max(7,stroke*2))&(pixels[:,:,3]>=30)&(pixels[:,:,3]<180)
    halos=pixels[:,:,:3][halo]
    halos=halos[(halos[:,2].astype(np.int16)-halos[:,1]>30)]
    halo_color=tuple(np.median(halos,axis=0).astype(int)) if len(halos)>=30 else (162,53,222)
    stamp=Image.new("RGBA",mask.size,halo_color)
    stamp.putalpha(outline_mask.filter(ImageFilter.GaussianBlur(max(3,stroke*1.35))).point(lambda value: round(value*.72)))
    stroke_layer=Image.new("RGBA",mask.size,stroke_color)
    stroke_layer.putalpha(outline_mask)
    stamp.alpha_composite(stroke_layer)
    fill=Image.fromarray(np.pad(texture,((pad,pad),(pad,pad),(0,0)),mode="edge")).convert("RGBA")
    fill.putalpha(mask)
    stamp.alpha_composite(fill)
    return stamp



def logo_title_box(box, regions):
    x,y,r,b=box
    left,top,right,bottom=box
    center=(y+b)/2
    for neighbor in regions:
        nx,ny,nr,nb=neighbor["box"]
        adjacent=(ny+nb)/2
        if adjacent==center or min(r,nr)-max(x,nx)<.65*min(r-x,nr-nx) or nb<=y or ny>=b:
            continue
        if abs(adjacent-center)<.54*min(nb-ny,b-y):
            continue
        boundary=(max(y,ny)+min(b,nb))//2
        gap=max(2,round(min(nb-ny,b-y)*.02))
        if center<adjacent:
            bottom=min(bottom,boundary-gap)
        else:
            top=max(top,boundary+gap)
    return (left,top,right,bottom) if bottom-top>=max(22,.62*(b-y)) else box


def game_panel_frame(pixels):
    # A frame gives a sustained contrast transition on all four opposing sides.
    rgb=pixels[:,:,:3].astype(np.int16)
    edges=[]
    for axis in (0,1):
        panel=rgb.transpose(1,0,2) if axis==0 else rgb
        span,length=panel.shape[:2]
        sample=panel[round(span*.2):round(span*.8)]
        band=round(length*.08)
        if band<5:
            return None
        jumps=np.abs(sample[:,2:]-sample[:,:-2]).max(axis=2)
        rails=np.flatnonzero((jumps>27).mean(axis=0)>=.88)+1
        near=rails[(rails>=3)&(rails<=band)]
        far=rails[(rails>=length-band)&(rails<=length-4)]
        if not (near.size and far.size):
            return None
        inner,outer=int(near[-1])+1,int(far[0])
        if abs(inner-(length-outer))>max(6,length*.025):
            return None
        edges.append((inner,outer))
    (top,bottom),(left,right)=edges
    return left,top,right,bottom


def clip_game_text_box(box, bounds):
    x,y,r,b=box
    left,top,right,bottom=bounds
    return max(x,left),max(y,top),min(r,right),min(b,bottom)


def restore_game_frame(result, reference, box, frame):
    x,y,r,b=box
    left,top,right,bottom=frame
    if x<left:
        result[y:b,:left]=reference[y:b,:left]
    if r>right:
        result[y:b,right:]=reference[y:b,right:]
    if y<top:
        result[:top,x:r]=reference[:top,x:r]
    if b>bottom:
        result[bottom:,x:r]=reference[bottom:,x:r]


def render_game_layout(original, regions, extra, font_path):
    start=time.monotonic()
    kind=game_image_kind(original, extra.get("assetName",""))
    labels={"logo":"透明 Logo","lettering":"透明花字","background":"带底图图片"}
    emit("status",f"识别素材类型 · {labels[kind]} · {len(regions)} 个文字区域")
    source=np.asarray(original)
    background=matching_game_background(source,extra.get("cleanImage"),regions) if kind=="background" else None
    frame=game_panel_frame(background if background is not None else source) if kind=="background" else None
    gap=max(4,min(10,round(min(original.size)*.01)))
    if frame:
        left,top,right,bottom=frame
        safe=(left+gap,top+gap,right-gap,bottom-gap)
    result=np.array(original)
    erase_logo = np.zeros(source.shape[:2], dtype=bool) if kind == "logo" else None
    separated=None
    if erase_logo is not None:
        for region in regions:
            x,y,right,bottom=region["box"]
            margin=max(4,min(15,round((bottom-y)*.12)))
            erase_logo[max(0,y-margin):bottom+margin,max(0,x-margin):right+margin]=True
        separated=separate_logo_outline(source,result,erase_logo,extra.get("protectBoxes",[]),extra.get("protectSymbols",[]))
    overlays=[]
    occupied=extra.get("occupiedBoxes",[region["box"] for region in regions])
    from_base=0
    patched=0
    for index,region in enumerate(regions,1):
        box=tuple(region["box"]); x,y,r,b=box
        crop=original.crop(box)
        try:
            if kind=="lettering":
                overlay,_=program_layer(crop,region["translation"],font_path,ink_components(crop),region.get("writingMode","auto"))
                result[y:b,x:r]=0
            elif kind=="logo":
                colors=np.asarray(crop)
                color=game_ink(colors[colors[:,:,3]>150],True)
                logo_font=str(Path(font_path).with_name("msyhbd.ttc"))
                if separated is None:
                    overlay=game_logo_stamp(region["translation"],crop.size,logo_font,color)
                else:
                    _,glyphs,outline,stroke,_=separated
                    x,y,r,b=logo_title_box(box,regions)
                    crop=original.crop((x,y,r,b))
                    overlay=textured_logo_stamp(region["translation"],crop,glyphs[y:b,x:r],outline[y:b,x:r],stroke,logo_font,color)
                    x-=(overlay.width-crop.width)//2
                    y-=(overlay.height-crop.height)//2
            else:
                text=region.get("text","").strip()
                heading = len(text) > 10 and b-y >= 24 and r-x >= 180 and text.isascii() and text.upper()==text and any(c.isalpha() for c in text)
                first_body=None
                if heading:
                    below=(row[1] for row in occupied if y+gap<row[1]<=b+gap
                           and min(r,row[2])-max(x,row[0])>=.25*min(r-x,row[2]-row[0]))
                    first_body=min(below,default=None)
                    if first_body is not None:
                        b=min(b,first_body)
                if frame:
                    if background is not None:
                        restore_game_frame(result,background,(x,y,r,b),frame)
                    x,y,r,b=clip_game_text_box((x,y,r,b),frame)
                if r<=x or b<=y:
                    raise ValueError("文字区域位于边框外，请调整选区")
                label = repair_bright_panel_label(source,background,result,box) if background is not None and 1 <= len(text) <= 8 and b-y <= 60 else None
                if label is None:
                    patch=result[y:b,x:r]
                    mask,used_base=repair_game_region(patch,background[y:b,x:r] if background is not None else None,heading)
                    original_patch=source[y:b,x:r]
                    ink=mask & (np.max(np.abs(original_patch[:,:,:3].astype(np.int16)-patch[:,:,:3]),axis=2)>32)
                    color=game_ink(original_patch[ink],False)
                    source_size=game_reference_font_size(mask,b-y,text)
                else:
                    (x,y,r,b),color=label
                    used_base=False
                    source_size=max(8,b-y-4)
                from_base+=int(used_base)
                patched+=int(not used_base)
                if frame:
                    x,y,r,b=clip_game_text_box((x,y,r,b),safe)
                if first_body is not None:
                    b=min(b,first_body-gap)
                if r<=x or b<=y:
                    raise ValueError("文字区域内没有足够的排版空间，请调整选区")
                lettering_font=str(Path(font_path).with_name("msyhbd.ttc")) if heading else font_path
                overlay=game_layout_stamp(region["translation"],(r-x,b-y),lettering_font,color,
                                          heading=heading,centered=heading or label is not None,source_size=source_size)
            overlays.append((x,y,overlay))
        except ValueError as exc:
            raise ValueError(f"区域 {index}：{exc}") from exc
    protected=separated[0] if separated is not None else feather_game_logo(source,result,erase_logo,extra.get("protectBoxes",[])) if erase_logo is not None else None
    final=Image.fromarray(result)
    for x,y,overlay in overlays:
        final.alpha_composite(overlay,(x,y))
    if protected is not None:
        final.paste(original,(0,0),protected)
    if separated is not None:
        emit("status",f"Logo 保留原装饰轮廓 · 补绘重叠区域 {separated[4]} 处")
    emit("status",f"{labels[kind]} · 底图恢复 {from_base} 区 · 局部修补 {patched} 区 · 排版 {time.monotonic()-start:.2f} 秒")
    return final


def mosaic_target_model(directory):
    path = Path(directory) / "ComfyUI/models/mosaic-region-targets/active.pt"
    try:
        info = path.stat()
    except FileNotFoundError:
        return path, None
    return path, f"{info.st_mtime_ns}:{info.st_size}"


def predict_mosaic_target(image, model_file, box, classifier_code):
    import torch
    torch.set_num_threads(min(4, torch.get_num_threads()))
    state = torch.load(model_file, map_location="cpu", weights_only=True)
    classifier = {"__name__": "llmchat_region_classifier"}
    exec(classifier_code, classifier)
    return classifier["predict"](image, box, state)


async def run(data):
    if data["mode"] == "mosaic-target-status":
        _, revision = mosaic_target_model(data["directory"])
        emit("result", {"revision": revision})
        return
    if data["mode"] == "open":
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=8)) as session:
            await ready(session, Path(data["directory"]))
        emit("result", {"url": BASE})
        return
    steps = int(data["steps"])
    if data["mode"] != "program" and not 1 <= steps <= 100:
        raise ValueError("采样步数须为 1–100")
    with Image.open(io.BytesIO(base64.b64decode(data["image"], validate=True))) as source:
        original = source.convert("RGBA")
    if data["mode"] == "mosaic-target-predict":
        path, revision = mosaic_target_model(data["directory"])
        result = {}
        if revision and revision == data["profile"].get("revision"):
            with path.open("rb") as model_file:
                info = os.fstat(model_file.fileno())
                if revision == f"{info.st_mtime_ns}:{info.st_size}":
                    result = predict_mosaic_target(original, model_file, data["profile"]["box"], data["regionClassifier"])
        emit("result", result)
        return
    if data["mode"] == "workflow-input":
        filename = workflow_input_name(data["profile"].get("name", ""))
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=120)) as session:
            await ready(session, Path(data["directory"]))
            name = await upload_image(session, original, "input", filename)
        emit("result", {"name": name})
        return
    if data["mode"] == "mosaic-workflow":
        emit("result", await prepare_mosaic_workflow(original, data, steps))
        return
    workflow_times = []
    if data["mode"] == "mosaic":
        result = await repair_mosaic(original, data, steps, workflow_times)
        emit("result", {"image": base64.b64encode(png(result)).decode("ascii"),
                        **({"workflowMs": sum(workflow_times)} if workflow_times else {})})
        return
    if data["mode"] == "ocr-prepare":
        extra=data["profile"]
        answer=annotated_ocr_sheet(original,extra["cleanImage"]) if extra.get("cleanImage") else transparent_ocr_sheet(original,extra.get("assetName",""))
        emit("result",answer)
        return
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
    font_names = ("msyh.ttc", "simhei.ttf", "simkai.ttf") if data["mode"] == "layout" else ("simkai.ttf", "msyh.ttc", "simhei.ttf")
    font = next((str(fonts / name) for name in font_names if (fonts / name).is_file()), None)
    if not font:
        raise ValueError("缺少中文字体，请安装楷体、微软雅黑或黑体")
    if data["mode"] == "layout":
        result=render_game_layout(original,regions,data["profile"],font)
        emit("result",{"image":base64.b64encode(png(result)).decode("ascii")})
        return
    relocated = []
    occupied = [tuple(region["box"]) for region in regions]
    for index, region in enumerate(regions, 1):
        box = occupied[index-1]
        crop = original.crop(box)
        transparent = crop.getchannel("A").getextrema()[0] < 255
        protected = ink_components(crop) if transparent else np.zeros((crop.height,crop.width),dtype=bool)
        writing_mode = region.get("writingMode", "auto")
        target_drafts = drafts
        try:
            draft, lettering = program_layer(crop, region["translation"], font, protected, writing_mode)
        except InsufficientInk as exc:
            peers = occupied[:index-1] + occupied[index:]
            corrected = None if transparent else nearby_opaque_ink(original, box, peers)
            if corrected:
                crop = original.crop(corrected)
                protected = np.zeros((crop.height,crop.width),dtype=bool)
                try:
                    draft, lettering = program_layer(crop, region["translation"], font, protected, writing_mode)
                except InsufficientInk:
                    corrected = None
            if corrected is None:
                emit("status", f"区域 {index} / {len(regions)} · {exc}，已保留原图")
                continue
            emit("status", f"区域 {index} / {len(regions)} · 已校正选区 {box} → {corrected}")
            box = occupied[index-1] = corrected
            target_drafts = relocated
        target_drafts.append((index, box, region["translation"].strip(), crop, draft, lettering, protected, transparent))
    drafts.extend(relocated)
    if not drafts:
        raise InsufficientInk("所选区域都没有足够的可见笔画，请调整范围")
    for _, box, _, _, draft, lettering, _, _ in drafts:
        lettering_canvas.paste(lettering, box)
        composed.paste(draft, box)
    if data["mode"] == "program":
        emit("result", {"image": base64.b64encode(png(composed)).decode("ascii"), "layer": base64.b64encode(png(lettering_canvas)).decode("ascii")})
        return
    profile = data["profile"]
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=120)) as session:
        await ready(session, Path(data["directory"]))
        for i, box, translation, crop, draft, lettering, protected, transparent in drafts:
            label = f"区域 {i} / {len(regions)}"
            try:
                layer = await render(session, crop, lettering if transparent else draft, translation, steps, label, profile, workflow_times)
                if transparent:
                    layer = refine_transparent_lettering(draft, layer, protected)
                layer.paste(crop, (0,0), Image.fromarray(protected))
            except Exception as exc:
                raise RuntimeError(f"{label}：{exc}") from exc
            composed.paste(layer, box)
    emit("result", {"image": base64.b64encode(png(composed)).decode("ascii"),
                    **({"workflowMs": sum(workflow_times)} if workflow_times else {})})


if __name__ == "__main__":
    try:
        asyncio.run(run(json.load(sys.stdin)))
    except Exception as exc:
        emit("error", str(exc) or type(exc).__name__)
        sys.exit(1)

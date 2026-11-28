"""Synthetic geometry and orchestration checks. No image model is executed."""
import base64
import importlib.util
from pathlib import Path
import sys
import unittest
import uuid
from unittest.mock import AsyncMock, patch

import numpy as np
from PIL import Image

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("redraw_worker", ROOT / "frontend/src-tauri/src/style_redraw.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


def profile(kind="2511"):
    return {"kind": kind, "model": "fixture", "clip": "fixture", "vae": "fixture"}


def texture(size=(640, 240)):
    y, x = np.indices(size[::-1])
    rgb = np.dstack((80 + x % 100, 90 + y % 100, 110 + (x + y) % 100))
    return Image.fromarray(np.dstack((rgb, np.full_like(x, 255))).astype(np.uint8))


class RegionGeometry(unittest.TestCase):
    def test_far_regions_split_and_near_regions_merge(self):
        source = texture((1400, 600))
        regions = [{"box": [40, 60, 75, 95]}, {"box": [80, 60, 110, 95]}, {"box": [1180, 430, 1220, 470]}]
        grouped = worker.mosaic_region_groups(source, regions)
        self.assertEqual([len(group) for group in grouped], [2, 1])
        self.assertEqual(grouped, worker.mosaic_region_groups(source, list(reversed(regions))))
        areas = worker.mosaic_redraw_areas(source, regions, profile())
        self.assertTrue(all(max(area[1].size) < 300 for area in areas))

    def test_core_and_margin_are_fully_replaced(self):
        source = texture()
        for preserve in (False, True):
            bounds, _, generation, blend, samples = worker.mosaic_redraw_area(
                source, [{"box": [100, 80, 140, 120]}], [[110, 90, 120, 100]], preserve)
            x, y, _, _ = bounds
            alpha = np.asarray(blend)
            self.assertEqual(alpha[80-y:120-y, 100-x:140-x].max(), 255)
            self.assertEqual(alpha[80-y, 99-x], 255)
            self.assertTrue(np.all(alpha[90-y:100-y, 110-x:120-x] == 0))
            self.assertTrue(np.any((alpha > 0) & (alpha < 255)))
            self.assertTrue(np.all(alpha[~generation] == 0))
            self.assertTrue(samples.any())
            self.assertTrue(np.all(alpha[samples] == 0))

    def test_illustrious_feathers_before_the_generation_boundary(self):
        source = Image.new("RGBA", (480, 320), (100, 125, 160, 255))
        box = [160, 80, 260, 180]
        keep = [190, 110, 195, 116]
        (bounds, _, generation, blend, _) = worker.mosaic_redraw_areas(
            source, [{"box": box}], {**profile("illustrious"), "keep": [keep]})[0]
        x, y, _, _ = bounds
        alpha = np.asarray(blend)
        row = 100 - y
        left = box[0] - x
        self.assertEqual(alpha[row, left], 255)
        self.assertTrue(np.all(np.diff(alpha[row, :left].astype(int)) >= 0))
        self.assertGreater(np.count_nonzero((alpha[row, :left] > 0) & (alpha[row, :left] < 255)), 10)
        self.assertGreaterEqual(np.count_nonzero(generation[row, :left] & (alpha[row, :left] == 0)), 12)
        np.testing.assert_array_equal(alpha[110-y:116-y, 190-x:195-x], 0)
        np.testing.assert_array_equal(generation[110-y:116-y, 190-x:195-x], False)

    def test_protected_or_transparent_group_is_skipped(self):
        source = texture()
        regions = [{"box": [20, 20, 40, 40]}, {"box": [400, 100, 430, 130]}]
        settings = {**profile(), "keep": [[20, 20, 40, 40]]}
        self.assertEqual(len(worker.mosaic_redraw_areas(source, regions, settings)), 1)
        with self.assertRaisesRegex(ValueError, "可编辑"):
            worker.mosaic_redraw_areas(source, regions[:1], settings)
        with self.assertRaisesRegex(ValueError, "坐标"):
            worker.mosaic_region_groups(source, [{"box": [-1, 0, 20, 20]}])


class RegionGraphs(unittest.IsolatedAsyncioTestCase):
    def test_illustrious_recipe_without_reference(self):
        settings = profile("illustrious")
        for size, expected_size in (((2048, 1152), (1024, 576)), ((320, 480), (512, 768)),
                                    ((960, 800), (960, 800)), ((4096, 64), (1024, 64))):
            graph = worker.mosaic_workflow("source.png", None, "mask.png", 28,
                                           settings, size, "core.png")
            resize = graph["5"]["inputs"]
            self.assertEqual((resize["width"], resize["height"]), expected_size)
            sampler = graph["13"]["inputs"]
            for key, expected in {"steps": 22, "cfg": 5, "denoise": .67, "sampler_name": "euler",
                                  "scheduler": "karras", "model": ["30", 0]}.items():
                self.assertEqual(sampler[key], expected)
            self.assertEqual(graph["30"]["inputs"]["ckpt_name"], "Illustrious-XL-v2.0.safetensors")
            self.assertEqual(graph["32"]["inputs"]["control_type"], "tile")
            self.assertEqual(graph["32"]["inputs"]["image"], ["41", 0])
            self.assertEqual(graph["34"]["inputs"]["pixels"], ["41", 0])
            self.assertEqual(resize["image"], ["4", 0])
            self.assertEqual(graph["41"], {"class_type": "INPAINT_MaskedBlur", "inputs": {
                "image": ["5", 0], "mask": ["45", 0], "blur": 47, "falloff": 9}})
            self.assertNotIn("mask_optional", graph["35"]["inputs"])
            self.assertNotIn("31", graph)
            self.assertEqual(graph["33"]["inputs"]["name"], "controlnet-union-sdxl-1.0.safetensors")
            self.assertEqual(graph["35"]["inputs"]["strength"], .65)
            self.assertEqual(graph["35"]["inputs"]["end_percent"], .52)
            self.assertTrue(graph["34"]["inputs"]["noise_mask"])
            self.assertTrue(all(key not in graph for key in ("16", "37", "38", "39", "40")))
            self.assertTrue(all("Qwen" not in node["class_type"] for node in graph.values()))
        self.assertEqual(worker.MOSAIC_WORKFLOW_KEYS["illustrious"], "illustrious-regions-v4")

    async def test_line_refinement_encodes_first_pass_and_uses_same_mask(self):
        source = texture()
        settings = {**profile("illustrious"), "lineRefine": True,
                    "lineRefineWeights": profile("2511-lightning")}
        areas = worker.mosaic_redraw_areas(source, [{"box": [25, 30, 45, 50]}], settings)
        first = Image.new("RGB", (1024, 768), (210, 70, 90))
        uploads = {}

        async def upload(image, filename=None):
            name = str(len(uploads)) + ".png"
            uploads[name] = image.copy()
            return name

        graph, outputs = await worker.mosaic_refinement_graphs(areas, [worker.png(first)], settings, upload)
        self.assertEqual(outputs, ["region_0_15"])
        np.testing.assert_array_equal(uploads[graph["region_0_4"]["inputs"]["image"]], first)
        sampler = graph["region_0_13"]["inputs"]
        self.assertEqual((sampler["steps"], sampler["cfg"]), (4, 1))
        self.assertEqual(sampler["latent_image"], ["region_0_19", 0])
        self.assertEqual(graph["region_0_5"]["inputs"]["width"], 1024)
        self.assertEqual(graph["region_0_6"]["inputs"]["image1"], ["region_0_5", 0])
        self.assertEqual(graph["region_0_27"]["inputs"]["latent"], ["region_0_12", 0])
        self.assertNotIn("region_0_16", graph)
        self.assertFalse(any(n["class_type"] in ("CheckpointLoaderSimple", "INPAINT_ColorMatch") for n in graph.values()))
        prompt = graph["region_0_6"]["inputs"]["prompt"]
        self.assertIn("hard-edged cel shading", prompt)
        self.assertNotIn("mosaic", prompt)
        self.assertNotIn("reconstruct", prompt)
        mask = np.asarray(uploads[graph["region_0_17"]["inputs"]["image"]])[:, :, 0]
        _, _, generation, blend, _ = areas[0]
        np.testing.assert_array_equal(mask[np.asarray(blend) == 255], 255)
        np.testing.assert_array_equal(mask[~generation], 0)

    async def test_line_refinement_uses_separate_comfy_job_identifier(self):
        recover = AsyncMock(side_effect=RuntimeError("fixture reached history lookup"))
        with (
            patch.object(worker, "validate_mosaic_weights"),
            patch.object(worker, "ready", AsyncMock(return_value=[])),
            patch.object(worker, "recover_image_graph", recover),
        ):
            for enabled, version in ((False, "v4"), (True, "v6-base")):
                settings = {**profile("illustrious"), "lineRefine": enabled, "promptId": "fixture-job"}
                data = {"directory": "fixture", "profile": settings, "regions": [{"box": [25, 30, 45, 50]}]}
                with self.assertRaisesRegex(RuntimeError, "fixture reached history lookup"):
                    await worker.repair_mosaic(texture(), data, 26 if enabled else 22, [])
                expected = uuid.uuid5(uuid.NAMESPACE_URL, f"urn:llmchat:mosaic:illustrious-regions-{version}:fixture-job")
                self.assertEqual(recover.call_args.args[1], str(expected))

    async def test_line_refinement_runs_two_stages_and_recovers_first_on_retry(self):
        source = texture((220, 160))
        settings = {**profile("illustrious"), "lineRefine": True, "promptId": "fixture-job",
                    "lineRefineWeights": profile("2511-lightning")}
        data = {"directory": "fixture", "profile": settings,
                "regions": [{"box": [40, 50, 50, 60]}, {"box": [170, 50, 180, 60]}]}
        history, submissions, uploads = {}, [], {}
        fail_edit = True

        async def upload(session, image, **kwargs):
            name = str(len(uploads)) + ".png"
            uploads[name] = image.copy()
            return name

        async def recover(session, pid, output, label, times, cancel_path):
            record = history.get(pid)
            if record:
                times.append(100)
                return record[output], record
            return None, None

        async def run(session, graph, output, label, times, submitted, **kwargs):
            nonlocal fail_edit
            edit = any(n["class_type"] == "UnetLoaderGGUF" for n in graph.values())
            submissions.append("edit" if edit else "base")
            if edit and fail_edit:
                fail_edit = False
                raise RuntimeError("fixture Edit failure")
            record = {}
            for index in range(2):
                if edit:
                    inputs = graph[f"region_{index}_4"]["inputs"]
                    first = uploads[inputs["image"]]
                    self.assertEqual(first.getpixel((0, 0)), (100 + index, 60, 80))
                    size = first.size
                else:
                    self.assertEqual(graph[f"region_{index}_13"]["inputs"]["steps"], 22)
                    size = (768, 512)
                record[f"region_{index}_15"] = worker.png(Image.new("RGB", size, (100 + index, 60, 80)))
            record["15"] = record["region_0_15"]
            history[kwargs["resume_id"]] = record
            submitted.append(kwargs["resume_id"])
            times.append(100)
            return record[output]

        async def read_image(session, record, output, times, **kwargs):
            return record.get(output)

        unload = AsyncMock()
        with (
            patch.object(worker, "validate_mosaic_weights"),
            patch.object(worker, "ready", AsyncMock(return_value=[])),
            patch.object(worker, "upload_image", upload),
            patch.object(worker, "recover_image_graph", recover),
            patch.object(worker, "run_image_graph", run),
            patch.object(worker, "read_graph_history", AsyncMock(side_effect=lambda session, pid: history[pid])),
            patch.object(worker, "graph_history_image", read_image),
            patch.object(worker, "unload_mosaic_models", unload),
        ):
            with self.assertRaisesRegex(RuntimeError, "fixture Edit failure"):
                await worker.repair_mosaic(source, data, 26, [])
            result = await worker.repair_mosaic(source, data, 26, [])
            self.assertEqual(submissions, ["base", "edit", "edit"])
            self.assertEqual(unload.await_count, 2)
            times = []
            repeated = await worker.repair_mosaic(source, data, 26, times)
            self.assertEqual(submissions, ["base", "edit", "edit"])
            self.assertEqual(times, [100, 100])
            np.testing.assert_array_equal(result, repeated)
            support = np.zeros((source.height, source.width), bool)
            for bounds, _, _, blend, _ in worker.mosaic_redraw_areas(source, data["regions"], settings):
                left, top, right, bottom = bounds
                support[top:bottom, left:right] |= np.asarray(blend) > 0
            np.testing.assert_array_equal(np.asarray(result)[~support], np.asarray(source)[~support])
            np.testing.assert_array_equal(np.asarray(result)[:, :, 3], np.asarray(source)[:, :, 3])

    async def test_unload_synchronizes_queue_before_edit_and_honors_cancel(self):
        events = []

        class Response:
            async def __aenter__(self):
                events.append("free")
                return self

            async def __aexit__(self, *args):
                return False

            def raise_for_status(self):
                pass

        class Session:
            def post(self, url, **kwargs):
                self.body = kwargs["json"]
                return Response()

        async def run(session, graph, *args, **kwargs):
            events.append("barrier")
            self.assertEqual([n["class_type"] for n in graph.values()], ["LoadImage", "PreviewImage"])

        session = Session()
        with patch.object(worker, "run_image_graph", run):
            await worker.unload_mosaic_models(session, AsyncMock(return_value="tiny.png"), [], None)
        self.assertEqual(events, ["free", "barrier"])
        self.assertEqual(session.body, {"unload_models": True, "free_memory": True})
        with patch.object(worker, "mosaic_cancelled", return_value=True):
            with self.assertRaisesRegex(RuntimeError, "已取消"):
                await worker.unload_mosaic_models(session, AsyncMock(), [], "cancel-marker")
        self.assertEqual(events, ["free", "barrier"])

    async def test_illustrious_passes_reference_to_masked_style_adapter(self):
        source = texture()
        reference = Image.new("RGB", (1024, 768), (88, 34, 143))
        settings = {**profile("illustrious"), "referenceImage": base64.b64encode(worker.png(reference)).decode("ascii")}
        areas = worker.mosaic_redraw_areas(source, [{"box": [25, 30, 45, 50]}], settings)
        uploads = {}

        async def upload(image, filename=None):
            name = filename or f"fixture-{len(uploads)}.png"
            uploads[name] = image
            return name

        graph, _ = await worker.mosaic_region_graphs(source, areas, settings, 8, upload)
        ref = uploads[graph["region_0_16"]["inputs"]["image"]]
        self.assertEqual(ref.size, (640, 480))
        self.assertEqual(ref.getpixel((0, 0)), (88, 34, 143))
        self.assertEqual(graph["region_0_13"]["inputs"]["model"], ["region_0_40", 0])
        adapter = graph["region_0_40"]["inputs"]
        self.assertEqual(adapter["model"], ["region_0_30", 0])
        self.assertEqual(adapter["attn_mask"], ["region_0_5", 1])
        self.assertEqual(adapter["weight_type"], "style transfer")
        noise = np.asarray(uploads[graph["region_0_17"]["inputs"]["image"]])[:, :, 0]
        _, _, generation, blend, _ = areas[0]
        alpha = np.asarray(blend)
        np.testing.assert_array_equal(noise[alpha == 255], 255)
        np.testing.assert_array_equal(noise[~generation], 0)
        self.assertTrue(np.any((noise > 51) & (noise < 255)))

    def test_illustrious_prompt_describes_linework_and_omits_target_parts(self):
        settings = profile("illustrious")
        size = (320, 480)
        graph = worker.mosaic_workflow("source.png", None, "mask.png", 22, settings, size, "core.png")
        tagged = worker.mosaic_workflow("source.png", None, "mask.png", 22,
                                        {**settings, "targetParts": ["fixture-target"]}, size, "core.png")
        prompt = graph["6"]["inputs"]["text"]
        self.assertIn("crisp ink outlines", prompt)
        self.assertIn("same hues and materials", prompt)
        self.assertIn("preserve occlusion", prompt)
        self.assertNotIn("mask", prompt)
        self.assertEqual(tagged["6"], graph["6"])

    async def test_missing_illustrious_weights_fail_before_comfy_start(self):
        settings = profile("illustrious")
        models = Path("fixture") / "ComfyUI/models"
        for missing in worker.ILLUSTRIOUS_WEIGHTS:
            with patch.object(Path, "is_file", lambda path: path != models / missing):
                for entry in (worker.prepare_mosaic_workflow, worker.repair_mosaic):
                    with self.assertRaisesRegex(ValueError, "缺少本地权重") as caught:
                        args = (texture(), {"directory": "fixture", "profile": settings,
                                            "regions": [{"box": [25, 30, 45, 50]}]}, 8)
                        await entry(*args, *([] if entry == worker.prepare_mosaic_workflow else [[]]))
                    self.assertIn(missing, str(caught.exception))
        with patch.object(Path, "is_file", return_value=True):
            worker.validate_mosaic_weights("fixture", settings)
        for missing in worker.SDXL_REFERENCE_WEIGHTS:
            with patch.object(Path, "is_file", lambda path: path != models / missing):
                worker.validate_mosaic_weights("fixture", settings)
                with self.assertRaisesRegex(ValueError, "缺少本地权重") as caught:
                    worker.validate_mosaic_weights("fixture", {**settings, "referenceImage": "fixture"})
                self.assertIn(missing, str(caught.exception))

    def test_line_refinement_requires_edit_weights_and_lightning_lora(self):
        settings = {**profile("illustrious"), "lineRefine": True,
                    "lineRefineWeights": profile("2511-lightning")}
        missing = Path("fixture/ComfyUI/models/loras") / worker.EDIT_LIGHTNING_LORA
        with patch.object(Path, "is_file", lambda path: path != missing):
            with self.assertRaisesRegex(ValueError, "Lightning-4steps"):
                worker.validate_mosaic_weights("fixture", settings)
        with self.assertRaisesRegex(ValueError, "权重配置"):
            worker.validate_mosaic_weights("fixture", {**settings, "lineRefineWeights": {}})

    async def test_two_stage_workflow_export_reports_required_execution_mode(self):
        with self.assertRaisesRegex(ValueError, "分两次任务"):
            await worker.prepare_mosaic_workflow(texture(), {"profile": {"lineRefine": True}}, 26)

    async def test_every_model_graph_has_independent_crops(self):
        source = texture()
        regions = [{"box": [25, 30, 45, 50]}, {"box": [440, 100, 470, 130]}]

        async def upload(image, filename=None):
            return filename or "fixture.png"

        for kind in worker.MOSAIC_WORKFLOW_KEYS:
            settings = profile(kind)
            areas = worker.mosaic_redraw_areas(source, regions, settings)
            graph, outputs = await worker.mosaic_region_graphs(source, areas, settings, 8, upload)
            self.assertEqual(len(outputs), 2)
            if kind == "2511-lightning":
                self.assertEqual(graph["region_0_13"]["inputs"]["steps"], 4)
                self.assertEqual(graph["region_0_13"]["inputs"]["cfg"], 1)
                self.assertEqual(graph["region_0_10"]["inputs"]["model"], ["region_0_29", 0])
                self.assertEqual(graph["region_0_13"]["inputs"]["positive"], graph["region_0_13"]["inputs"]["negative"])
                self.assertNotIn("region_0_7", graph)
            if kind == "illustrious":
                self.assertEqual(graph["region_0_13"]["inputs"]["steps"], 22)
                self.assertEqual(graph["region_0_13"]["inputs"]["model"], ["region_0_30", 0])
            if kind == "diffusion-cream":
                self.assertEqual(graph["region_0_41"]["class_type"], "INPAINT_MaskedBlur")
                self.assertNotIn("mask_optional", graph["region_0_35"]["inputs"])
            self.assertEqual(graph["region_0_4"]["class_type"], "ImageCrop")
            self.assertEqual(graph["region_1_4"]["inputs"]["x"], areas[1][0][0])
            for node in graph.values():
                for value in node["inputs"].values():
                    if isinstance(value, list) and len(value) == 2 and isinstance(value[0], str):
                        self.assertIn(value[0], graph)

    async def test_export_uses_same_crops_and_chains_composites(self):
        async def ready(*args):
            return []

        async def upload(*args, **kwargs):
            return "fixture.png"

        class Session:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

        source = texture()
        data = {"directory": "fixture", "profile": profile("illustrious"),
                "regions": [{"box": [25, 30, 45, 50]}, {"box": [440, 100, 470, 130]}]}
        with (
            patch.object(worker.aiohttp, "ClientSession", return_value=Session()),
            patch.object(worker, "ready", ready),
            patch.object(worker, "upload_image", upload),
            patch.object(worker, "validate_mosaic_weights"),
        ):
            graph = await worker.prepare_mosaic_workflow(source, data, 32)
        composites = [(key, node) for key, node in graph.items() if node["class_type"] == "ImageCompositeMasked"]
        self.assertEqual(composites[1][1]["inputs"]["destination"], [composites[0][0], 0])
        self.assertEqual(graph["15"]["inputs"]["images"], [composites[-1][0], 0])
        self.assertTrue(all(key.isdecimal() for key in graph))
        self.assertEqual([key for key, node in graph.items() if node["class_type"] == "PreviewImage"], ["15"])
        self.assertEqual([node["inputs"]["steps"] for node in graph.values() if node["class_type"] == "KSampler"],
                         [22, 22])

    async def test_runtime_recovery_composition_and_missing_patch(self):
        source = texture((220, 160))
        original = np.asarray(source)
        data = {"directory": "fixture", "profile": profile(), "promptId": "fixture-job",
                "regions": [{"box": [40, 50, 50, 60]}, {"box": [95, 50, 105, 60]}]}
        history = {}
        images = {}
        submissions = []
        missing = set()

        async def ready(*args):
            return []

        async def upload(*args, **kwargs):
            return "fixture.png"

        async def recovered(session, prompt_id, output, label, times, cancel_path):
            if history:
                times.append(123)
                return images["15"], history
            return None, None

        async def run(session, graph, output, label, times, submitted, **kwargs):
            submissions.append(graph)
            images.clear()
            for index in range(2):
                inputs = graph[f"region_{index}_4"]["inputs"]
                image = Image.new("RGB", (inputs["width"], inputs["height"]), (220, 30 + index*170, 40))
                images[f"region_{index}_15"] = worker.png(image)
            images["15"] = images["region_0_15"]
            history["complete"] = True
            times.append(123)
            submitted.append("fixture-prompt")
            return images["15"]

        async def read_history(*args):
            return history

        async def read_image(session, record, output, times, allow_missing=False):
            return None if allow_missing and output in missing else images[output]

        class Session:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

        with (
            patch.object(worker.aiohttp, "ClientSession", return_value=Session()),
            patch.multiple(worker, ready=ready, upload_image=upload, recover_image_graph=recovered,
                           run_image_graph=run, read_graph_history=read_history, graph_history_image=read_image),
        ):
            times = []
            repaired = np.asarray(await worker.repair_mosaic(source, data, 8, times))
            self.assertEqual(len(submissions), 1)
            self.assertEqual(times, [123])
            self.assertFalse(np.array_equal(repaired[55, 45], original[55, 45]))
            self.assertFalse(np.array_equal(repaired[55, 100], original[55, 100]))
            support = np.zeros(original.shape[:2], bool)
            for bounds, _, _, blend, _ in worker.mosaic_redraw_areas(source, data["regions"], data["profile"]):
                left, top, right, bottom = bounds
                support[top:bottom, left:right] |= np.asarray(blend) > 0
            np.testing.assert_array_equal(repaired[~support], original[~support])
            np.testing.assert_array_equal(repaired[:, :, 3], original[:, :, 3])
            repeated_times = []
            np.testing.assert_array_equal(
                np.asarray(await worker.repair_mosaic(source, data, 8, repeated_times)), repaired)
            self.assertEqual(len(submissions), 1)
            self.assertEqual(repeated_times, [123])
            missing.add("region_1_15")
            restarted_times = []
            await worker.repair_mosaic(source, data, 8, restarted_times)
            self.assertEqual(len(submissions), 2)
            self.assertEqual(restarted_times, [123])
            async def cancelled(*args):
                raise RuntimeError("fixture cancellation")

            with patch.object(worker, "check_mosaic_cancel", cancelled):
                with self.assertRaisesRegex(RuntimeError, "fixture cancellation"):
                    await worker.repair_mosaic(source, data, 8, [])
            self.assertEqual(len(submissions), 2)


if __name__ == "__main__":
    unittest.main()

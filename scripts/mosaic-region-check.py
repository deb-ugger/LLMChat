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


def mosaic_texture(size=(640, 240), cell=(3, 3)):
    width, height = size
    rng = np.random.default_rng(8127)
    colors = rng.integers(40, 220, ((height + cell[1] - 1) // cell[1],
                                  (width + cell[0] - 1) // cell[0], 3), dtype=np.uint8)
    pixels = colors.repeat(cell[1], axis=0).repeat(cell[0], axis=1)[:height, :width]
    return Image.fromarray(pixels).convert("RGBA")


class MosaicCellMeasurement(unittest.TestCase):
    def test_measures_in_sampling_pixels_after_resize(self):
        image = mosaic_texture((160, 128), (8, 8))
        mask = Image.new("L", image.size, 255)
        measured = worker.mosaic_contour_blur(image, mask, (640, 512))
        self.assertAlmostEqual(measured["cellWidthX"], 32, delta=1)
        self.assertAlmostEqual(measured["cellWidthY"], 32, delta=1)
        self.assertGreater(measured["blurKernel"], 32)
        self.assertLess(measured["blurKernel"], 42)
        self.assertEqual(measured["blurKernel"] % 2, 1)

    def test_vertical_bands_and_anisotropic_cells(self):
        image = mosaic_texture((180, 120), (12, 120))
        mask = Image.new("L", image.size, 255)
        measured = worker.mosaic_contour_blur(image, mask, (720, 480))
        self.assertAlmostEqual(measured["cellWidthX"], 48, delta=1)
        self.assertIsNone(measured["cellWidthY"])
        image = mosaic_texture((180, 120), (12, 6))
        measured = worker.mosaic_contour_blur(image, mask, (720, 480))
        self.assertAlmostEqual(measured["cellWidthX"], 48, delta=1)
        self.assertAlmostEqual(measured["cellWidthY"], 24, delta=1)
        self.assertGreater(measured["blurKernel"], 48)

    def test_clean_pixels_and_protected_holes_do_not_set_period(self):
        image = mosaic_texture((160, 128), (8, 8))
        pixels = np.array(image)
        pixels[:, 80:, :3] = np.arange(80)[None, :, None] % 2 * 255
        image = Image.fromarray(pixels)
        mask = np.zeros((128, 160), np.uint8)
        mask[:, :80] = 255
        mask[32:48, 24:40] = 0
        measured = worker.mosaic_contour_blur(image, Image.fromarray(mask), (640, 512))
        self.assertAlmostEqual(measured["cellWidthX"], 32, delta=1)
        self.assertAlmostEqual(measured["cellWidthY"], 32, delta=1)

    def test_flat_fill_and_single_outline_cannot_define_cell_width(self):
        for single_edge in (False, True):
            image = Image.new("RGB", (160, 128), (100, 100, 100))
            if single_edge:
                image.paste((220, 220, 220), (80, 0, 160, 128))
            with self.assertRaisesRegex(ValueError, "无法.*格宽"):
                worker.mosaic_contour_blur(image, Image.new("L", image.size, 255), (640, 512))


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

    def test_contour_mask_stays_inside_boxes_and_protection(self):
        source = texture((220, 160))
        pixels = np.array(source)
        pixels[52:55, 43:46, 3] = 0
        source = Image.fromarray(pixels)
        regions = [{"box": [40, 50, 60, 70]}, {"box": [65, 50, 85, 70]}]
        settings = {**profile("illustrious"), "preserveContours": True, "keep": [[50, 60, 55, 65]]}
        areas = worker.mosaic_redraw_areas(source, regions, settings)
        for bounds, crop, generation, blend, _ in areas:
            left, top, _, _ = bounds
            allowed = np.zeros(generation.shape, bool)
            for region in regions:
                x, y, r, b = region["box"]
                allowed[max(0,y-top):max(0,b-top), max(0,x-left):max(0,r-left)] = True
            allowed[60-top:65-top, 50-left:55-left] = False
            allowed &= np.asarray(crop.getchannel("A")) > 0
            np.testing.assert_array_equal(generation, allowed)
            np.testing.assert_array_equal(np.asarray(blend)[~allowed], 0)
            self.assertEqual(np.asarray(blend)[50-top, 40-left], 128)
            self.assertEqual(np.asarray(blend)[57-top, 48-left], 255)

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

    async def test_contour_recipe_keeps_base_and_outputs_edge_pass(self):
        settings = {**profile("illustrious"), "preserveContours": True, "seed": 923}
        source = mosaic_texture()
        regions = [{"box": [25, 30, 45, 50]}]
        areas = worker.mosaic_redraw_areas(source, regions, settings)
        uploads = {}

        async def upload(image, filename=None):
            name = str(len(uploads)) + ".png"
            uploads[name] = image.copy()
            return name

        graph, _ = await worker.mosaic_region_graphs(source, areas, settings, 22, upload)
        self.assertEqual([n["inputs"]["steps"] for n in graph.values() if n["class_type"] == "KSampler"], [22, 12])
        self.assertEqual(graph["region_0_13"]["inputs"]["seed"], 923)
        self.assertEqual(graph["region_0_13"]["inputs"]["denoise"], .45)
        resize = graph["region_0_5"]["inputs"]
        _, crop, generation, _, _ = areas[0]
        measured = worker.mosaic_contour_blur(crop, Image.fromarray(generation.astype(np.uint8) * 255),
                                              (resize["width"], resize["height"]))
        self.assertEqual(graph["region_0_41"]["inputs"]["blur"], measured["blurKernel"])
        self.assertGreater(measured["blurKernel"], max(width for width in (measured["cellWidthX"], measured["cellWidthY"]) if width))
        self.assertEqual(graph["region_0_35"]["inputs"]["end_percent"], 1)
        edge = graph["region_0_59"]["inputs"]
        self.assertEqual(edge["denoise"], .5)
        self.assertEqual(edge["seed"], 923)
        self.assertEqual(edge["model"], graph["region_0_13"]["inputs"]["model"])
        self.assertEqual(graph["region_0_57"]["inputs"]["pixels"], ["region_0_36", 0])
        self.assertEqual(graph["region_0_57"]["inputs"]["mask"], ["region_0_5", 1])
        self.assertEqual(graph["region_0_53"]["inputs"], {
            "image": ["region_0_5", 0], "mask": ["region_0_45", 0], "fill": "neutral", "falloff": 0})
        self.assertEqual(graph["region_0_54"]["inputs"]["mask"], ["region_0_45", 0])
        tile = graph["region_0_58"]["inputs"]
        self.assertEqual(tile["mask_optional"], ["region_0_54", 0])
        self.assertEqual((tile["strength"], tile["end_percent"]), (.45, 1))
        self.assertEqual(graph["region_0_55"]["inputs"]["image"], ["region_0_53", 0])
        self.assertEqual(graph["15"]["inputs"]["images"], ["region_0_60", 0])
        self.assertEqual(graph["region_0_15"]["inputs"]["images"], ["region_0_60", 0])
        self.assertEqual([key for key, n in graph.items() if n["class_type"] == "INPAINT_ColorMatch"], ["region_0_14"])
        self.assertEqual([key for key, n in graph.items() if n["class_type"] == "INPAINT_MaskedBlur"], ["region_0_41"])

        self.assertFalse(any(n["class_type"] == "UnetLoaderGGUF" for n in graph.values()))
        mask = np.asarray(uploads[graph["region_0_17"]["inputs"]["image"]])[:, :, 0]
        _, _, generation, blend, _ = areas[0]
        np.testing.assert_array_equal(mask[~generation], 0)
        self.assertTrue(np.any((np.asarray(blend) > 0) & (np.asarray(blend) < 255)))

    def test_edge_pass_preserves_base_nodes_and_reference_model(self):
        settings = {**profile("illustrious"), "preserveContours": True}
        for reference in (None, "style.png"):
            for whole_crop in (False, True):
                graph = worker.mosaic_workflow("source.png", reference, "mask.png", 22,
                    settings, (552, 768), "guide.png", 35)
                if whole_crop:
                    del graph["14"]
                    graph["15"]["inputs"]["images"] = ["36", 0]
                import copy
                first = copy.deepcopy(graph)
                worker.add_illustrious_edge_refinement(graph)
                for key, node in first.items():
                    if key != "15":
                        self.assertEqual(graph[key], node)
                self.assertEqual(graph["59"]["inputs"]["model"], first["13"]["inputs"]["model"])
                self.assertEqual(graph["61"]["inputs"]["images"], first["15"]["inputs"]["images"])
                self.assertEqual(graph["57"]["inputs"]["pixels"], ["36", 0])
                self.assertEqual(graph["15"]["inputs"]["images"], ["60", 0])

    async def test_contour_and_legacy_use_different_recovery_ids(self):
        recover = AsyncMock(side_effect=RuntimeError("fixture history lookup"))
        with (patch.object(worker, "validate_mosaic_weights"),
              patch.object(worker, "ready", AsyncMock(return_value=[])),
              patch.object(worker, "recover_image_graph", recover)):
            for enabled, key in ((False, "illustrious-regions-v4"), (True, "illustrious-contours-v9")):
                settings = {**profile("illustrious"), "preserveContours": enabled, "promptId": "fixture-job"}
                with self.assertRaisesRegex(RuntimeError, "fixture history lookup"):
                    await worker.repair_mosaic(texture(), {"directory": "fixture", "profile": settings,
                        "regions": [{"box": [25, 30, 45, 50]}]}, 22, [])
                expected = uuid.uuid5(uuid.NAMESPACE_URL, f"urn:llmchat:mosaic:{key}:fixture-job")
                self.assertEqual(recover.call_args.args[1], str(expected))

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
        source = mosaic_texture((220, 160), (2, 2))
        original = np.asarray(source)
        data = {"directory": "fixture", "profile": {**profile("illustrious"), "preserveContours": True}, "promptId": "fixture-job",
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
            patch.object(worker, "validate_mosaic_weights"),
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
            user_mask = np.zeros(original.shape[:2], bool)
            for region in data["regions"]:
                left, top, right, bottom = region["box"]
                user_mask[top:bottom, left:right] = True
            np.testing.assert_array_equal(repaired[~user_mask], original[~user_mask])
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

"""Synthetic geometry and orchestration checks. No image model is executed."""
import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

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
        data = {"directory": "fixture", "profile": profile(),
                "regions": [{"box": [25, 30, 45, 50]}, {"box": [440, 100, 470, 130]}]}
        with (
            patch.object(worker.aiohttp, "ClientSession", return_value=Session()),
            patch.object(worker, "ready", ready),
            patch.object(worker, "upload_image", upload),
        ):
            graph = await worker.prepare_mosaic_workflow(source, data, 8)
        composites = [(key, node) for key, node in graph.items() if node["class_type"] == "ImageCompositeMasked"]
        self.assertEqual(composites[1][1]["inputs"]["destination"], [composites[0][0], 0])
        self.assertEqual(graph["15"]["inputs"]["images"], [composites[-1][0], 0])
        self.assertTrue(all(key.isdecimal() for key in graph))
        self.assertEqual([key for key, node in graph.items() if node["class_type"] == "PreviewImage"], ["15"])

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

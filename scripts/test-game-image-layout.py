"""Targeted checks and font-fit scoring for the game image renderer."""
import argparse
import importlib.util
import json
from pathlib import Path
import sys
import unittest

import numpy as np
from PIL import Image, ImageDraw, ImageFont

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("style_redraw", ROOT / "frontend/src-tauri/src/style_redraw.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
FONT = "C:/Windows/Fonts/msyh.ttc"


class LayoutTests(unittest.TestCase):
    def test_font_floor_and_long_translation(self):
        with self.assertRaisesRegex(ValueError, "可读字号"):
            worker.game_layout_plan("无法通过无限缩小字号塞进按钮的很长译文" * 4, (70, 25), FONT, source_size=24)
        plan = worker.game_layout_plan("读取存档", (150, 34), FONT, source_size=26)
        self.assertGreaterEqual(plan["size"], round(26 * .75))
        self.assertEqual(plan["lines"], ["读取存档"])

    def test_punctuation_and_blank_lines(self):
        font = ImageFont.truetype(FONT, 24)
        text = "完成任务（奖励金币），返回城镇。"
        lines = worker.game_wrap_lines(text, font, 145)
        self.assertEqual("".join(lines), text)
        self.assertTrue(all(line[0] not in "，。！？）" and line[-1] not in "（" for line in lines))
        self.assertEqual(worker.game_wrap_lines("第一行\n\n第三行", font, 300), ["第一行", "", "第三行"])
        self.assertEqual(worker.game_ink(np.full((20, 4), 240, dtype=np.uint8)), (240, 240, 240))

    def test_multiple_lines_are_inside_the_frame(self):
        image = worker.game_layout_stamp("攻击力提高\n持续三回合", (160, 70), FONT, (30, 30, 30), source_size=25)
        bounds = image.getchannel("A").getbbox()
        self.assertTrue(bounds and bounds[0] > 0 and bounds[1] > 0 and bounds[2] < 160 and bounds[3] < 70)
        plan = worker.game_layout_plan("攻击力提高\n持续三回合", (160, 70), FONT, source_size=25)
        self.assertGreaterEqual(plan["line_step"], plan["size"] * 1.15)

    def test_exact_clean_background(self):
        y, x = np.indices((70, 210))
        clean = np.dstack((80 + x // 4, 80 + y, 90 + x // 6, np.full_like(x, 255))).astype(np.uint8)
        image = Image.fromarray(clean)
        ImageDraw.Draw(image).text((20, 12), "原文", font=ImageFont.truetype(FONT, 27), fill="white")
        patch = np.array(image)
        mask, restored = worker.repair_game_region(patch, clean)
        self.assertTrue(restored and mask.any())
        np.testing.assert_array_equal(patch, clean)

    def test_gradient_repair_and_unmasked_pixels(self):
        y, x = np.indices((80, 240))
        clean = np.dstack((60 + x // 3, 80 + y // 2, 90 + x // 4, np.full_like(x, 255))).astype(np.uint8)
        image = Image.fromarray(clean)
        ImageDraw.Draw(image).text((40, 15), "文字", font=ImageFont.truetype(FONT, 32), fill="white")
        before = np.array(image)
        repaired = before.copy()
        mask, used_base = worker.repair_game_region(repaired, None)
        self.assertFalse(used_base)
        self.assertTrue(mask.any())
        np.testing.assert_array_equal(repaired[~mask], before[~mask])
        np.testing.assert_array_equal(repaired[:, :, 3], before[:, :, 3])
        error_before = np.abs(before[:, :, :3].astype(float) - clean[:, :, :3])[mask].mean()
        error_after = np.abs(repaired[:, :, :3].astype(float) - clean[:, :, :3])[mask].mean()
        self.assertLess(error_after, error_before * .35)


def score():
    payload = json.load(sys.stdin)
    result = []
    for row in payload:
        try:
            plan = worker.game_layout_plan(row["text"], (row["width"], row["height"]), FONT, source_size=row["fontSize"])
            result.append({"fit": True, "fontSize": plan["size"], "lines": plan["lines"],
                           "retention": round(plan["size"] / row["fontSize"], 3)})
        except ValueError as error:
            result.append({"fit": False, "reason": str(error)})
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--score", action="store_true")
    args = parser.parse_args()
    if args.score:
        score()
    else:
        unittest.main(argv=[sys.argv[0]])

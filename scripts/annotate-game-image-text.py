"""Add the visually checked menu text references as a new dataset annotation version."""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import tempfile


def atomic_json(path, data):
    with tempfile.NamedTemporaryFile(dir=path.parent, suffix=".part", delete=False) as stream:
        temporary = Path(stream.name)
        stream.write((json.dumps(data, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
    try:
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def annotate(directory):
    manifest_path = directory / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    original = json.loads((directory / manifest.get("annotationsFile", "annotations.json")).read_text(encoding="utf-8-sig"))
    annotations = copy.deepcopy(original)
    reference_path = Path(__file__).resolve().parents[1] / "frontend/scripts/fixtures/game-image-text-reference.json"
    reference = json.loads(reference_path.read_text(encoding="utf-8"))
    samples = list(reference["samples"])
    for menu in reference["menus"]:
        regions = copy.deepcopy(reference["menuRegions"])
        if menu.get("description"):
            regions.append(menu["description"])
        samples.append({**menu, "regions": regions})
    by_path = {image["path"]: image for image in manifest["images"]}
    for sample in samples:
        entry = by_path.get(sample["path"])
        if not entry or entry["sha256"] != sample["sha256"]:
            raise ValueError("核对样本的原图身份不一致：" + sample["path"])
        path = directory / "images" / (entry["sha256"] + ".png")
        with path.open("rb") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() != entry["sha256"]:
                raise ValueError("样本文件内容已变化：" + sample["path"])
        for region in sample["regions"]:
            x0, y0, x1, y1 = region["box"]
            if not 0 <= x0 < x1 <= entry["width"] or not 0 <= y0 < y1 <= entry["height"]:
                raise ValueError("文字框越界：" + sample["path"])
        truth = {"state": "present" if sample["regions"] else "none", "regions": sample["regions"], "initialBoxes": []}
        saved = annotations["samples"].setdefault(entry["sha256"], {})
        if saved.get("text") and saved["text"] != truth:
            raise ValueError("已有文字标注与参考不同，请先人工核对：" + sample["path"])
        saved["text"] = truth
    output = directory / "annotations.text-reviewed-20261128.json"
    atomic_json(output, annotations)
    manifest["annotationsFile"] = output.name
    manifest["purposes"] = list(dict.fromkeys([*manifest.get("purposes", ["mosaic"]), "text"]))
    atomic_json(manifest_path, manifest)
    print(json.dumps({"annotations": str(output.resolve()), "images": len(samples),
                      "regions": sum(len(sample["regions"]) for sample in samples),
                      "translated_regions": sum(bool(region.get("translations")) for sample in samples for region in sample["regions"]),
                      "unchanged_mosaic_annotations": all(saved.get("mosaic") == annotations["samples"][key].get("mosaic")
                                                          for key, saved in original["samples"].items())}, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset", type=Path)
    annotate(parser.parse_args().dataset.resolve())

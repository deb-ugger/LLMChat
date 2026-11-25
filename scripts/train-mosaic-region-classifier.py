"""Build local region labels and train a provisional MobileNet classifier."""
import argparse
import base64
import csv
import io
import json
import random
import re
import shutil
import tempfile
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps


PARTS = ("male_external", "female_external", "other")
POLICY = "mosaic-target-evidence-v1"
PROMPT = (
    "Classify only the structure obscured in the marked rectangle of an adult fictional game illustration. "
    "Use visible surrounding contours and position. Choose male_external for external male genital anatomy, "
    "female_external for the vulva region, other for unrelated content, or unknown when visible evidence is insufficient. "
    "Report only part and whether supporting features are directly visible."
)
SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "part": {"type": "string", "enum": [*PARTS, "unknown"]},
        "visible_evidence": {"type": "boolean"},
    },
    "required": ["part", "visible_evidence"],
}


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(path, value):
    pending = path.with_suffix(".part")
    pending.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    pending.replace(path)


def scene_family(path):
    family = re.sub(r"(?:[_~-]?\d+)+$", "", Path(path).stem.casefold()).rstrip("_-")
    return str(Path(path).parent / (family or Path(path).stem))


def dataset(root, annotation_file, limit):
    manifest = read_json(root / "manifest.json")
    annotations = read_json(root / (annotation_file or manifest["annotationsFile"]))["samples"]
    index = {p.stem: p for p in (root / "images").iterdir() if p.is_file()}
    scenes = defaultdict(list)
    for entry in manifest["images"]:
        sample = annotations.get(entry["id"], {}).get("mosaic", {})
        path = index.get(entry["id"])
        if not path or sample.get("state") != "present":
            continue
        scene = scene_family(entry["path"])
        for box in sample.get("boxes", []):
            if len(box) == 4 and 0 <= box[0] < box[2] <= entry["width"] and 0 <= box[1] < box[3] <= entry["height"]:
                scenes[scene].append((entry, path, tuple(box), scene))
    groups = list(scenes.values())
    rng = random.Random(12)
    rng.shuffle(groups)
    for group in groups:
        rng.shuffle(group)
    samples = [g[i] for i in range(max(map(len, groups), default=0)) for g in groups if len(g) > i]
    return samples[:limit] if limit else samples


def crop_region(image, box):
    x0, y0, x1, y1 = box
    margin = max(40, round(max(x1 - x0, y1 - y0) * .55))
    left, top = max(0, x0 - margin), max(0, y0 - margin)
    crop = image.crop((left, top, min(image.width, x1 + margin), min(image.height, y1 + margin)))
    return crop, (x0-left, y0-top, x1-left, y1-top)


def context_signature(crop, box):
    small = crop.resize((8, 8), Image.Resampling.BOX)
    x0, y0, x1, y1 = box
    context = []
    for y in range(8):
        for x in range(8):
            # Ignore cells intersecting the mask, so block patterns cannot establish scene identity.
            if ((x + 1) * crop.width / 8 > x0 and x * crop.width / 8 < x1
                    and (y + 1) * crop.height / 8 > y0 and y * crop.height / 8 < y1):
                continue
            context.extend((y * 8 + x, *small.getpixel((x, y))))
    return context


def nearby_part(records, scene, box, context):
    position = context[::4]
    close = set()
    for other in records.values():
        if other["scene"] != scene or other["origin"] != "model" or not other["visible"]:
            continue
        if max(abs(a - b) for a, b in zip(box, other["box"])) > 3 or other["context"][::4] != position:
            continue
        differences = [abs(a - b) for i, (a, b) in enumerate(zip(context, other["context"])) if i % 4]
        if differences and sum(differences) / len(differences) <= 4:
            close.add(other["part"])
    return next(iter(close)) if len(close) == 1 else None


def annotate(crop, box, model, cpu):
    marked = crop.copy()
    ImageDraw.Draw(marked).rectangle(box, outline=(0, 250, 250), width=2)
    marked.thumbnail((448, 448))
    buffer = io.BytesIO()
    marked.save(buffer, "PNG")
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    options = {"temperature": 0, "num_predict": 64, "num_ctx": 2048}
    if cpu:
        options["num_gpu"] = 0
    payload = {
        "model": model, "stream": False, "keep_alive": "10m", "format": SCHEMA, "options": options,
        "messages": [{"role": "user", "content": PROMPT, "images": [encoded]}],
    }
    request = urllib.request.Request("http://127.0.0.1:11434/api/chat", data=json.dumps(payload).encode(),
                                     headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=120) as response:
        value = json.loads(json.load(response)["message"]["content"])
    if value.get("part") in PARTS and value.get("visible_evidence") is True:
        return value["part"], True
    return "unknown", False


def label_samples(args, samples):
    file = args.output / "region-routes.json"
    labels = read_json(file) if file.exists() else {"version": POLICY, "records": {}}
    if labels["version"] != POLICY:
        raise ValueError("已有部位记录的版本不同，请另选输出目录")
    records = labels["records"]
    for number, (entry, path, box, scene) in enumerate(samples, 1):
        key = json.dumps([entry["sha256"], box, args.model], separators=(",", ":"))
        if key in records:
            continue
        with Image.open(path) as image:
            crop, target = crop_region(image.convert("RGB"), box)
        context = context_signature(crop, target)
        part = nearby_part(records, scene, box, context) if context else None
        origin = "scene"
        visible = False
        if part is None:
            origin = "model"
            try:
                part, visible = annotate(crop, target, args.model, args.cpu_teacher)
            except (OSError, ValueError, KeyError) as error:
                print(f"{number}/{len(samples)} · request failed · {error}", flush=True)
                continue
        records[key] = {"sample": entry["id"], "source": entry.get("sourceHash"), "projectImageId": entry.get("projectImageId"),
                        "box": box, "part": part, "visible": visible, "origin": origin, "scene": scene,
                        "context": context, "model": args.model}
        write_json(file, labels)
        print(f"{number}/{len(samples)} · {part} · {origin}", flush=True)
    return labels


REVIEW_FIELDS = ("sample", "box", "image_path", "scene", "suggested_part", "corrected_part")


def review_entries(samples, records, model):
    suggestions = {(r["sample"], tuple(r["box"])): r for r in records.values() if r["model"] == model}
    return [{"sample": entry["id"], "box": json.dumps(box, separators=(",", ":")), "image_path": str(path.resolve()),
             "scene": scene, "suggested_part": suggestions.get((entry["id"], box), {}).get("part", ""),
             "corrected_part": ""} for entry, path, box, scene in samples]


def load_review(path):
    with path.open(encoding="utf-8-sig", newline="") as file:
        return {(row["sample"], row["box"]): row["corrected_part"].strip() for row in csv.DictReader(file)}


def write_table(path, fields, rows):
    pending = path.with_suffix(".part")
    with pending.open("w", encoding="utf-8-sig", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)
    pending.replace(path)


def export_review(args, samples, records):
    path = args.output / "review.csv"
    previous = load_review(path) if path.exists() else {}
    rows = review_entries(samples, records, args.model)
    current = {(row["sample"], row["box"]) for row in rows}
    # Retain corrections from a larger previous cohort even if this run uses a smaller limit.
    if path.exists():
        with path.open(encoding="utf-8-sig", newline="") as file:
            rows.extend(row for row in csv.DictReader(file) if (row["sample"], row["box"]) not in current)
    for row in rows:
        row["corrected_part"] = previous.get((row["sample"], row["box"]), "")
    write_table(path, REVIEW_FIELDS, rows)
    print("Review:", path.resolve(), flush=True)
    return path


def publish_classifier(path, directory):
    directory.mkdir(parents=True, exist_ok=True)
    active = directory / "active.pt"
    with tempfile.NamedTemporaryFile(dir=directory, prefix="active-", suffix=".part", delete=False) as stream:
        pending = Path(stream.name)
    try:
        shutil.copyfile(path, pending)
        pending.replace(active)
    finally:
        pending.unlink(missing_ok=True)
    print("Active model:", active.resolve(), flush=True)


def split_scenes(records):
    scenes = sorted({r["scene"] for r in records})
    labels = {r["part"] for r in records}
    if len(scenes) < 3 or len(labels) < 2:
        return None
    count = min(len(scenes)-1, max(2, round(len(scenes)*.25)))
    for seed in range(64):
        holdout = set(random.Random(seed).sample(scenes, count))
        train = [r for r in records if r["scene"] not in holdout]
        test = [r for r in records if r["scene"] in holdout]
        if {r["part"] for r in train} == labels and {r["part"] for r in test} == labels:
            return train, test
    return None


def train_classifier(args, samples, records):
    import torch
    from torchvision.models import MobileNet_V3_Small_Weights, mobilenet_v3_small
    torch.manual_seed(23)
    torch.set_num_threads(min(4, torch.get_num_threads()))
    lookup = {(e["id"], box): path for e, path, box, _ in samples}
    examples = [
        r for r in records.values() if r["origin"] == "model" and r["visible"] and r["model"] == args.model
        and (r["sample"], tuple(r["box"])) in lookup
    ]
    if args.review:
        corrections = load_review(args.review)
        examples = []
        for entry, _, box, scene in samples:
            part = corrections.get((entry["id"], json.dumps(box, separators=(",", ":"))), "")
            if part in ("", "skip", "unknown"):
                continue
            if part not in PARTS:
                raise ValueError(f"纠错清单有不支持的部位标签：{part}")
            examples.append({"sample": entry["id"], "box": box, "scene": scene, "part": part})
        if not set(PARTS[:2]) <= {row["part"] for row in examples}:
            raise ValueError("纠错清单需要包含 male_external 和 female_external 两类已确认样本")
    split = split_scenes(examples)
    if split is None:
        raise ValueError("已确认样本的场景或类别不足，无法按场景独立划分训练和验证")
    train, test = split
    labels = sorted({r["part"] for r in examples})
    weights = MobileNet_V3_Small_Weights.DEFAULT
    encoder = mobilenet_v3_small(weights=weights).eval()
    transform = weights.transforms()
    encoder.classifier = torch.nn.Identity()

    def features(rows):
        data = []
        for row in rows:
            box = tuple(row["box"])
            with Image.open(lookup[row["sample"], box]) as image:
                original = image.convert("RGBA")
                flattened = Image.alpha_composite(Image.new("RGBA", original.size, (128, 128, 128, 255)), original).convert("RGB")
                crop, _ = crop_region(flattened, box)
                crop.thumbnail((448, 448), Image.Resampling.BILINEAR)
                data.append(transform(ImageOps.pad(crop, (224, 224), color=(110, 110, 110))))
        with torch.no_grad():
            x = torch.cat([encoder(chunk) for chunk in torch.stack(data).split(8)])
        y = torch.tensor([labels.index(r["part"]) for r in rows])
        return torch.nn.functional.normalize(x), y

    train_x, train_y = features(train)
    test_x, test_y = features(test)
    head = torch.nn.Linear(train_x.shape[1], len(labels))
    optimizer = torch.optim.Adam(head.parameters(), lr=.03, weight_decay=.001)
    counts = torch.bincount(train_y, minlength=len(labels)).float()
    loss_fn = torch.nn.CrossEntropyLoss(weight=counts.sum() / counts)
    for _ in range(160):
        optimizer.zero_grad()
        loss = loss_fn(head(train_x), train_y)
        loss.backward()
        optimizer.step()
    actual = test_y.tolist()
    with torch.inference_mode():
        scores, predictions = head(test_x).softmax(dim=1).max(dim=1)
    inferred = predictions.tolist()
    confidence = scores.tolist()
    confident = [(a, b) for a, b, score in zip(actual, inferred, confidence) if score >= .9]
    report = {
        "teacher": args.model, "classes": labels,
        "validation": "held-out scenes, human reviewed labels" if args.review else "held-out scenes, agreement with provisional model labels",
        "training_samples": len(train), "validation_samples": len(test),
        "train_scenes": len({r["scene"] for r in train}), "validation_scenes": len({r["scene"] for r in test}),
        "agreement": sum(a == b for a, b in zip(actual, inferred)) / len(actual),
        "at_runtime_threshold": {"threshold": .9, "accepted": len(confident),
                                 "matched": sum(a == b for a, b in confident)},
        "class_agreement": {label: {"count": actual.count(i), "matched": sum(a == b == i for a, b in zip(actual, inferred))}
                            for i, label in enumerate(labels)},
    }
    model_file = args.output / "mobilenet-region-classifier.pt"
    torch.save({"format": POLICY, "classes": labels, "encoder": encoder.state_dict(), "head": head.state_dict(),
                "image_size": 224, "report": report}, model_file)
    write_json(args.output / "training-report.json", report)
    validation = [
        {"sample": row["sample"], "box": json.dumps(row["box"], separators=(",", ":")), "scene": row["scene"],
         "image_path": str(lookup[row["sample"], tuple(row["box"])].resolve()),
         "expected": labels[a], "prediction": labels[b], "confidence": round(score, 4), "matched": a == b}
        for row, a, b, score in zip(test, actual, inferred, confidence)
    ]
    write_table(args.output / "validation.csv",
                ("sample", "box", "scene", "image_path", "expected", "prediction", "confidence", "matched"), validation)
    if args.publish_dir:
        publish_classifier(model_file, args.publish_dir)
    print(json.dumps(report, ensure_ascii=False), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--annotations")
    parser.add_argument("--model", default="qwen3-vl:4b-instruct")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--cpu-teacher", action="store_true")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--label-only", action="store_true")
    mode.add_argument("--train-only", action="store_true")
    mode.add_argument("--review-only", action="store_true")
    parser.add_argument("--review", type=Path)
    parser.add_argument("--publish-dir", type=Path)
    args = parser.parse_args()
    if args.publish_dir and (not args.train_only or not args.review):
        parser.error("发布时需使用 --train-only 和人工纠错清单 --review")
    args.output.mkdir(parents=True, exist_ok=True)
    samples = dataset(args.dataset, args.annotations, args.limit)
    if not samples:
        raise ValueError("找不到现有文件对应的已确认蒙版")
    saved = args.output / "region-routes.json"
    if args.review_only or args.train_only:
        records = read_json(saved)["records"] if saved.exists() else {}
    else:
        records = label_samples(args, samples)["records"]
    if args.label_only or args.review_only:
        export_review(args, samples, records)
    else:
        train_classifier(args, samples, records)


if __name__ == "__main__":
    main()

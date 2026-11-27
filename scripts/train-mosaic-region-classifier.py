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
from region_classifier import scene_family, scene_groups


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


def dataset(root, annotation_file, limit):
    manifest = read_json(root / "manifest.json")
    annotations = read_json(root / (annotation_file or manifest["annotationsFile"]))["samples"]
    index = {p.stem: p for p in (root / "images").iterdir() if p.is_file()}
    grouped = scene_groups(manifest["images"])
    seen = set()
    scenes = defaultdict(list)
    for entry in manifest["images"]:
        sample = annotations.get(entry["id"], {}).get("mosaic", {})
        path = index.get(entry["id"])
        if not path or sample.get("state") != "present":
            continue
        scene = grouped[entry["sha256"]]
        for item in sample.get("boxes", []):
            box = item.get("box") if isinstance(item, dict) else item
            if len(box) == 4 and 0 <= box[0] < box[2] <= entry["width"] and 0 <= box[1] < box[3] <= entry["height"]:
                key = (entry["sha256"], tuple(box))
                if key in seen:
                    continue
                seen.add(key)
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
    corrected = {}
    with path.open(encoding="utf-8-sig", newline="") as file:
        for row in csv.DictReader(file):
            key = (row["sample"], json.dumps(json.loads(row["box"]), separators=(",", ":")))
            value = row["corrected_part"].strip()
            if key in corrected and corrected[key] and value and corrected[key] != value:
                raise ValueError("同一图片和框存在冲突标签")
            corrected[key] = value or corrected.get(key, "")
    return corrected


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


def train_classifier(args, samples, records):
    import copy
    import time
    import torch
    from region_classifier import FORMAT, VARIANTS, input_tensor, make_model, partition, calibrate, measured

    torch.set_num_threads(min(4, torch.get_num_threads()))
    lookup = {(entry["id"], box): path for entry, path, box, _ in samples}
    if args.review:
        corrections = load_review(args.review)
        examples = []
        for entry, _, box, scene in samples:
            part = corrections.get((entry["id"], json.dumps(box, separators=(",", ":"))), "")
            if part in ("", "skip", "unknown"):
                continue
            if part not in PARTS:
                raise ValueError("纠错清单含无效部位标签")
            examples.append({"sample": entry["id"], "box": box, "scene": scene, "part": part})
    else:
        examples = [dict(row) for row in records.values() if row["origin"] == "model" and row["visible"]
                    and row["model"] == args.model and (row["sample"], tuple(row["box"])) in lookup]
    unique = {}
    for row in examples:
        key = (row["sample"], tuple(row["box"]))
        if key in unique and unique[key]["part"] != row["part"]:
            raise ValueError("同一图片和框存在互相冲突的部位标签")
        unique[key] = row
    examples = list(unique.values())
    if args.limit:
        examples = examples[:args.limit]
    if not set(PARTS[:2]) <= {row["part"] for row in examples}:
        raise ValueError("训练需要男、女两类已确认样本")
    groups, plan = partition(examples, args.split_plan or args.dataset / "classifier-split.json")
    write_json(args.output / "classifier-split.json", plan)
    fit, calibration, test = (groups[name] for name in ("fit", "calibration", "test"))
    manifest = read_json(args.dataset / "manifest.json")
    occurrences = Counter(entry["sha256"] for entry in manifest["images"])
    duplicate_regions = sum(max(0, occurrences[row["sample"]] - 1) for row in examples)
    labels = sorted({row["part"] for row in examples})
    variants = list(VARIANTS) if args.strategy == "compare" else [args.strategy]
    results = []
    frozen_features = {}
    total_steps = len(variants) * 170
    print(f"去重后 {len(examples)} 框 · 训练 {len(fit)} · 校准 {len(calibration)} · 测试 {len(test)}", flush=True)

    for variant_index, variant in enumerate(variants):
        started = time.monotonic()
        torch.manual_seed(23)
        mode = "legacy" if variant == "A" else "target-context"
        model = make_model(labels, mode, pretrained=True).eval()
        destination = args.output / variant
        destination.mkdir(exist_ok=True)

        def tensors(rows):
            values = []
            for row in rows:
                with Image.open(lookup[row["sample"], tuple(row["box"])]) as image:
                    values.append(input_tensor(image, row["box"], mode))
            return torch.stack(values), torch.tensor([labels.index(row["part"]) for row in rows])

        print("PROGRESS " + json.dumps({"phase": "features", "current": variant_index, "total": len(variants)}), flush=True)
        fit_inputs, fit_y = tensors(fit)
        cal_inputs, cal_y = tensors(calibration)
        test_inputs, test_y = tensors(test)

        def features(inputs):
            with torch.inference_mode():
                values = torch.cat([model.features(chunk) for chunk in inputs.split(16)])
            return values.clone()

        if mode not in frozen_features:
            frozen_features[mode] = (features(fit_inputs), features(cal_inputs))
        fit_x, cal_x = frozen_features[mode]
        counts = torch.bincount(fit_y, minlength=len(labels)).float()
        loss_fn = torch.nn.CrossEntropyLoss(weight=counts.sum() / counts)
        optimizer = torch.optim.Adam(model.head.parameters(), lr=.03, weight_decay=.001)
        best_loss, best_head = float("inf"), None
        for step in range(160):
            optimizer.zero_grad()
            loss_fn(model.head(fit_x), fit_y).backward()
            optimizer.step()
            with torch.no_grad():
                value = float(torch.nn.functional.cross_entropy(model.head(cal_x), cal_y))
            if value < best_loss:
                best_loss, best_head = value, copy.deepcopy(model.head.state_dict())
            if (step + 1) % 5 == 0:
                print("PROGRESS " + json.dumps({"phase": "fit", "current": variant_index*170+step+1, "total": total_steps}), flush=True)
        model.head.load_state_dict(best_head)
        if variant == "C":
            for parameter in model.encoder.parameters():
                parameter.requires_grad_(False)
            for parameter in model.encoder.features[-3:].parameters():
                parameter.requires_grad_(True)
            parameters = [{"params": [p for p in model.encoder.parameters() if p.requires_grad], "lr": .0003},
                          {"params": model.head.parameters(), "lr": .003}]
            optimizer = torch.optim.Adam(parameters, weight_decay=.001)
            best = copy.deepcopy(model.state_dict())
            best_loss = float(torch.nn.functional.cross_entropy(model.head(cal_x), cal_y))
            for epoch in range(10):
                model.eval()
                generator = torch.Generator().manual_seed(100 + epoch)
                for indices in torch.randperm(len(fit), generator=generator).split(8):
                    optimizer.zero_grad()
                    loss_fn(model(fit_inputs[indices]), fit_y[indices]).backward()
                    optimizer.step()
                with torch.no_grad():
                    logits = torch.cat([model(chunk) for chunk in cal_inputs.split(16)])
                    value = float(torch.nn.functional.cross_entropy(logits, cal_y))
                if value < best_loss:
                    best_loss, best = value, copy.deepcopy(model.state_dict())
                print("PROGRESS " + json.dumps({"phase": "fit", "current": variant_index*170+161+epoch, "total": total_steps}), flush=True)
            model.load_state_dict(best)
        model.eval()
        with torch.no_grad():
            cal_logits = torch.cat([model(chunk) for chunk in cal_inputs.split(16)]).clone()
            test_logits = torch.cat([model(chunk) for chunk in test_inputs.split(16)]).clone()
        temperature = calibrate(cal_logits, cal_y)
        raw = measured(test_logits, test_y)
        calibrated = measured(test_logits, test_y, temperature=temperature)
        cal_metrics = measured(cal_logits, cal_y, temperature=temperature)
        scores, predictions = (test_logits / temperature).softmax(1).max(1)
        raw_scores = test_logits.softmax(1).max(1).values
        report = {
            "variant": variant, "strategy": VARIANTS[variant], "classes": labels, "input_mode": mode,
            "training_samples": len(fit), "calibration_samples": len(calibration), "validation_samples": len(test),
            "unique_samples": len(examples), "duplicate_regions": duplicate_regions, "split_id": plan["id"],
            "indexed_images": len(manifest["images"]),
            "unique_images": len({entry["sha256"] for entry in manifest["images"]}),
            "train_scenes": len({r["scene"] for r in fit}), "calibration_scenes": len({r["scene"] for r in calibration}),
            "validation_scenes": len({r["scene"] for r in test}),
            "validation": "fixed held-out scenes; independent calibration scenes",
            "agreement": calibrated["accuracy"], "macro_f1": calibrated["macro_f1"],
            "seconds": time.monotonic()-started, "temperature": temperature,
            "calibration_nll": cal_metrics["nll"],
            "at_runtime_threshold": {"threshold": .9, "accepted": calibrated["accepted"], "matched": calibrated["matched"]},
            "raw_at_runtime_threshold": {"threshold": .9, "accepted": raw["accepted"], "matched": raw["matched"]},
            "confidence_curve": [{"threshold": threshold, **measured(test_logits, test_y, threshold, temperature)}
                                 for threshold in (.5, .6, .7, .8, .85, .9, .95, .98)],
        }
        validation = []
        for row, index, score, raw_score in zip(test, predictions.tolist(), scores.tolist(), raw_scores.tolist()):
            peers = [other for other in examples if other["sample"] == row["sample"] and other is not row]
            x0, y0, x1, y1 = row["box"]
            overlaps = sum(max(0, min(x1, p["box"][2])-max(x0, p["box"][0])) *
                           max(0, min(y1, p["box"][3])-max(y0, p["box"][1])) > 0 for p in peers)
            reasons = []
            if labels[index] != row["part"]:
                reasons.append("分类错误")
            if score < .9:
                reasons.append("置信度低于0.90")
            if overlaps:
                reasons.append(f"与{overlaps}个框重叠")
            if max(x1-x0, y1-y0) < 32:
                reasons.append("目标长边小于32像素")
            validation.append({"sample": row["sample"], "box": json.dumps(row["box"], separators=(",", ":")),
                               "scene": row["scene"], "image_path": str(lookup[row["sample"], tuple(row["box"])].resolve()),
                               "expected": row["part"], "prediction": labels[index], "confidence": round(score, 6),
                               "raw_confidence": round(raw_score, 6), "matched": labels[index] == row["part"],
                               "diagnostics": "；".join(reasons)})
        write_table(destination / "validation.csv", tuple(validation[0]), validation)
        write_json(destination / "training-report.json", report)
        torch.save({"format": FORMAT, "classes": labels, "encoder": model.encoder.state_dict(),
                    "head": model.head.state_dict(), "input_mode": mode, "temperature": temperature,
                    "image_size": 224, "report": report}, destination / "mobilenet-region-classifier.pt")
        results.append(report)
        print(f"{variant} · 测试准确率 {calibrated['accuracy']:.1%} · 校准后接受 {calibrated['accepted']}/{len(test)} · {report['seconds']:.1f} 秒", flush=True)

    selected = min(results, key=lambda report: report["calibration_nll"])
    comparisons = [{key: report[key] for key in ("variant", "strategy", "agreement", "macro_f1", "seconds",
                    "calibration_nll", "temperature", "at_runtime_threshold", "validation_samples")} for report in results]
    for report in results:
        report["comparisons"] = comparisons
        report["selection_basis"] = "lowest calibration NLL; test metrics excluded"
        write_json(args.output / report["variant"] / "training-report.json", report)
    for name in ("training-report.json", "validation.csv", "mobilenet-region-classifier.pt"):
        shutil.copyfile(args.output / selected["variant"] / name, args.output / name)
    if args.publish_dir:
        publish_classifier(args.output / "mobilenet-region-classifier.pt", args.publish_dir)
    print("PROGRESS " + json.dumps({"phase": "fit", "current": total_steps, "total": total_steps}), flush=True)
    print(json.dumps(selected, ensure_ascii=False), flush=True)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--annotations")
    parser.add_argument("--model", default="qwen3-vl:4b-instruct")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--strategy", choices=("A", "B", "C", "compare"), default="compare")
    parser.add_argument("--split-plan", type=Path)
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
    sample_limit = 0 if args.review and not (args.review_only or args.label_only) else args.limit
    samples = dataset(args.dataset, args.annotations, sample_limit)
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

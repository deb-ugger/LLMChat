"""Shared preprocessing, scene partitions and inference for region classifiers."""
import hashlib
import json
import random
import re
from pathlib import Path

from PIL import Image, ImageOps

FORMAT = "mosaic-target-evidence-v2"
LEGACY_FORMAT = "mosaic-target-evidence-v1"
VARIANTS = {"A": "扩大裁图／固定特征", "B": "目标与上下文／固定特征", "C": "目标与上下文／部分微调"}


def scene_family(path):
    path = str(path).replace("\\", "/")
    parent, _, name = path.rpartition("/")
    stem = name.rsplit(".", 1)[0].casefold()
    family = re.sub(r"(?:[_~-]?\d+)+$", "", stem).rstrip("_-") or stem
    return parent + "/" + family


def scene_groups(entries):
    parents = {}
    def find(value):
        parents.setdefault(value, value)
        if parents[value] != value:
            parents[value] = find(parents[value])
        return parents[value]
    aliases = {}
    for entry in entries:
        scene = scene_family(entry["path"])
        previous = aliases.setdefault(entry["sha256"], scene)
        a, b = find(previous), find(scene)
        parents[max(a, b)] = min(a, b)
    return {entry["sha256"]: find(scene_family(entry["path"])) for entry in entries}


def partition(records, path=None):
    """Persist scene membership; all model variants share fit/calibration/test data."""
    labels = {row["part"] for row in records}
    scenes = sorted({row["scene"] for row in records})
    if len(scenes) < 3:
        raise ValueError("训练、校准与测试至少需要三个独立场景")
    path = Path(path) if path else None
    if path and path.exists():
        plan = json.loads(path.read_text(encoding="utf-8-sig"))
        if plan.get("version") != 1 or not isinstance(plan.get("scenes"), dict):
            raise ValueError("固定评估划分文件无效")
        assignments = dict(plan["scenes"])
        if any(value not in ("fit", "calibration", "test") for value in assignments.values()):
            raise ValueError("固定评估划分包含无效分区")
        for scene in scenes:
            assignments.setdefault(scene, "fit")
    else:
        assignments = None
        test_count = min(len(scenes) - 2, max(1, round(len(scenes) * .25)))
        for seed in range(256):
            test = set(random.Random(seed).sample(scenes, test_count))
            remaining = [scene for scene in scenes if scene not in test]
            count = min(len(remaining) - 1, max(1, round(len(remaining) * .25)))
            calibration = set(random.Random(seed + 1000).sample(remaining, count))
            candidate = {scene: "test" if scene in test else "calibration" if scene in calibration else "fit" for scene in scenes}
            if all({row["part"] for row in records if candidate[row["scene"]] == group} == labels
                   for group in ("fit", "calibration", "test")):
                assignments = candidate
                break
        if assignments is None:
            raise ValueError("场景或类别分布不足，无法使训练、校准与测试集均覆盖所有类别")
    groups = {name: [row for row in records if assignments[row["scene"]] == name] for name in ("fit", "calibration", "test")}
    if any({row["part"] for row in group} != labels for group in groups.values()):
        raise ValueError("固定划分中的类别覆盖不足，请补充对应场景的标注后训练")
    frozen_owners = plan.get("samples", {}) if path and path.exists() else {}
    owners = {}
    for group, rows in groups.items():
        for row in rows:
            if row["sample"] in frozen_owners and frozen_owners[row["sample"]] != group:
                raise ValueError("已有样本的固定评估分区发生变化，请在新数据集副本上建立划分")
            previous = owners.setdefault(row["sample"], group)
            if previous != group:
                raise ValueError("同一图片跨越已有评估分区，请在新数据集副本上建立划分")
    plan = {"version": 1, "scenes": assignments, "samples": {**frozen_owners, **owners}}
    identity = json.dumps(plan, sort_keys=True, separators=(",", ":"))
    plan["id"] = hashlib.sha256(identity.encode()).hexdigest()
    if path:
        path.parent.mkdir(parents=True, exist_ok=True)
        pending = path.with_suffix(".part")
        pending.write_text(json.dumps(plan, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        pending.replace(path)
    return groups, plan


def flatten(image):
    rgba = image.convert("RGBA")
    return Image.alpha_composite(Image.new("RGBA", rgba.size, (128, 128, 128, 255)), rgba).convert("RGB")


def context_crop(image, box, legacy=False):
    x0, y0, x1, y1 = box
    margin = max(40 if legacy else 12, round(max(x1 - x0, y1 - y0) * (.55 if legacy else .2)))
    return image.crop((max(0, x0-margin), max(0, y0-margin), min(image.width, x1+margin), min(image.height, y1+margin)))


def input_tensor(image, box, mode):
    import torch
    from torchvision.models import MobileNet_V3_Small_Weights
    from torchvision.transforms import functional as transforms
    image = flatten(image)
    if len(box) != 4 or not (0 <= box[0] < box[2] <= image.width and 0 <= box[1] < box[3] <= image.height):
        raise ValueError("分类目标框超出原图范围")
    if mode == "legacy":
        crop = context_crop(image, box, legacy=True)
        crop.thumbnail((448, 448), Image.Resampling.BILINEAR)
        return MobileNet_V3_Small_Weights.DEFAULT.transforms()(ImageOps.pad(crop, (224, 224), color=(110, 110, 110))).unsqueeze(0)
    if mode != "target-context":
        raise ValueError("未知的分类输入模式")
    views = [image.crop(tuple(box)), context_crop(image, box)]
    tensors = []
    for view in views:
        padded = ImageOps.pad(view, (224, 224), method=Image.Resampling.BILINEAR, color=(110, 110, 110))
        tensor = transforms.to_tensor(padded)
        tensors.append(transforms.normalize(tensor, [.485, .456, .406], [.229, .224, .225]))
    return torch.stack(tensors)


def make_model(classes, mode, pretrained=False):
    import torch
    from torchvision.models import MobileNet_V3_Small_Weights, mobilenet_v3_small

    class RegionClassifier(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.encoder = mobilenet_v3_small(weights=MobileNet_V3_Small_Weights.DEFAULT if pretrained else None)
            self.encoder.classifier = torch.nn.Identity()
            self.head = torch.nn.Linear(576 * (2 if mode == "target-context" else 1), len(classes))

        def features(self, inputs):
            batch, views = inputs.shape[:2]
            values = self.encoder(inputs.flatten(0, 1)).reshape(batch, views * 576)
            return torch.nn.functional.normalize(values, dim=1)

        def forward(self, inputs):
            return self.head(self.features(inputs))

    return RegionClassifier()


def calibrate(logits, labels):
    import torch
    logits = logits.detach()
    scale = torch.zeros((), requires_grad=True)
    optimizer = torch.optim.LBFGS([scale], lr=.1, max_iter=40)
    def closure():
        optimizer.zero_grad()
        loss = torch.nn.functional.cross_entropy(logits / scale.exp().clamp(.05, 20), labels)
        loss.backward()
        return loss
    before = float(torch.nn.functional.cross_entropy(logits, labels))
    optimizer.step(closure)
    temperature = float(scale.detach().exp().clamp(.05, 20))
    after = float(torch.nn.functional.cross_entropy(logits / temperature, labels))
    return temperature if after < before else 1.0


def measured(logits, labels, threshold=.9, temperature=1.0):
    import torch
    probabilities = (logits / temperature).softmax(1)
    confidence, predictions = probabilities.max(1)
    correct = predictions.eq(labels)
    accepted = confidence.ge(threshold)
    class_count = logits.shape[1]
    f1 = []
    for index in range(class_count):
        tp = int(((predictions == index) & (labels == index)).sum())
        denominator = int((predictions == index).sum() + (labels == index).sum())
        f1.append(2 * tp / denominator if denominator else 0.0)
    return {"accuracy": float(correct.float().mean()), "macro_f1": sum(f1)/len(f1),
            "accepted": int(accepted.sum()), "matched": int((accepted & correct).sum()),
            "nll": float(torch.nn.functional.cross_entropy(logits / temperature, labels))}


def predict(image, box, state):
    import torch
    from torchvision.models import MobileNet_V3_Small_Weights
    classes = state.get("classes", [])
    if not 2 <= len(classes) <= 3 or len(set(classes)) != len(classes) or not set(classes) <= {"male_external", "female_external", "other"}:
        raise ValueError("部位分类器类别无效")
    legacy = state.get("format") == LEGACY_FORMAT
    if not legacy and state.get("format") != FORMAT:
        raise ValueError("部位分类器格式不匹配")
    mode = "legacy" if legacy else state["input_mode"]
    model = make_model(classes, mode).eval()
    model.encoder.load_state_dict(state["encoder"])
    model.head.load_state_dict(state["head"])
    temperature = 1.0 if legacy else float(state.get("temperature", 1))
    if not .05 <= temperature <= 20:
        raise ValueError("分类器校准温度无效")
    with torch.inference_mode():
        inputs = input_tensor(image, box, mode).unsqueeze(0)
        scores, indices = (model(inputs) / temperature).softmax(1).max(1)
    return {"part": classes[int(indices[0])], "confidence": float(scores[0]), "threshold": .9}

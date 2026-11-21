from pathlib import Path
import hashlib
import json
import os
import sys
import urllib.request

root = Path(__file__).resolve().parents[1]
output = root / "frontend/public/mosaic-detector"
model = output / "model.onnx"
manifest = output / "manifest.json"
source = ("https://huggingface.co/kitsumed/yolov11m_seg-2d-censorship-detection/"
          "resolve/3acab0bd97658a9c63fcb4a577eec815e4b38641/model_fp16_dynamic.onnx")
checksum = "c58d61183be02522a10ef915c554f85de75f3064017e4904bf3c501809f309b9"
if model.is_file() and manifest.is_file() and (output / "LICENSE.txt").is_file():
    print("Built-in 2D censorship detector is ready.")
    sys.exit(0)

sys.path.insert(0, str(root / "backend/build/mosaic-export-deps"))
import onnx

cache = root / "backend/build/mosaic-detector"
cache.mkdir(parents=True, exist_ok=True)
download = cache / "source.onnx"
if not download.is_file():
    print("Downloading 2D censorship detection weights...", flush=True)
    urllib.request.urlretrieve(source, download)
if hashlib.sha256(download.read_bytes()).hexdigest() != checksum:
    raise RuntimeError("2D detector source checksum mismatch")

output.mkdir(parents=True, exist_ok=True)
exported = onnx.load(str(download))
shapes = [(exported.graph.input[0], [1, 3, 640, 640]),
          (exported.graph.output[0], [1, 38, 8400]),
          (exported.graph.output[1], [1, 32, 160, 160])]
for value, shape in shapes:
    for dim, size in zip(value.type.tensor_type.shape.dim, shape):
        dim.ClearField("dim_param")
        dim.dim_value = size
# The upstream FP16 export places some input casts after their consumers.
pending = list(exported.graph.node)
ordered = []
known = {value.name for value in exported.graph.input} | {value.name for value in exported.graph.initializer}
while pending:
    ready = [node for node in pending if all(not name or name in known for name in node.input)]
    if not ready:
        raise RuntimeError("Unresolved 2D detector graph input")
    for node in ready:
        ordered.append(node)
        known.update(node.output)
        pending.remove(node)
del exported.graph.node[:]
exported.graph.node.extend(ordered)
onnx.checker.check_model(exported)
temporary = output / "model.download.onnx"
manifest_temporary = output / "manifest.download.json"
try:
    onnx.save(exported, str(temporary))
    urllib.request.urlretrieve("https://www.gnu.org/licenses/agpl-3.0.txt", output / "LICENSE.txt")
    os.replace(temporary, model)
    manifest_temporary.write_text(json.dumps({
        "name": "YOLO11m 2D censorship detection",
        "author": "kitsumed", "source": source, "sourceSha256": checksum,
        "license": "AGPL-3.0",
        "sha256": hashlib.sha256(model.read_bytes()).hexdigest(),
        "input": [1, 3, 640, 640], "classes": ["Censor Bar", "Pixelation"],
        "conversion": "Fixed input/output shapes and topological node order; original weights retained",
    }, ensure_ascii=False, indent=2), encoding="utf8")
    os.replace(manifest_temporary, manifest)
    print(f"Prepared {model} ({model.stat().st_size / 1024**2:.1f} MiB)")
finally:
    temporary.unlink(missing_ok=True)
    manifest_temporary.unlink(missing_ok=True)

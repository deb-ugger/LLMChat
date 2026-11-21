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
presence_source = ("https://huggingface.co/Maltox/anime-censorship-tagger-mnv3-384/"
                   "resolve/b6c017a5c9ee4273f27db51b0fe96956184ffa0e/")
presence_checksum = "25f04c26c4375f72740f6a4c756f4316d6ae30fff12a979ac9dae603ab743509"
presence = output / "presence.onnx"
presence_manifest = output / "presence.json"
presence_files = [presence, presence_manifest, output / "PRESENCE-LICENSE.txt", output / "PRESENCE-NOTICE.txt"]
if not all(path.is_file() for path in presence_files):
    output.mkdir(parents=True, exist_ok=True)
    temporary_presence = output / "presence.download.onnx"
    temporary_manifest = output / "presence.download.json"
    try:
        print("Downloading the lightweight censorship classifier...", flush=True)
        urllib.request.urlretrieve(presence_source + "model.onnx", temporary_presence)
        if hashlib.sha256(temporary_presence.read_bytes()).hexdigest() != presence_checksum:
            raise RuntimeError("Censorship classifier checksum mismatch")
        urllib.request.urlretrieve(presence_source + "LICENSE", output / "PRESENCE-LICENSE.txt")
        urllib.request.urlretrieve(presence_source + "NOTICE", output / "PRESENCE-NOTICE.txt")
        temporary_manifest.write_text(json.dumps({
            "name": "Anime Censorship Tagger MobileNetV3-384", "author": "Maltox",
            "source": presence_source + "model.onnx", "sha256": presence_checksum,
            "license": "Apache-2.0", "input": [1, 3, 384, 384],
            "preprocessing": "RGB, white alpha composite, bilinear squash, (x/255-0.5)/0.5",
            "columns": ["censored", "bar", "ineffective", "mosaic"], "candidateThreshold": 0.47,
        }, ensure_ascii=False, indent=2), encoding="utf8")
        os.replace(temporary_presence, presence)
        os.replace(temporary_manifest, presence_manifest)
    finally:
        temporary_presence.unlink(missing_ok=True)
        temporary_manifest.unlink(missing_ok=True)

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

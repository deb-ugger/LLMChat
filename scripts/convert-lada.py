from pathlib import Path
import hashlib
import json
import os
import sys
import urllib.request

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / "backend/build/lada-export-deps"))
output = root / "frontend/public/lada"
variants = {
    "fast": "9a6b660d1d3e3797d39515e08b0e72fcc59815f38279faa7a4ab374ab2c1e3b4",
    "accurate": "c244d7e49d8f88e264b8dc15f91fb21f5908ad8fb6f300b7bc88462d0801bc1f",
}
missing = [name for name in variants if not (output / f"lada-v4-{name}.onnx").is_file()
           or not (output / f"{name}.json").is_file()]
if not missing and (output / "LICENSE.txt").is_file():
    print("Built-in Lada v4 Fast and Accurate are ready.")
    sys.exit(0)

config = root / "backend/build/lada-config"
config.mkdir(parents=True, exist_ok=True)
os.environ.setdefault("YOLO_CONFIG_DIR", str(config))
import torch
import onnx
from ultralytics import YOLO

cache = root / "backend/build/lada-export"
cache.mkdir(parents=True, exist_ok=True)
output.mkdir(parents=True, exist_ok=True)
torch.set_num_threads(2)
for name in missing:
    checksum = variants[name]
    source = ("https://huggingface.co/ladaapp/lada/resolve/"
              "404620fe2f6b72657b92f76e62af914c8b3ee686/"
              f"lada_mosaic_detection_model_v4_{name}.pt")
    model = output / f"lada-v4-{name}.onnx"
    weights = cache / f"lada-v4-{name}.pt"
    if not weights.is_file():
        print(f"Downloading official Lada v4 {name} weights...", flush=True)
        urllib.request.urlretrieve(source, weights)
    if hashlib.sha256(weights.read_bytes()).hexdigest() != checksum:
        raise RuntimeError(f"Lada {name} source checksum mismatch")
    network = YOLO(str(weights)).model.float().eval()
    network.fuse()
    head = network.model[-1]
    head.export = True
    head.format = "onnx"
    head.dynamic = False
    temporary = output / f"lada-v4-{name}.download.onnx"
    try:
        torch.onnx.export(network, torch.zeros(1, 3, 640, 640), str(temporary),
                          opset_version=17, input_names=["images"],
                          output_names=["detections", "masks"], dynamo=False)
        exported = onnx.load(str(temporary))
        onnx.checker.check_model(exported)
        onnx.save(exported, str(temporary))
        os.replace(temporary, model)
        (output / f"{name}.json").write_text(json.dumps({
            "name": f"Lada v4 {name}", "source": source, "sourceSha256": checksum,
            "license": "AGPL-3.0", "upstream": "https://github.com/ladaapp/lada",
            "sha256": hashlib.sha256(model.read_bytes()).hexdigest(),
            "export": {"format": "onnx", "input": [1, 3, 640, 640], "precision": "FP32",
                       "nms": False, "opset": 17, "ultralytics": "8.3.243"},
        }, ensure_ascii=False, indent=2), encoding="utf8")
        print(f"Prepared {model} ({model.stat().st_size / 1024**2:.1f} MiB)")
    finally:
        temporary.unlink(missing_ok=True)
if not (output / "LICENSE.txt").is_file():
    urllib.request.urlretrieve("https://raw.githubusercontent.com/ladaapp/lada/main/LICENSES/AGPL-3.0.txt",
                               output / "LICENSE.txt")

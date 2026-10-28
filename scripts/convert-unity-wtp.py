"""Prepare the official FP16 WtP graph for the shipped FP32 WASM runtime.

Build-time dependency: onnx==1.17.0. No Python is used by the application.
"""
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import onnx
from onnx import numpy_helper

source, destination = map(Path, sys.argv[1:3])
source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
if source_hash != "8f2e2ada50239bef37469e4187b209c70d141e02f193cdfb5436e2ed6070479a":
    raise ValueError("Official WtP model SHA-256 does not match")
model = onnx.load(source)
for tensor in model.graph.initializer:
    if tensor.data_type == onnx.TensorProto.FLOAT16:
        tensor.CopyFrom(numpy_helper.from_array(numpy_helper.to_array(tensor).astype(np.float32), tensor.name))
for value in [*model.graph.input, *model.graph.output, *model.graph.value_info]:
    if value.type.tensor_type.elem_type == onnx.TensorProto.FLOAT16:
        value.type.tensor_type.elem_type = onnx.TensorProto.FLOAT
for node in model.graph.node:
    for attribute in node.attribute:
        if attribute.type == onnx.AttributeProto.TENSOR and attribute.t.data_type == onnx.TensorProto.FLOAT16:
            attribute.t.CopyFrom(numpy_helper.from_array(numpy_helper.to_array(attribute.t).astype(np.float32), attribute.t.name))
# The official optimized graph uses standard LayerNormalization but declares
# opset 13. That operator was standardized in opset 17; other used standard
# operators retain their input contracts between these versions.
for opset in model.opset_import:
    if not opset.domain:
        opset.version = 17
onnx.checker.check_model(model)
onnx.save(model, destination)
destination.with_name("manifest.json").write_text(json.dumps({
    "model": "benjamin/wtp-bert-mini",
    "revision": "ac9218133a447014fa557a9997a1422def9bc6e8",
    "license": "MIT", "formatVersion": 1, "precision": "float32",
    "sourceSha256": source_hash,
    "sha256": hashlib.sha256(destination.read_bytes()).hexdigest(),
    "bytes": destination.stat().st_size,
    "threshold": 0.01, "languages": 85,
}, indent=2), encoding="utf-8")
print(f"WtP model prepared: {destination.stat().st_size / 1024**2:.2f} MiB")

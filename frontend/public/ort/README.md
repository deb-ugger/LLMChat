# Local ONNX Runtime Web assets

PaddleOCR's module Worker uses the JSEP-capable ONNX Runtime Web build even
when the selected execution provider is WASM. These files are copied from
`onnxruntime-web@1.29.0` and shipped locally so OCR stays offline.

- `ort-wasm-simd-threaded.jsep.mjs`
  - SHA-256: `3D68FA7AF88C48894D4B0C8629DE12018AB73B77519BC0B05DC8D908AD82749F`
- `ort-wasm-simd-threaded.jsep.wasm`
  - SHA-256: `DB816FADBAB47A755170C08F933961E231412AC17F5981F9A62E519708A44DEA`

ONNX Runtime is licensed under MIT.

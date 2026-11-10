# Manga OCR cached decoder
Derived from the installed onnx-community/manga-ocr-base-ONNX quantized decoder:
https://huggingface.co/onnx-community/manga-ocr-base-ONNX
Original Manga OCR:
https://github.com/kha-white/manga-ocr
License: Apache-2.0.
Export and equivalence validation: scripts/export-manga-kv.py.
The initial decoder returns self/cross attention KV tensors; subsequent calls
consume only one new token and those tensors. Files ship with the OCR runtime.

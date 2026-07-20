/**
 * pdfjs-dist/web/pdf_viewer.mjs 在模块求值时会解构 globalThis.pdfjsLib。
 * 必须在导入 pdf_viewer 之前完成赋值（由 PdfPane 的 import 顺序保证）。
 */
import * as pdfjsLib from "pdfjs-dist";

(globalThis as unknown as { pdfjsLib: typeof pdfjsLib }).pdfjsLib = pdfjsLib;

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

export {
  AnnotationMode,
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentProxy,
} from "pdfjs-dist";

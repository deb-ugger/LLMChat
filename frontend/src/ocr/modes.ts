import type { OcrMode } from "../api";

export function normalizeOcrMode(value: string): OcrMode {
  return value === "precise" || value === "english" || value === "manga"
    ? value
    : "fast";
}

export const OCR_MODE_LABELS: Record<OcrMode, string> = {
  fast: "快速",
  precise: "精确",
  english: "英文增强",
  manga: "漫画增强",
};

export const OCR_MODE_OPTIONS: Array<{
  id: OcrMode;
  title: string;
  detectionModel: string;
  recognitionModel: string;
  description: string;
  warning?: string;
}> = [
  {
    id: "fast",
    title: OCR_MODE_LABELS.fast,
    detectionModel: "PP-OCRv6 small det",
    recognitionModel: "PP-OCRv6 small rec",
    description:
      "普通 PDF、截图、常规中英日内容，以及流程图、架构图和稀疏标签图；启动最快、资源占用最低。",
  },
  {
    id: "precise",
    title: OCR_MODE_LABELS.precise,
    detectionModel: "PP-OCRv6 medium det",
    recognitionModel: "PP-OCRv6 medium rec",
    description: "密集排版、小字号、复杂表格、公式周边文字及质量较差的扫描件。",
    warning:
      "并不是越“精确”越好：流程图、架构图和稀疏标签图可能因相邻文字框被合并，效果反而不如快速模式。",
  },
  {
    id: "english",
    title: OCR_MODE_LABELS.english,
    detectionModel: "PP-OCRv6 medium det",
    recognitionModel: "en_PP-OCRv5 mobile rec",
    description:
      "英文论文、英文技术文档、代码说明及英文缩写较多的页面；流程图仍建议先与快速模式比较。",
  },
  {
    id: "manga",
    title: OCR_MODE_LABELS.manga,
    detectionModel: "PP-OCRv6 medium det",
    recognitionModel: "Manga OCR base INT8",
    description:
      "日文漫画、竖排气泡、振假名、艺术字体及图片背景上的文字；会按气泡合并并使用日文阅读顺序。",
    warning: "仅用于图片文字识别，不用于文献 PDF。",
  },
];

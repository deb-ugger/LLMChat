# LLMChat

LLMChat 是一款面向 Windows 的桌面翻译与阅读工具，提供对话、文献翻译、图片文字识别、语音转文字、文本翻译工程和 Unity 游戏翻译。桌面界面使用 Tauri 2、React 与 TypeScript，本地服务使用 C++20，Unity 资源处理工具使用 .NET 8。

## 主要功能

- **对话**：连接模型 API，显示 Markdown、LaTeX、代码和历史消息。
- **文献翻译**：阅读 PDF、EPUB，选取原文后翻译或查词；扫描内容使用本地 OCR，可提取和导出文献图片。
- **图片文字识别**：提供快速、精确、英文增强和漫画增强模式，在原图位置显示译文，支持区域编辑和重新识别。
- **语音转文字**：批量导入音频、选取处理片段、本地转写或使用在线模型，支持暂停与继续、字幕搜索、分屏查看及 SRT、VTT、TXT 输出；可选大模型校对。
- **文本翻译工程**：处理文本、Markdown、EPUB、字幕和 MTool/JSON，支持术语表、替换规则、质量检查、失败重试及工程保存。
- **Unity 翻译**：提供运行时翻译和嵌字翻译。嵌字流程包括资源扫描、文本翻译、图片识别与翻译、生成补丁和应用到游戏；支持工程恢复、复用已有结果及文本与图片分别处理。
- **用量统计**：按模型、功能和时间查看接口调用、Token 用量及估算费用。

语言、识别模式和输出格式在相应操作页选择；凭证、代理、并发限制、模型下载及输出目录在设置中管理。API Key 保存在本地配置中，不应提交到版本库。

## 使用说明

便携版解压后运行 `llmchat.exe`，保留同目录的后端程序和 `resources/`。本地 OCR 与语音模型在本机推理；使用在线翻译、在线语音或大模型校对时，对应内容会发送到所选服务。

- **文献**：打开 PDF 或 EPUB，选择源语言、目标语言和翻译方式，再选取内容。OCR 模式影响图片和扫描内容的识别，不会自动修复原生 PDF 的文本层、列表结构或阅读顺序。
- **图片**：导入图片，选择识别模式后运行。扩展模型需先下载；英文增强用于英文文字，漫画增强主要用于日文漫画文字。
- **语音**：在设置中指定输出目录，再添加音频、选择模型和输出格式。模型按需下载；输出使用原文件名与日期，同名任务自动添加递增编号。
- **文本工程**：创建或打开工程，选择翻译方式后处理，检查失败或警告条目，再保存工程或导出文件。
- **Unity**：选择游戏目录，按扫描、翻译、生成补丁、应用的流程操作。生成补丁使用已勾选且有效的文本和图片结果；搜索和“仅看未完成 / 失败”只改变显示范围。

## 项目结构

- `backend/`：C++20 本地 HTTP 服务。
- `frontend/`：Tauri 2、React、TypeScript 与 Vite 桌面界面。
- `tools/UnityOffline/`：Unity 资源扫描、纹理解码、字体处理和补丁回写工具。
- `scripts/`：后端准备、构建和便携版生成脚本。
- `config.ini.example`：配置文件示例。
- `dist-portable/`：生成后的便携版目录。

后端默认监听 `127.0.0.1:17800`。

## 开发环境

- Windows 10 或 Windows 11
- Visual Studio 2022，并安装“使用 C++ 的桌面开发”组件
- CMake 3.16 或更高版本
- Node.js 24，包含 npm
- Rust stable 工具链
- .NET SDK 8 或更高版本
- Microsoft Edge WebView2 Runtime

首次从源码准备 WtP 分段模型时，还需要构建环境中的 Python、`onnx==1.17.0` 与 NumPy：

```powershell
python -m pip install onnx==1.17.0 numpy
```

可用环境变量 `LLMCHAT_MODEL_PYTHON` 指定该 Python 解释器。已有分段模型资源时不重复转换；使用便携版不需要安装 Python 或 .NET SDK。

## 安装依赖

```powershell
cd frontend
npm install
```

## 开发运行

先准备后端、语音解码和 Unity 工具资源（在仓库根目录执行）：

```powershell
powershell -File scripts/prepare-sidecar.ps1
powershell -File scripts/prepare-speech-tools.ps1
powershell -File scripts/prepare-unity-tools.ps1
```

启动桌面开发环境：

```powershell
cd frontend
npm run tauri dev
```

仅调试浏览器界面时，可分别启动后端和 Vite：

```powershell
cd backend\build\Release
.\llmchat-backend.exe
```

```powershell
cd frontend
npm run dev
```

## 构建

### 一键更新便携版

先保存软件中尚未保存的内容，然后双击仓库根目录的 `build.cmd`；也可以在仓库根目录运行一条命令：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build.ps1
```

脚本自动取得全局构建锁，依次关闭本仓库的主程序和后台、构建后端、准备语音解码工具、构建 Release 桌面程序、更新并校验便携版。优先正常关闭窗口，10 秒后仍未退出的已核实本仓库进程会被强制结束，因此运行前请保存内容；其他目录的同名程序不会结束。任何一步失败都会停止后续步骤，并释放构建锁。脚本不运行全量测试。

首次准备语音解码工具需要联网下载 FFmpeg；工具版本未变化时复用已有文件。缺少前端依赖时自动运行 `npm ci`。可通过 `-Proxy http://127.0.0.1:7892` 指定 FFmpeg 下载代理。自动化代理调用时可传入自己的稳定 `-Owner`，但必须先释放文件锁。

更新只替换程序和资源，保留已有的配置、会话、统计数据、翻译工程、语音任务输出和模型缓存。

更新后的 `dist-portable/` 也包含 `build.cmd`，可直接双击再次构建；此入口要求便携版目录仍放在源码仓库下，移动到其他位置后不能独立编译。

### 分步构建

构建后端并准备 sidecar：

```powershell
powershell -File scripts/prepare-sidecar.ps1
```

准备语音解码工具并构建桌面程序：

```powershell
powershell -File scripts/prepare-speech-tools.ps1
powershell -File scripts/prepare-unity-tools.ps1
cd frontend
npm run tauri -- build --no-bundle
```

桌面程序生成在：

```text
frontend/src-tauri/target/release/llmchat.exe
```

生成便携版：

```powershell
powershell -File scripts/make-portable.ps1
```

便携版生成在 `dist-portable/`。脚本更新程序文件时会保留该目录中已有的配置、统计数据、会话、文本工程和 OCR 模型。

`Release` 是编译配置，便携版是程序与运行资源的分发目录；一键便携版构建使用的就是 Release 主程序。分步构建由自动化代理执行时，应先按 [AGENTS.md](AGENTS.md) 取得全局锁。

## 源码检查

仅检查 TypeScript，不生成安装包或更新便携版：

```powershell
cd frontend
node node_modules/typescript/bin/tsc -b --noEmit
```

功能验证按改动范围选择对应的定向检查，不默认运行全量测试。

## 开源项目与模型来源

以下列出项目的直接依赖、所用模型和功能工具，并注明实际用途。模型与插件按相应功能使用或下载；并非全部随主程序内置。完整的间接依赖见 `frontend/package-lock.json`、`frontend/src-tauri/Cargo.lock` 及 `tools/UnityOffline/UnityOffline.csproj`。

### 桌面界面、阅读与数据处理

| 项目 | 在 LLMChat 中的用途 |
| --- | --- |
| [Tauri](https://github.com/tauri-apps/tauri) / [官方插件](https://github.com/tauri-apps/plugins-workspace) | 桌面窗口、前后端调用、文件对话框、剪贴板和系统打开操作 |
| [React / React DOM](https://github.com/facebook/react) | 页面、表格和交互组件 |
| [TypeScript](https://github.com/microsoft/TypeScript) | 前端类型检查与编译 |
| [Vite](https://github.com/vitejs/vite) / [React 插件](https://github.com/vitejs/vite-plugin-react) | 前端开发与资源构建 |
| [PDF.js](https://github.com/mozilla/pdf.js) | PDF 渲染、文本层与文字提取 |
| [epub.ts](https://github.com/likecoin/epub.ts) | EPUB 阅读与渲染；使用 `@likecoin/epub-ts`，是 epub.js 的 TypeScript 分支 |
| [JSZip](https://github.com/Stuk/jszip) | ZIP / EPUB 资源读取与打包 |
| [react-markdown](https://github.com/remarkjs/react-markdown) | Markdown 内容渲染 |
| [remark-gfm](https://github.com/remarkjs/remark-gfm) | Markdown 表格、任务列表等语法 |
| [remark-math / rehype-katex](https://github.com/remarkjs/remark-math) / [KaTeX](https://github.com/KaTeX/KaTeX) | 数学公式解析与显示 |
| [Apache ECharts](https://github.com/apache/echarts) | 用量与费用统计图表 |
| [OpenCC-JS](https://github.com/nk2028/opencc-js) | 中文简繁转换 |
| [xmldom](https://github.com/xmldom/xmldom) | EPUB 处理的定向检查中使用的 XML 解析与序列化工具；软件界面使用 WebView 原生 DOM |
| [cpp-httplib](https://github.com/yhirose/cpp-httplib) | C++ 本地 HTTP 服务 |
| [JSON for Modern C++](https://github.com/nlohmann/json) | C++ JSON 读取与序列化 |
| [SQLite](https://sqlite.org/) | 会话和用量数据存储；Windows 下调用系统 SQLite，不另附 SQLite 程序 |
| [Serde](https://github.com/serde-rs/serde) / [serde_json](https://github.com/serde-rs/json) | Rust 数据序列化与 JSON 处理 |
| [arboard](https://github.com/1Password/arboard) / [clipboard-win](https://github.com/DoumanAsh/clipboard-win) | 原生剪贴板读取与 Windows 剪贴板操作 |
| [image](https://github.com/image-rs/image) | Rust 侧 PNG 图片处理 |

### OCR、语音与分段模型

| 项目或模型 | 在 LLMChat 中的用途与来源 |
| --- | --- |
| [PaddleOCR / PaddleOCR.js](https://github.com/PaddlePaddle/PaddleOCR) | 本地文字检测和识别，使用 `@paddleocr/paddleocr-js`；快速模式为 PP-OCRv6 small，精确模式为 PP-OCRv6 medium，英文增强使用 medium 检测器与 en_PP-OCRv5 mobile 识别器 |
| [Manga OCR](https://github.com/kha-white/manga-ocr) | 日文漫画文字识别；使用 [ONNX Community 权重](https://huggingface.co/onnx-community/manga-ocr-base-ONNX)，部分配置和分词器来自 [NorwayFish/manga-ocr](https://huggingface.co/NorwayFish/manga-ocr) |
| [Transformers.js](https://github.com/huggingface/transformers.js) | 在本机加载和运行语音、漫画识别模型 |
| [ONNX Runtime](https://github.com/microsoft/onnxruntime) | 浏览器 / WASM 模型推理，以及 Unity 工具中的 .NET 分段推理 |
| [Whisper](https://github.com/openai/whisper) | 多语言语音转文字；当前下载 [Tiny](https://huggingface.co/onnx-community/whisper-tiny)、[Base](https://huggingface.co/onnx-community/whisper-base)、[Small](https://huggingface.co/onnx-community/whisper-small) 的 ONNX 版本 |
| [Whisper Small 中文特化 ONNX](https://huggingface.co/onnx-community/whisper-small-chinese-2-ONNX) | 中文录音转写 |
| [Distil-Whisper](https://github.com/huggingface/distil-whisper) / [distil-small.en ONNX](https://huggingface.co/onnx-community/distil-small.en) | 英文特化语音转写 |
| [Kotoba-Whisper v2.2 ONNX](https://huggingface.co/onnx-community/kotoba-whisper-v2.2-ONNX) | 日文特化语音转写 |
| [wtpsplit / WtP](https://github.com/segment-any-text/wtpsplit) / [wtp-bert-mini](https://huggingface.co/benjamin/wtp-bert-mini) | Unity 原文智能分段及译文断行辅助；构建脚本将上游 ONNX 模型转换为当前运行时使用的 FP32 版本 |
| [FFmpeg](https://ffmpeg.org/) | 音频信息读取、解码与片段转换；Windows 工具取自 [Gyan.dev 构建](https://www.gyan.dev/ffmpeg/builds/) |

### Unity 翻译与资源工具

| 项目 | 在 LLMChat 中的用途 |
| --- | --- |
| [XUnity.AutoTranslator](https://github.com/bbepis/XUnity.AutoTranslator) | Unity 运行时翻译插件、配置管理及其发布的 TMP 字体资源包 |
| [BepInEx](https://github.com/BepInEx/BepInEx) | 相应 Unity 游戏的插件加载环境，按安装方式下载使用 |
| [AssetsTools.NET](https://github.com/nesrak1/AssetsTools.NET) | Unity Assets / Bundle 读取和回写；同时使用 Texture 与 MonoCecil 扩展 |
| [UABEA](https://github.com/nesrak1/UABEA) | Unity 类数据库 `classdata.tpk` 的来源，供资源字段解析使用 |
| [AssetRipper.TextureDecoder](https://github.com/AssetRipper/AssetRipper.TextureDecoder) | 通过纹理扩展使用的 Unity 纹理解码能力 |
| [StbImageSharp](https://github.com/StbSharp/StbImageSharp) / [StbImageWriteSharp](https://github.com/StbSharp/StbImageWriteSharp) | 图片解码与译图输出 |
| [Mono.Cecil](https://github.com/jbevain/cecil) | .NET / Mono 程序集及 Unity 序列化类型信息读取 |
| [Noto CJK](https://github.com/notofonts/noto-cjk) | 中文字体下载与游戏字体替换 |
| [7-Zip](https://www.7-zip.org/) | 下载的字体资源包解压，按需使用 `7zr.exe` |

### 构建工具与功能参考

| 项目 | 用途 |
| --- | --- |
| [Node.js](https://github.com/nodejs/node) | 前端依赖安装与构建脚本运行 |
| [Rust / Cargo](https://github.com/rust-lang/rust) | Tauri 原生程序编译 |
| [.NET](https://github.com/dotnet/runtime) | Unity 资源工具运行时；发布时随工具提供运行所需文件 |
| [CMake](https://github.com/Kitware/CMake) | C++ 后端构建配置 |
| [ONNX](https://github.com/onnx/onnx) / [NumPy](https://github.com/numpy/numpy) | 构建时转换 WtP 模型，运行软件不依赖 Python |
| [LinguaGacha](https://github.com/neavo/LinguaGacha) | 批量翻译、术语表和质量检查的功能参考，以及 `ManualTransFile.json` 格式兼容；不作为运行依赖安装 |

各组件、模型和字体保留各自的许可与版权归属。分发时应保留对应的 LICENSE、NOTICE 和来源信息；FFmpeg 的具体 Windows 构建信息见随工具生成的 `SOURCE.txt`，Unity 工具的来源见资源目录中的第三方说明。

在线翻译和大模型服务的 API 接入属于服务集成，不等同于使用了该服务的开源实现，因此未混入上述开源依赖列表。

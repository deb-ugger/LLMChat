# LLMChat

LLMChat 是一款面向 Windows 的本地桌面翻译与阅读工具，提供对话、文献阅读、图片文字识别、文本翻译和 Unity 游戏翻译等功能。界面使用 Tauri、React 与 TypeScript 构建，本地服务使用 C++20 实现。

## 主要功能

- 对话：连接兼容的模型 API，支持 Markdown、LaTeX 和代码内容。
- 文献翻译：阅读 PDF、EPUB，框选原文后翻译或查询词典。
- 图片识别：使用本地 PaddleOCR 模型检测文字，并在原图位置显示译文。
- 文本翻译：处理普通文本、字幕和 MTool/JSON 字符串工程。
- Unity 翻译：配置和管理 XUnity.AutoTranslator 游戏翻译环境。
- 用量统计：记录接口调用、Token 用量和估算费用。

翻译服务、模型、提示词、代理和 OCR 模式均可在设置页中按使用场景配置。API Key 只应保存在本地配置中，不应提交到版本库。

## 项目结构

- `backend/`：C++20 本地 HTTP 服务。
- `frontend/`：Tauri 2、React、TypeScript 与 Vite 桌面界面。
- `scripts/`：后端准备、构建和便携版生成脚本。
- `config.ini.example`：配置文件示例。
- `dist-portable/`：生成后的便携版目录。

后端默认监听 `127.0.0.1:17800`。

## 开发环境

- Windows 10 或 Windows 11
- Visual Studio 2022，并安装“使用 C++ 的桌面开发”组件
- CMake 3.16 或更高版本
- Node.js 18 或更高版本
- Rust stable 工具链
- Microsoft Edge WebView2 Runtime

## 安装依赖

```powershell
cd frontend
npm install
```

## 开发运行

先准备后端 sidecar：

```powershell
powershell -File scripts/prepare-sidecar.ps1
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

关闭正在运行的便携版程序，在仓库根目录打开 PowerShell，然后复制并粘贴下面整段命令。它会依次构建后端、构建 Release 桌面程序，并将最新文件更新到 `dist-portable/`：

```powershell
powershell -File scripts/prepare-sidecar.ps1
npm --prefix frontend run tauri -- build
powershell -File scripts/make-portable.ps1
```

更新过程中会保留 `dist-portable/` 中已有的配置、会话、统计数据、文本工程和 OCR 模型。

### 分步构建

构建后端并准备 sidecar：

```powershell
powershell -File scripts/prepare-sidecar.ps1
```

构建桌面程序：

```powershell
cd frontend
npm run tauri -- build
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

## 前端检查

```powershell
cd frontend
npm run build
npm test
```

## 配置说明

首次运行后在设置页配置翻译服务。不同功能可以分别选择翻译引擎、模型、源语言、目标语言和提示词。OCR 扩展模型按需下载并缓存在程序数据目录中，可在设置页查看状态或卸载。

# LLMChat

Tauri + React 前端，C++ HTTP 后端。本地前后端分离，已剔除 Qt。

## 目录

- `backend/` — C++20 HTTP 服务（cpp-httplib + nlohmann/json + WinHTTP）
- `frontend/` — Tauri 2 + Vite + React + TypeScript
- `config.ini.example` — 配置模板

后端默认监听 `127.0.0.1:17800`。

## 前置条件

- Visual Studio 2022（C++）
- CMake 3.16+
- Node.js 18+
- Rust（`rustup default stable`）
- WebView2（Windows 通常已自带）

## 构建后端

```powershell
cd backend
cmake -B build -G "Visual Studio 17 2022" -A x64
cmake --build build --config Release
```

产物：`backend/build/Release/llmchat-backend.exe`

复制为 Tauri sidecar 命名：

```powershell
New-Item -ItemType Directory -Force frontend/src-tauri/binaries | Out-Null
Copy-Item backend/build/Release/llmchat-backend.exe `
  frontend/src-tauri/binaries/llmchat-backend-x86_64-pc-windows-msvc.exe
Copy-Item config.ini.example frontend/src-tauri/binaries/config.ini
```

也可运行：`powershell -File scripts/prepare-sidecar.ps1`

## 开发运行

单独起后端：

```powershell
cd backend/build/Release
.\llmchat-backend.exe
```

前端（浏览器模式调试，连本地后端）：

```powershell
cd frontend
npm install
npm run dev
```

Tauri 桌面（会拉起 sidecar）：

```powershell
cd frontend
npm run tauri dev
```

## 打包

```powershell
powershell -File scripts/prepare-sidecar.ps1
cd frontend
# 需设置本地 target，避免部分环境下 cargo 落到只读缓存目录
$env:CARGO_TARGET_DIR = "$PWD\src-tauri\target"
npm run tauri -- build
```

成功后：

- 可执行文件：`frontend/src-tauri/target/release/llmchat.exe`（同目录含 `llmchat-backend.exe` sidecar）
- 便携目录：`powershell -File scripts/make-portable.ps1` → `dist-portable/`

如需 NSIS/MSI 安装包，将 `frontend/src-tauri/tauri.conf.json` 中 `bundle.targets` 设为 `["nsis"]` 或 `["msi"]` 后重新 `npm run tauri -- build`（需能访问 GitHub 下载打包工具）。

开发时若只想测前端，可先手动启动后端：

```powershell
cd backend\build\Release
.\llmchat-backend.exe
cd ..\..\..\frontend
npm run dev
```

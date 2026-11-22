# T065 · 窄 H1 验收

- 基线提交 `5a7c52ff52108e0906912551c4a62e3b5564a671`（5a7c52f）。
- 候选源码树 `05325121a284a986038f5faf127e8450e29402c6`。树中包含已编译的候选四个生产文件和测试代码。报告自身未纳入树哈希，最终提交可用 `git log -1 -- backend/tests/http/H1-report.md` 定位。
- 双版分别用独立 MSVC x64 CMake Release 目录构建。配置退出码均为 **0**，编译退出码均为 **0**。
- 回归结果 **139/139 通过**，103/103 业务模式有请求证据。临时服务均使用独立数据目录、互不相同的回环端口及 fixture 副本，均等 HTTP 健康响应后开始请求。

## 七项验收

| 项 | 对照结果 |
|---|---|
| 1 · 注册表 | 103 条业务模式与 1 条通配 OPTIONS，顺序、方法、路径表达式、handler kind 和 matcher 均无差异。源码中的实际注册循环为 game-text 4 项、game-images 13 项、game-mosaic 5 项。Unity endpoints 13 项是单个 GET 的返回目录，另行比对。 |
| 2 · 构建与启动 | 两份独立 Release 后端分别在回环端口 4187 与 4188 就绪。目录和编译命令见下方。 |
| 3 · 逐模式快照 | 103 条均命中相应注册。100 条进入业务 handler，3 条使用确定的 CORS 拒绝，且对照未注册路径仍返回 404。状态码、逐项响应头、完整 JSON、原始错误体、二进制摘要和文件副作用均一致。实际写入路径见各用例，包含导出文件和图片工程。 |
| 4 · 分发／CORS | health 的 GET/HEAD 均 200，HEAD 无体；DELETE 与未知路径均 404。12 种来源上下文各走 GET 和 OPTIONS，共 24 项，通过。settings 的重复头保留为 application/json + application/json; charset=utf-8。 |
| 5 · 协议 | 缺路径的 Unity NDJSON 两版原始字节相同；成功扫描只替换隔离根后逐字节一致。PNG 为 68 B，SHA-256 `6ee689b99722065a75fafda42552fe2678df723b5de041c6c83165ae727e90b9`。缺 text 的 Unity 请求为纯文本 400，原文 `text required`。 |
| 6 · 端口占用 | PowerShell TcpListener 以独占模式持有临时回环端口。候选退出码 1，stderr 含原始 Failed to bind 提示。释放端口后同一配置重新启动，health 200。 |
| 7 · 对照报告 | 滚动记录见下方逐用例表。原始快照与副作用哈希保留在临时目录中的 results.json；可用下方命令从零复跑。 |

## 归一化与样本边界

- 只替换临时根、两侧服务端口、由数据根产生的 tasks-数字目录 ID 及时间值（Date 和 compare-http.mjs 明列的 JSON 时间字段）。未使用通配的 UUID 或字符串过滤。响应头名称、顺序、重复项和其他值直接比对。先校验真实 Content-Length，再按替换后的长度比对。
- JSON 比较全部字段和值。出错响应额外比较原始错误体，仅应用前述字符串替换。NDJSON 不重新序列化。二进制保留字节数和 SHA-256。逐请求遍历各自数据和 fixture 目录，比对新增、删除、修改和内容摘要。
- POST conversations 为避免生成新的会话 ID，POST OCR 下载为避免外部网络，DELETE usage 为避免 SQLite 进程共享内存噪声，使用陌生来源在已匹配的包装器中拒绝。另用同一陌生来源请求未注册路径确认它们仍返回 404。正常 GET conversations 由固定会话种子走完整处理。
- 安装、启动及打开目录使用确定的拒绝输入，避免真实启动、下载或文件操作。测试没有覆盖这些业务的成功分支。成功导出和图片扫描均只写入隔离副本。

## 复现命令

在 dsh/visual 工作树根运行。两次构建使用独立目录和仓库全局构建锁，禁止指向原便携版程序。

```powershell
$scratch = Join-Path ([IO.Path]::GetTempPath()) ('LLMChat-H1-rerun-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $scratch | Out-Null
git archive --format=zip "--output=$scratch/baseline.zip" 5a7c52ff52108e0906912551c4a62e3b5564a671 backend
Expand-Archive -LiteralPath "$scratch/baseline.zip" -DestinationPath "$scratch/baseline-source"
node backend/tests/http/route-baseline.mjs check "$scratch/baseline-source/backend" backend/tests/http/routes-baseline.json
node backend/tests/http/route-baseline.mjs check
& .\scripts\file-lock.ps1 acquire -Global -Owner h1-review-build -WaitSeconds 120
if ($LASTEXITCODE -ne 0) { throw "Build lock failed" }
try {
  cmake -S "$scratch/baseline-source/backend" -B "$scratch/baseline-build" -A x64
  if ($LASTEXITCODE -ne 0) { throw "Baseline configure failed" }
  cmake --build "$scratch/baseline-build" --config Release --target llmchat-backend
  if ($LASTEXITCODE -ne 0) { throw "Baseline build failed" }
  cmake -S backend -B "$scratch/candidate-build" -A x64
  if ($LASTEXITCODE -ne 0) { throw "Candidate configure failed" }
  cmake --build "$scratch/candidate-build" --config Release --target llmchat-backend
  if ($LASTEXITCODE -ne 0) { throw "Candidate build failed" }
} finally { & .\scripts\file-lock.ps1 release -Global -Owner h1-review-build }
node backend/tests/http/compare-http.mjs "$scratch/baseline-build/Release/llmchat-backend.exe" "$scratch/candidate-build/Release/llmchat-backend.exe" "$scratch/probes"
```

失败时按同一命令换一个未使用的输出目录重跑。脚本打印差异的用例名并退出 1，结果 JSON 中同名项包含实际失败断言。此次运行的原始快照在 `C:\Users\huangyuhang\AppData\Local\Temp\LLMChat-T065-a23a954ff31e49758e266bc4678826c0\trial-2\results.json`，fixture 副本在 `C:\Users\huangyuhang\AppData\Local\Temp\LLMChat-T065-a23a954ff31e49758e266bc4678826c0\trial-2\base` 和 `C:\Users\huangyuhang\AppData\Local\Temp\LLMChat-T065-a23a954ff31e49758e266bc4678826c0\trial-2\next`。独立构建根为 `C:/Users/huangyuhang/AppData/Local/Temp/LLMChat-T065-a23a954ff31e49758e266bc4678826c0`。

## 逐用例结果

| # | 用例 | HTTP / 进程 | 重复响应头 | 文件副作用 | 判定 |
|---:|---|---|---|---|---|
| 1 | GET /api/storage | 200 | Content-Type × 2 | — | 通过 |
| 2 | PUT /api/storage/paths | 400 | Content-Type × 2 | — | 通过 |
| 3 | PUT /api/storage/cleanup | 400 | Content-Type × 2 | — | 通过 |
| 4 | GET /api/usage/events | 200 | Content-Type × 2 | — | 通过 |
| 5 | GET /api/usage/summary | 200 | Content-Type × 2 | — | 通过 |
| 6 | GET /api/usage/report | 400 | Content-Type × 2 | — | 通过 |
| 7 | DELETE /api/usage | 403 | — | — | 通过 |
| 8 | GET /api/pricing | 200 | — | — | 通过 |
| 9 | PUT /api/pricing | 400 | Content-Type × 2 | — | 通过 |
| 10 | GET /api/health | 200 | — | — | 通过 |
| 11 | GET /api/ocr/models | 200 | Content-Type × 2 | — | 通过 |
| 12 | POST /api/ocr/models/(fast\|precise\|english\|manga) | 403 | — | — | 通过 |
| 13 | DELETE /api/ocr/models/(precise\|english\|manga) | 200 | Content-Type × 2 | — | 通过 |
| 14 | GET /api/runtime-assets/(.+) | 404 | Content-Type × 2 | — | 通过 |
| 15 | GET /api/ocr/model-files/(.+) | 404 | Content-Type × 2 | — | 通过 |
| 16 | GET /api/settings | 200 | Content-Type × 2 | — | 通过 |
| 17 | PUT /api/settings | 400 | Content-Type × 2 | — | 通过 |
| 18 | GET /api/text-projects | 200 | Content-Type × 2 | — | 通过 |
| 19 | GET /api/text-projects/load | 400 | Content-Type × 2 | — | 通过 |
| 20 | POST /api/text-projects/save | 400 | Content-Type × 2 | — | 通过 |
| 21 | POST /api/reveal-path | 400 | Content-Type × 2 | — | 通过 |
| 22 | POST /api/open-path | 400 | Content-Type × 2 | — | 通过 |
| 23 | POST /api/text-projects/write-file | 400 | Content-Type × 2 | — | 通过 |
| 24 | POST /api/export-file | 200 | Content-Type × 2 | exports/fixture.txt created | 通过 |
| 25 | GET /api/conversations | 200 | Content-Type × 2 | — | 通过 |
| 26 | POST /api/conversations | 403 | — | — | 通过 |
| 27 | GET /api/conversations/([^/]+) | 404 | Content-Type × 2 | — | 通过 |
| 28 | DELETE /api/conversations/([^/]+) | 400 | Content-Type × 2 | — | 通过 |
| 29 | PUT /api/conversations/([^/]+) | 400 | Content-Type × 2 | — | 通过 |
| 30 | POST /api/conversations/([^/]+)/messages | 400 | Content-Type × 2 | — | 通过 |
| 31 | POST /api/chat | 400 | Content-Type × 2 | — | 通过 |
| 32 | GET /api/dictionary | 502 | Content-Type × 2 | — | 通过 |
| 33 | GET /api/llm/ollama/directories | 200 | Content-Type × 2 | — | 通过 |
| 34 | GET /api/llm/ollama/models | 502 | Content-Type × 2 | — | 通过 |
| 35 | GET /api/llm/vendor-models | 200 | — | — | 通过 |
| 36 | PUT /api/llm/vendor-models/([^/]+) | 400 | Content-Type × 2 | — | 通过 |
| 37 | POST /api/llm/vendor-models/([^/]+)/refresh | 400 | Content-Type × 2 | — | 通过 |
| 38 | POST /api/translate/cancel | 400 | Content-Type × 2 | — | 通过 |
| 39 | POST /api/llm/ollama/test | 400 | Content-Type × 2 | — | 通过 |
| 40 | POST /api/speech/process | 400 | Content-Type × 2 | — | 通过 |
| 41 | POST /api/(game-images\|game-text)/model | 400 | Content-Type × 2 | — | 通过 |
| 42 | POST /api/translate | 400 | Content-Type × 2 | — | 通过 |
| 43 | POST /api/text-requests | 400 | Content-Type × 2 | — | 通过 |
| 44 | GET /api/text-requests | 404 | Content-Type × 2 | — | 通过 |
| 45 | DELETE /api/text-requests | 200 | Content-Type × 2 | — | 通过 |
| 46 | POST /api/text-projects/run | 400 | Content-Type × 2 | — | 通过 |
| 47 | POST /api/text-projects/checkpoint | 400 | Content-Type × 2 | — | 通过 |
| 48 | DELETE /api/text-projects/run | 200 | Content-Type × 2 | — | 通过 |
| 49 | POST /api/game-text/load | 400 | Content-Type × 2 | — | 通过 |
| 50 | POST /api/game-text/save | 400 | Content-Type × 2 | — | 通过 |
| 51 | POST /api/game-text/workflow | 400 | Content-Type × 2 | — | 通过 |
| 52 | POST /api/game-text/checkpoint | 400 | Content-Type × 2 | — | 通过 |
| 53 | POST /api/json-embedding/start | 400 | Content-Type × 2 | — | 通过 |
| 54 | POST /api/game-images/info | 400 | Content-Type × 2 | — | 通过 |
| 55 | POST /api/game-images/load | 400 | Content-Type × 2 | — | 通过 |
| 56 | POST /api/game-images/scan | 200 | Content-Type × 2 | fixtures/rpg/LLMChat-JSON/ created, fixtures/rpg/LLMChat-JSON/images/ created, fixtures/rpg/LLMChat-JSON/images/project.json created | 通过 |
| 57 | POST /api/game-images/save | 400 | Content-Type × 2 | — | 通过 |
| 58 | POST /api/game-images/save-many | 400 | Content-Type × 2 | — | 通过 |
| 59 | POST /api/game-images/apply | 400 | Content-Type × 2 | — | 通过 |
| 60 | POST /api/game-images/uninstall | 400 | Content-Type × 2 | — | 通过 |
| 61 | POST /api/game-images/stop-read | 400 | Content-Type × 2 | — | 通过 |
| 62 | POST /api/game-images/current-sources | 400 | Content-Type × 2 | — | 通过 |
| 63 | POST /api/game-images/mosaic-status | 400 | Content-Type × 2 | — | 通过 |
| 64 | POST /api/game-images/mosaic-prepare | 400 | Content-Type × 2 | — | 通过 |
| 65 | POST /api/game-images/mosaic-apply | 400 | Content-Type × 2 | — | 通过 |
| 66 | POST /api/game-images/mosaic-uninstall | 400 | Content-Type × 2 | — | 通过 |
| 67 | POST /api/game-images/load-stream | 400 | Content-Type × 2 | — | 通过 |
| 68 | POST /api/game-images/scan-stream | 400 | Content-Type × 2 | — | 通过 |
| 69 | GET /api/game-images/preview | 200 | — | — | 通过 |
| 70 | GET /api/game-images/mosaic | 400 | Content-Type × 2 | — | 通过 |
| 71 | POST /api/game-images/mosaic | 500 | — | — | 通过 |
| 72 | POST /api/game-images/render | 400 | Content-Type × 2 | — | 通过 |
| 73 | POST /api/json-embedding/detect-patch | 400 | Content-Type × 2 | — | 通过 |
| 74 | POST /api/game-mosaic/status | 400 | Content-Type × 2 | — | 通过 |
| 75 | POST /api/game-mosaic/preview | 400 | Content-Type × 2 | — | 通过 |
| 76 | POST /api/game-mosaic/install | 400 | Content-Type × 2 | — | 通过 |
| 77 | POST /api/game-mosaic/rule | 400 | Content-Type × 2 | — | 通过 |
| 78 | POST /api/game-mosaic/uninstall | 400 | Content-Type × 2 | — | 通过 |
| 79 | POST /api/json-embedding/launch | 400 | Content-Type × 2 | — | 通过 |
| 80 | GET /api/json-embedding/patch | 200 | Content-Type × 2 | — | 通过 |
| 81 | GET /api/json-embedding/status | 200 | Content-Type × 2 | — | 通过 |
| 82 | POST /api/json-embedding/detect | 400 | Content-Type × 2 | — | 通过 |
| 83 | GET /api/json-embedding/backups | 200 | Content-Type × 2 | — | 通过 |
| 84 | POST /api/json-embedding/stop | 200 | Content-Type × 2 | — | 通过 |
| 85 | GET /api/unity/endpoints | 200 | Content-Type × 2 | — | 通过 |
| 86 | GET /api/unity/llm-translate | 400 | — | — | 通过 |
| 87 | GET /api/unity/install-task | 400 | Content-Type × 2 | — | 通过 |
| 88 | DELETE /api/unity/install-task | 400 | Content-Type × 2 | — | 通过 |
| 89 | GET /api/unity/config | 200 | Content-Type × 2 | — | 通过 |
| 90 | POST /api/unity/config | 400 | Content-Type × 2 | — | 通过 |
| 91 | POST /api/unity/pick-path | 400 | Content-Type × 2 | — | 通过 |
| 92 | POST /api/unity/detect | 200 | Content-Type × 2 | — | 通过 |
| 93 | POST /api/unity/detect-stream | 200 | — | — | 通过 |
| 94 | POST /api/unity/launch | 400 | Content-Type × 2 | — | 通过 |
| 95 | POST /api/unity/launch-patch | 400 | Content-Type × 2 | — | 通过 |
| 96 | POST /api/unity/self-check | 400 | Content-Type × 2 | — | 通过 |
| 97 | POST /api/(?:unity/)?output-log | 400 | Content-Type × 2 | — | 通过 |
| 98 | GET /api/(?:unity/)?output-log | 200 | Content-Type × 2 | — | 通过 |
| 99 | POST /api/unity/install | 400 | Content-Type × 2 | — | 通过 |
| 100 | POST /api/unity/fix-font | 400 | Content-Type × 2 | — | 通过 |
| 101 | POST /api/unity/uninstall | 400 | Content-Type × 2 | — | 通过 |
| 102 | POST /api/unity/install-loader | 400 | Content-Type × 2 | — | 通过 |
| 103 | POST /api/unity/uninstall-loader | 400 | Content-Type × 2 | — | 通过 |
| 104 | dispatch GET /api/health | 200 | — | — | 通过 |
| 105 | dispatch GET /api/settings | 200 | Content-Type × 2 | — | 通过 |
| 106 | dispatch HEAD /api/health | 200 | — | — | 通过 |
| 107 | dispatch DELETE /api/health | 404 | — | — | 通过 |
| 108 | dispatch GET /api/__h1_unregistered | 404 | — | — | 通过 |
| 109 | dispatch POST /api/__h1_unregistered | 404 | — | — | 通过 |
| 110 | dispatch PUT /api/__h1_unregistered | 404 | — | — | 通过 |
| 111 | dispatch DELETE /api/__h1_unregistered | 404 | — | — | 通过 |
| 112 | unregistered hostile POST | 404 | — | — | 通过 |
| 113 | unregistered hostile DELETE | 404 | — | — | 通过 |
| 114 | cors OPTIONS http://localhost:1420 | 204 | — | — | 通过 |
| 115 | cors GET http://localhost:1420 | 200 | — | — | 通过 |
| 116 | cors OPTIONS http://127.0.0.1:1420 | 204 | — | — | 通过 |
| 117 | cors GET http://127.0.0.1:1420 | 200 | — | — | 通过 |
| 118 | cors OPTIONS http://tauri.localhost | 204 | — | — | 通过 |
| 119 | cors GET http://tauri.localhost | 200 | — | — | 通过 |
| 120 | cors OPTIONS https://tauri.localhost | 204 | — | — | 通过 |
| 121 | cors GET https://tauri.localhost | 200 | — | — | 通过 |
| 122 | cors OPTIONS tauri://localhost | 204 | — | — | 通过 |
| 123 | cors GET tauri://localhost | 200 | — | — | 通过 |
| 124 | cors OPTIONS https://foreign.invalid | 403 | — | — | 通过 |
| 125 | cors GET https://foreign.invalid | 403 | — | — | 通过 |
| 126 | cors OPTIONS null | 403 | — | — | 通过 |
| 127 | cors GET null | 403 | — | — | 通过 |
| 128 | cors OPTIONS no Origin / absent | 204 | — | — | 通过 |
| 129 | cors GET no Origin / absent | 200 | — | — | 通过 |
| 130 | cors OPTIONS no Origin / same-origin | 204 | — | — | 通过 |
| 131 | cors GET no Origin / same-origin | 200 | — | — | 通过 |
| 132 | cors OPTIONS no Origin / same-site | 204 | — | — | 通过 |
| 133 | cors GET no Origin / same-site | 200 | — | — | 通过 |
| 134 | cors OPTIONS no Origin / cross-site | 403 | — | — | 通过 |
| 135 | cors GET no Origin / cross-site | 403 | — | — | 通过 |
| 136 | cors OPTIONS no Origin / none | 403 | — | — | 通过 |
| 137 | cors GET no Origin / none | 403 | — | — | 通过 |
| 138 | successful NDJSON scan | 200 | — | — | 通过 |
| 139 | occupied port and restart | 退出 1；重启健康 | — | — | 通过 |

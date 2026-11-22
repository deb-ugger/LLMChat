# HTTP 回归基线

在 Windows 上用 Node.js 20.3 或更高版本运行。先准备两份独立构建的 x64 Release 后端，基线用已认可的提交，候选用待检查的提交。入口只运行回归，不编译后端。

```powershell
node backend/tests/http/run.mjs --baseline 'C:\build\baseline\llmchat-backend.exe' --candidate 'C:\build\candidate\llmchat-backend.exe'
```

| 参数 | 环境变量 | 默认值 |
| --- | --- | --- |
| --baseline | LLMCHAT_HTTP_BASELINE_EXE | 必填 |
| --candidate | LLMCHAT_HTTP_CANDIDATE_EXE | 必填 |
| --baseline-port | LLMCHAT_HTTP_BASELINE_PORT | 17801 |
| --candidate-port | LLMCHAT_HTTP_CANDIDATE_PORT | 17802 |
| --data-root | LLMCHAT_HTTP_DATA_ROOT | 系统临时目录 |

命令行参数优先。两个端口必须不同，且均不能为 17800。每次运行在指定的父目录下创建一个新的临时子目录，分别给基线和候选生成数据与最小游戏夹具。占用端口的测试使用候选端口，在候选启动前先释放。并行运行时为每次运行指定不同的端口。

当前清单覆盖 103 条业务模式，共 139 项检查。输出包含 PASS/FAIL、耗时、失败项及结果文件位置。results.json 保留逐项响应快照和失败详情，目录可用于排查和复跑。通过时退出 0，差异或启动失败时退出 1，Ctrl+C 时退出 130。启动失败、一侧运行中退出或 Ctrl+C 时，入口会停止并等待自己启动的进程退出。

## 核对和更新注册清单

```powershell
node backend/tests/http/route-baseline.mjs check
```

只有 HTTP 注册表确实发生变更时才刷新 routes-baseline.json，例如新增、删除或调整了方法、匹配模式、注册顺序或处理器类型。源文件拆分或响应文案变化本身不需要刷新清单。提交信息写清注册表变更原因。

```powershell
node backend/tests/http/route-baseline.mjs write
git diff -- backend/tests/http/routes-baseline.json
node backend/tests/http/route-baseline.mjs check
```

核对清单的逐条差异。新模式若不能直接作为 URL 请求，请在 compare-http.mjs 补上对应的具体样本；若新路径有外部调用或写入，使用隔离夹具或可区分命中路由的拒绝样本。复跑时选择支持新注册清单的已认可后端作为对照，旧版本缺少新路由时应预期出现差异。历史基线口径及归一化细节见 [H1 验收报告](H1-report.md)。

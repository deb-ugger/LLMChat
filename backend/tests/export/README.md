# 只读成品导出验收

从工作树根目录运行以下命令。测试程序要求一个尚不存在的绝对 fixture 目录，并只在该目录创建临时游戏和导出包。

```powershell
$scratch = Join-Path $env:TEMP ("llmchat-t071-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $scratch | Out-Null

cmake -S backend/tests/export -B "$scratch/tests" -A x64
cmake --build "$scratch/tests" --config Release --target game-image-export-tests
& "$scratch/tests/Release/game-image-export-tests.exe" "$scratch/fixtures"

cmake -S backend -B "$scratch/backend" -A x64
cmake --build "$scratch/backend" --config Release --target llmchat-backend
```

## 结果与断言

| 验收项 | 定向用例 |
| --- | --- |
| A | MV 的 `.rpgmvp` 和 MZ 的 `.png_` 使用独立 XOR 解码，WOLF 使用散装 PNG。逐像素比较文字覆盖、去码底图、透明像素及译图、去码单层分支。独立用 CryptoAPI 重算每个原件、成品、manifest SHA-256 和游戏根指纹。 |
| B | 生成时持有所有游戏文件的只读共享句柄，并用 `GENERIC_WRITE` 打开每个文件，断言被拒。对比生成前后的文件与目录相对名、类型和 Windows 属性、文件 ID、卷序列号、硬链接数、创建/修改时间，以及所有文件的长度与 SHA-256。Windows 可延迟更新最后访问时间，因此该字段未用于对比。MZ 冷启动用例带 SQLite WAL，WOLF 冷启动用例带旧单图 JSON，另测同一个已加载的项目实例。 |
| C | 第二项写入前在暂存的目标文件位置放置目录，预期 `OUTPUT_WRITE_FAILED`。在发布进度回调置取消，预期 `CANCELLED`。预建正式同名目录，预期 `OUTPUT_EXISTS` 且已有文件不变。三例均检查没有本次发布目录或暂存，另核对有所有权标记的废弃暂存会被清理。 |
| D | 逐项检查绝对路径、盘符、盘符相对路径、UNC、ADS、反斜杠、点和父段、空段、换行和内嵌 NUL、非法字符、设备名（含上标数字）、尾空格和点、超出图片根、扩展名、大小写别名、硬链接、游戏中间目录及输出根的 junction。每例断言 `INVALID_PATH` 和可读错误。 |
| E | 给 WOLF fixture 加入同名封包覆盖和带 `archive` 字段的行，分别断言 `WOLF_ARCHIVE_ENTRY_UNSUPPORTED` 且输出为空。 |

同尺寸同时间戳候选被替换时返回 `INPUT_STALE`，缺少确认快照时返回 `CONFIRMATION_REQUIRED`。同根重入需返回 `BUSY`。

Windows x64 Release 关键输出（省略临时绝对路径）。

```text
PASS A/B: rpg-maker-mv pixels, manifest, fixture tree and read-only handles
PASS A/B: rpg-maker-mz pixels, manifest, fixture tree and read-only handles
PASS A/B: wolf pixels, manifest, fixture tree and read-only handles
PASS C second payload write: OUTPUT_WRITE_FAILED
PASS C cancel before publish: CANCELLED
PASS C target collision: OUTPUT_EXISTS
PASS D Windows case alias: INVALID_PATH
PASS D hard link: INVALID_PATH
PASS D reparse junction within target path: INVALID_PATH
PASS D reparse output root: INVALID_PATH
PASS E WOLF archive overlay: WOLF_ARCHIVE_ENTRY_UNSUPPORTED
PASS E archive-backed row: WOLF_ARCHIVE_ENTRY_UNSUPPORTED
PASS confirmation SHA with same size and timestamp: INPUT_STALE
PASS missing mosaic confirmation: CONFIRMATION_REQUIRED
PASS game image export fixtures
```

例如 WOLF 合成图 `Data/Picture/image1.png` 的 SHA-256 为 `e177cb63ef9d5c73e50f8a37af5e76ca4edb7816b2f5c9374840135fb23c2338`。像素值和文件哈希均由测试程序现场复算。

这批提供生成模块入口和直接调用它的测试。HTTP 接线、其他写入入口使用跨进程目录锁，以及确认快照的产品写入路径属于后续批次。测试未使用真实游戏、只读挂载、UNC 共享或 Windows 的区分大小写目录。

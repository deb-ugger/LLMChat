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

生成模块提供库入口和直接调用它的测试。HTTP 接线、其他写入入口使用跨进程目录锁，以及确认快照的产品写入路径属于后续批次。测试未使用真实游戏、只读挂载、UNC 共享或 Windows 的区分大小写目录。

## T072 应用、恢复与清理

同一测试程序也运行应用和恢复，复用上面的构建及运行命令。成品包保留 `receipts/backup/<目标相对路径>`、原件校验计划和最后发布的 `receipts/receipt.json`。应用中断且收据尚未发布时，`recover` 校验备份并还原已替换的目标。恢复中断时按恢复标记续做。

- A/B/E 对 MV 加密、MZ 加密、WOLF 散装分别应用和恢复。全树相对路径和 SHA-256 对比包含所有非目标文件。重复应用返回 `ALREADY_APPLIED`，缺备份返回 `BACKUP_MISSING`，恢复两次结果一致。
- C 改版本、基准 SHA-256、payload SHA-256、增删清单条目，以及直接修改游戏目标，验证分别报错且游戏树不变。
- D 在第二次替换前、全部替换后及收据写入处注入故障。收据目录用 NTFS ACL 拒绝新建文件。另一个子进程在写完收据暂存、发布前通过 `ExitProcess` 退出，再从父进程调用 `recover`。原始 SHA-256 恢复，包内收据暂存及注入的游戏目录暂存均被清理。另构造恢复中断的混合状态，验证能续做至原始哈希。
- F/G 逐项拒绝父路径、绝对路径、盘符、ADS、设备名、大小写别名、硬链接、junction 和 WOLF 封包覆盖。对游戏目标目录设置拒绝新建文件的 ACL，应用在预检返回 `PERMISSION_DENIED`。
- 清理测试验证活动包拒绝删除，已恢复包可删除，包外的相邻文件及 junction 指向的目录保持原样。

## T076 确认快照

同一测试程序用上述命令运行确认快照验收。库在内存返回快照 JSON，时间由服务端生成，项目目录全程只读。

- A 对 MV 加密、MZ 加密、WOLF 散装分别核对真实源路径、源版本、解码尺寸、图层框、候选版本和 SHA-256，同一批选图的指纹与成品 manifest 一致。
- B 同一输入连跑三次，再打乱图片及图层顺序。在对比中对齐服务端生成的时间字段，逐字节核对其余内容。
- C 独立断言七个指定错误码，并额外检查路径穿越、空框、候选哈希变动、WOLF 封包覆盖及封包来源。每个错误都对比全树路径与 SHA-256，输出目录保持为空。
- D 创建快照后改动一字节并恢复原修改时间。保持旧项目版本戳不变，仍用内容指纹检出 `SOURCE_CHANGED`。

## T080 绑定确认记录

原有命令也运行确认记录篡改探针。合法范围内的坐标变更、替换框编号或角色、修改已落盘的确认记录，以及在时间字段放路径均被拒绝。带 `debugPath` 的额外数据按白名单剥离。夹具还在发布回调更换确认记录，验证清单仍使用已通过校验的记录。

确认范围包含内容相同而跳过的图。写入范围只含 payload 中的文件，应用与恢复沿用写入范围指纹。

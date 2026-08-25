# LLMChat 多对话文件锁（必须遵守）

本仓库可能被多个 Cursor/Codex 对话同时修改。所有自动化代理在写文件前必须使用 `scripts/file-lock.ps1`，不得依赖“我只改不同代码段”来规避锁。

## 每次修改的强制流程

1. 为当前对话选择一个稳定且唯一的所有者名称，例如 `cursor-pricing-742` 或 `codex-stats-20260823`。同一对话后续申请和释放都使用同一个名称。
2. 先执行 `git status --short`，确认并保留其他对话或用户已有的改动。
3. 修改前一次性申请计划写入的全部文件，并等待最多 60 秒：

   ```powershell
   & .\scripts\file-lock.ps1 acquire `
     -Owner "cursor-pricing-742" `
     -Paths @("frontend/src/components/PricingPanel.tsx", "frontend/src/styles.css") `
     -WaitSeconds 60
   ```

4. 如果申请失败，停止修改这些文件；报告占用者，等待其释放或改做不冲突的工作。不得使用 `-Force` 抢锁。
   - **禁止持锁等待**：等待任何文件锁、全局锁或其他会话完成前，必须先正常释放当前 owner 持有的全部锁。不得一边持有 A 锁，一边等待 B 锁或另一个会话。
   - **禁止锁升级**：持有文件锁时不得申请全局锁。需要构建时，先完成源码修改和检查，释放全部文件锁，再单独申请全局锁。
   - **禁止逐步扩锁**：文件锁必须一次性申请完整集合。发现漏项时，先释放原集合，再一次性申请包含新增文件的完整集合。
   - 等待锁时不得直接结束任务或要求用户稍后再次提醒。应启动一个静默等待命令，由脚本在后台定期检查并在锁释放后继续申请；中间不要每分钟唤醒模型或输出重复状态，以减少 Codex 用量。
   - 只有等待命令本身失败、锁过期仍未清理，诊断发现持锁等待/循环等待，或用户明确取消时，才停止并报告阻塞。
5. 取得锁后重新读取目标文件，再进行最小范围修改。不得用取得锁之前缓存的旧内容覆盖文件。
6. 验证并检查 `git diff` 后释放自己持有的锁：

   ```powershell
   & .\scripts\file-lock.ps1 release `
     -Owner "cursor-pricing-742" `
     -Paths @("frontend/src/components/PricingPanel.tsx", "frontend/src/styles.css")
   ```

7. 对话中断、失败或用户取消时，也必须在结束前释放已经取得的锁。长任务应使用 `renew` 续期。

## 构建与便携版全局锁

后端、前端、Tauri 和 `dist-portable` 构建只能由一个对话执行。构建前申请全局锁；全局锁存在时，其他对话不得修改任何源码或开始构建：

申请全局锁前必须已经释放本 owner 的全部文件锁。脚本会拒绝文件锁到全局锁的升级，避免两个会话互相等待。

```powershell
& .\scripts\file-lock.ps1 acquire -Global `
  -Owner "cursor-pricing-742" -WaitSeconds 120

# prepare-sidecar / tauri build / make-portable

& .\scripts\file-lock.ps1 release -Global `
  -Owner "cursor-pricing-742"
```

## 查询与异常处理

```powershell
# 查看全部活动锁
& .\scripts\file-lock.ps1 list

# 查看锁等待关系并检测持锁等待、循环等待；发现风险时退出码为 3
& .\scripts\file-lock.ps1 diagnose

# 查看指定文件
& .\scripts\file-lock.ps1 status `
  -Paths @("frontend/src/api.ts")

# 只清理已经超过租期的锁，以及进程已经结束的失效等待记录
& .\scripts\file-lock.ps1 cleanup
```

- 默认租期为 240 分钟。过期锁会自动清理。
- `list` 同时显示已经取得的锁和正在等待的申请；不能再仅凭“已持有的文件不重叠”判断没有死锁。
- 发生等待时先运行 `diagnose`。正常处理顺序是：通知等待环中的 owner 停止修改 → 各 owner 执行 `& .\scripts\file-lock.ps1 release-all -Owner "<owner>"` 正常释放自己的全部锁 → 按“文件修改、释放文件锁、申请全局锁、构建、释放全局锁”的顺序恢复。
- `-Force` 仅限用户明确确认原所有者已经停止后使用。
- 文件锁是协作协议，不能阻止不遵守规则的外部编辑器直接写盘；因此仍应按功能及时进行本地 Git 提交。

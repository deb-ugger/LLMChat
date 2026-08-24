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

# 查看指定文件
& .\scripts\file-lock.ps1 status `
  -Paths @("frontend/src/api.ts")

# 只清理已经超过租期的锁
& .\scripts\file-lock.ps1 cleanup
```

- 默认租期为 240 分钟。过期锁会自动清理。
- `-Force` 仅限用户明确确认原所有者已经停止后使用。
- 文件锁是协作协议，不能阻止不遵守规则的外部编辑器直接写盘；因此仍应按功能及时进行本地 Git 提交。

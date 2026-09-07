# 存储回归测试

同一套 CMake/CTest 还包括 request-cancellation-tests：只访问其自行绑定的 127.0.0.1 随机端口，不接触真实 API 或密钥。覆盖成功收发后 HANDLE_CLOSING 完成、慢响应取消、提前取消/期限阻止发送、12 个活跃任务上限以及 Scope 释放。每个测试有 30 秒 CTest 超时。
这是独立 C++ 可执行测试，只操作其自行创建的系统临时目录，不访问真实用户数据库，不启动 LLMChat。

在仓库全局构建锁下执行：

```powershell
cmake -S backend/tests/storage -B backend/build/storage-tests
cmake --build backend/build/storage-tests --config Release
ctest --test-dir backend/build/storage-tests -C Release --output-on-failure
```

覆盖：

- 1,605 条事件的排序及时间戳并列、筛选计数、后页、空结果；
- 带谓词分页对每个候选仅执行一次，谓词异常不被静默吞掉；
- UsageStore 传递过滤与总数；
- 旧会话只读事务迁移，列表无正文，逐条追加和改名、删除级联、重启后状态；
- 注入元信息更新失败时，消息插入与计数一起回滚，缓存不接受失败结果；
- 迁移到一半失败不留下部分会话或完成标记，修正原文件后可重新迁移。

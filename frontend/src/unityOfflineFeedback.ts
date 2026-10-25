export type UnityFailure = { reason: string; action: string; technical: string };
export function explainUnityFailure(error: unknown): UnityFailure {
  const technical = error instanceof Error ? error.message : String(error);
  const result = (reason: string, action: string) => ({ reason, action, technical });
  if (/not allowed by ACL|permission .*not found|command .*not allowed/i.test(technical))
    return result("软件的桌面权限配置拦截了 Unity 处理命令，操作未能启动。这不是游戏资源损坏，也与翻译引擎无关。", "更新并重启软件后重试；若仍出现，请反馈下方技术详情，无需更换引擎或以管理员身份运行。");
  if (/缺少嵌字组件|无法启动嵌字组件|0xc0000135/i.test(technical))
    return result("Unity 资源处理组件缺失或无法启动，尚未开始处理游戏资源。", "使用完整便携版更新程序及 resources/unity 目录，再重新启动软件。");
  if (/工程读取失败|检查点不属于|恢复检查点失败|工程版本|工程无效|could not find|cannot find|找不到|不存在|ENOENT/i.test(technical))
    return result("保存工程或所需文件无法读取，可能已被移动、删除或格式不受支持。已有文件不会被自动删除。", "检查游戏和输出目录是否仍在原位置；工程移到其他位置时可通过‘更多 → 导入其他工程’重新关联。");
  if (/拒绝访问|access.*denied|UnauthorizedAccess|EACCES|being used by another process|另一个进程/i.test(technical))
    return result("系统拒绝了文件读取或写入，当前目录权限或文件占用阻止了处理。", "关闭占用文件的程序，检查游戏与输出目录权限；输出目录只读时，在 Unity 设置中选择可写目录后重试。");
  if (/disk.*full|磁盘.*满|空间不足|ENOSPC/i.test(technical))
    return result("磁盘剩余空间不足，无法保存工程或资源备份。", "释放输出盘与游戏盘空间后恢复任务，不要删除未完成工程和 original 原件备份。");
  if (/游戏仍在运行/.test(technical)) return result("游戏仍在运行，不能安全替换资源。", "正常关闭当前游戏，再点击恢复继续应用；软件不会强制结束游戏。");
  if (/已变化|发生变化|校验失败|不一致|不属于当前游戏/.test(technical))
    return result(technical, "不要强行覆盖游戏文件。确认游戏版本与工程一致；需要重新提取文本时，先结束当前流程，再重新扫描，未变化文本的译文会保留。");
  if (/HTTP\s*(401|403)|api.?key|凭证|密钥/i.test(technical)) return result("所选翻译服务的凭证未配置或未被服务接受。", "检查通用设置中对应模型或翻译引擎的凭证，再恢复翻译；已保存译文不会重复处理。");
  if (/HTTP\s*429|rate.limit/i.test(technical)) return result("翻译服务暂时限制了请求频率。", "稍后恢复翻译，或调整通用设置中的请求限制；已完成译文会保留。");
  if (/HTTP\s*5\d\d/i.test(technical)) return result("服务端处理失败，资源提取结果和已保存译文仍保留。", "稍后恢复任务；若持续失败，请检查对应服务配置并反馈技术详情，不必重复扫描资源。");
  if (/fetch|network|timeout|timed out|网络|超时/i.test(technical)) return result("翻译服务连接失败或请求超时。", "检查当前引擎、网络和代理配置后恢复；此前已完成的扫描与译文会保留。");
  if (/class.?data|type.?tree|assets file|bundle|compression|序列化|类型树/i.test(technical))
    return result("资源组件无法解析当前文件格式、压缩方式或 Unity 类型数据。", "查看扫描提示中受影响的文件；可继续检查已成功提取的文本，不要将未完整生成的补丁应用到游戏。");
  if (/[一-鿿]/.test(technical)) return result(technical, "根据提示检查后重试或恢复；若原因仍不明确，请反馈技术详情，保留工程和原件备份。");
  return result("资源处理组件返回了无法识别的错误，暂时不能确定具体原因。", "先保留当前工程并重试；若仍失败，请反馈下方技术详情，以便定位，不要重复覆盖游戏文件。");
}
export function explainUnityWarning(warning: string) {
  const boundary = warning.indexOf("：");
  const file = boundary >= 0 ? warning.slice(0, boundary) : "资源文件";
  if (/未内嵌类型树/.test(warning)) return { reason: `${file}：此资源缺少解析自定义组件所需的结构信息，暂时无法提取其中的界面文字或字体。其他可读取的资源仍会继续扫描。`, technical: warning };
  if (/Addressables/.test(warning)) return { reason: "游戏使用了额外的资源目录索引。替换资源后可能需要同步更新索引，当前不自动处理；生成补丁后仍需确认游戏能正常加载。", technical: warning };
  if (/图片文字、加密资源/.test(warning)) return { reason: warning, technical: "" };
  const detail = boundary >= 0 ? warning.slice(boundary + 1) : warning;
  if (!/[a-z]{3,}/i.test(detail)) return { reason: warning, technical: "" };
  return { reason: `${file}：未能读取这一项，已跳过。其他资源可继续处理，具体原因见技术详情。`, technical: warning };
}

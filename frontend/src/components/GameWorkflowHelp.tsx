import { useId } from "react";
import type { GameHelpSetup } from "../gameAuxWindows";

const guide = {
  chat: { label: "对话", steps: [
    ["开始对话", "用「新建对话」开始，在输入框发送消息。已有对话可从列表搜索、切换或重命名。"],
    ["连接模型", "在「设置 → 通用」配置 API、代理或本地 Ollama。连接成功后再选择用于对话的模型。"],
  ] },
  literature: { label: "文献翻译", steps: [
    ["打开文献", "打开 PDF 或 EPUB 后，通过目录或页码定位要读的内容。"],
    ["翻译与核对", "为当前文献选择语言和翻译方式，结合原文核对译文。可从最近打开列表接着阅读。"],
  ] },
  image: { label: "图片文字识别", steps: [
    ["添加图片", "打开或拖入图片，选好识别模型和原文语言。只需识别一部分时，在预览中框定范围。"],
    ["检查文字", "识别后核对文字和区域位置。需要其他语言时继续翻译，并按所选格式输出。"],
  ] },
  redraw: { label: "AI 风格重绘", steps: [
    ["准备工作流", "选择 ComfyUI 便携版目录，确认工作流和模型文件。自定义工作流使用 ComfyUI 导出的 API 格式。"],
    ["生成候选", "添加原图和所需参考图，调整文字区域或蒙版，再运行工作流。对照原图核对候选后保存。"],
  ] },
  speech: { label: "语音转文字", steps: [
    ["添加音频", "打开或拖入音频。需要分段时，在波形里选择处理范围。"],
    ["转写与导出", "按当前任务选识别模型、语言和输出格式。完成后校对文本及时间轴，再导出。"],
  ] },
  text: { label: "文本翻译工程", steps: [
    ["打开工程", "从原文创建工程，或打开已有工程。通过筛选和搜索找到要处理的条目。"],
    ["翻译与保存", "选择源语言、目标语言和翻译方式。核对已有译文、失败条目和格式标记，再保存或导出。"],
  ] },
  unity: { label: "游戏翻译", steps: [
    ["扫描资源", "选择游戏目录或程序进入工程。扫描会建立可处理资源的索引，已有结果会按原资源匹配复用。"],
    ["文本翻译", "先筛选要处理的文字，再执行翻译。保存人工修改，检查占位符、换行以及失败条目。"],
    ["图片翻译", "在支持的引擎里依次筛选、识字定位、翻译和生成译图。可调整勾选、区域、译文，或导入替换图。"],
    ["图片去码", "初筛和视觉复筛会整理候选框。在待复核分组检查框选范围，生成候选后需手动采用，结果才可用于补丁。"],
    ["生成与应用", "最后一步提供「一键生成并应用」，也可逐项生成和应用。应用前关闭游戏，在此页查看备份、冲突和卸载操作。"],
  ] },
  output: { label: "输出", steps: [
    ["查找运行信息", "从左下角打开全局输出。任务开始、停止、完成和报错会显示对应模块，方便定位失败步骤。"],
  ] },
  downloads: { label: "下载", steps: [
    ["查看资源下载", "从左下角查看模型和工具下载。资源下载完成后回到原模块选择使用。"],
  ] },
  stats: { label: "统计", steps: [
    ["查看用量", "按时间和模型查看请求及 token 使用情况。价格和费用使用设置中的计价配置。"],
  ] },
  benchmark: { label: "测试队列", steps: [
    ["游戏翻译", "先打开游戏工程，再从左下角「测试队列」选择「游戏翻译」。选择样本、配置和轮次，结果保存在测试记录。"],
    ["构建测速", "在独立目录对比 WASM 内嵌和外置时的全量及增量 Release 构建。结束后清理测试目录，结果在测速页查看。"],
  ] },
  appearance: { label: "外观", steps: [
    ["切换主题", "从左下角「外观」选择界面配色。主题立即更新并保存在本机。"],
  ] },
  settings: { label: "设置", steps: [
    ["全局连接", "在通用设置配置模型服务、代理和凭证，并用连接测试确认设置可用。"],
    ["模块设置", "切换到对应模块管理长期选项。单次运行的语言、模型或输出选项在该模块的任务页面调整。"],
  ] },
} as const;

export type HelpModule = keyof typeof guide;
export const isHelpModule = (value: string): value is HelpModule => Object.hasOwn(guide, value);

const runtimeSteps = [
  ["检测 Unity 游戏", "在游戏详情切换到「运行时翻译」，按检测结果确认运行环境和位数。"],
  ["安装翻译插件", "Mono 使用 ReiPatcher。IL2CPP 先安装 BepInEx，首次启动完成初始化后关闭游戏，再安装并配置翻译插件。"],
  ["启动与检查", "使用 LLMChat 模型端点时保持软件运行。在游戏内按 Alt+0 检查翻译插件。卸载时先卸翻译插件，再卸插件框架。"],
] as const;

type HelpSteps = readonly (readonly [string, string])[];
function GuideSections({ steps }: { steps: HelpSteps }) {
  return <>{steps.map(([label, content]) => <section key={label} className="game-workflow-help-section">
    <h3>{label}</h3><p>{content}</p>
  </section>)}</>;
}

export function ApplicationHelpPage({ section, onSection }: { section: HelpModule; onSection: (section: HelpModule) => void }) {
  return <main className="game-workflow-help app-help-view" aria-label="帮助">
    <header className="game-workflow-help-header">
      <h1>帮助</h1>
      <label>模块 <select aria-label="帮助模块" value={section} onChange={event => {
        const next = event.target.value;
        if (isHelpModule(next)) onSection(next);
      }}>
        {Object.entries(guide).map(([id, item]) => <option key={id} value={id}>{item.label}</option>)}
      </select></label>
    </header>
    <div key={section} className="game-workflow-help-content">
      <GuideSections steps={guide[section].steps} />
      {section === "unity" && <GuideSections steps={runtimeSteps} />}
    </div>
  </main>;
}

export function GameWorkflowHelpPage({ mode, supportsImages, onClose }: Omit<GameHelpSetup, "kind"> & { onClose: () => void }) {
  const titleId = useId();
  const runtime = mode === "unity-runtime";
  const steps = runtime ? runtimeSteps : guide.unity.steps.filter(([label]) => supportsImages || (label !== "图片翻译" && label !== "图片去码"));
  return <main className="game-workflow-help" aria-labelledby={titleId}>
    <header className="game-workflow-help-header">
      <h1 id={titleId}>{runtime ? "Unity 运行时翻译流程" : "游戏翻译流程"}</h1>
      <button type="button" className="unity-btn" onClick={onClose}>关闭</button>
    </header>
    <div className="game-workflow-help-content"><GuideSections steps={steps} /></div>
  </main>;
}

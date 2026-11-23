import { useId, useMemo, useState } from "react";
import type { GameHelpSetup } from "../gameAuxWindows";

/**
 * 帮助页数据。
 * 每条都按「这一步在干什么 / 输入 / 产出 / 卡点」组织，内容以组件与状态机的真实行为为准，
 * 不写界面上已有的按钮名。
 */
type HelpStep = {
  title: string;
  role: string;
  input: string;
  output: string;
  pit?: string;
  note?: string;
};

type HelpModule = {
  id: string;
  label: string;
  tagline: string;
  group: "日常" | "资源与识别" | "系统";
  steps: HelpStep[];
};

const modules: HelpModule[] = [
  {
    id: "unity", label: "游戏翻译", tagline: "把译文和图写回游戏", group: "日常",
    steps: [
      { title: "扫描资源", role: "建立可处理资源的索引",
        input: "游戏目录或程序文件",
        output: "原文条目 + 图片资源索引，已有结果按原资源自动复用",
        pit: "工程建得出来但条目是 0，多半是目录指错或引擎不受支持；先看输出面板里这个模块的报错。" },
      { title: "文本翻译", role: "把原文条目变成译文",
        input: "扫描出的原文条目、翻译引擎与语言",
        output: "译文条目（可人工修改），失败条目单独列出",
        pit: "有译文但写不进游戏，先查问题筛选里的占位符与换行；引擎超时看输出里的请求记录。",
        note: "与图片翻译、图片去码并行：三者都只依赖扫描结果。" },
      { title: "图片翻译", role: "识别图片里的文字并生成译图",
        input: "扫描出的图片资源、识别与翻译模型",
        output: "带译文的图片（先筛选、识字定位，再翻译排版）",
        pit: "识别到了但没译文，通常是文字区域没框准；译图没生成看修图引擎是否配置。" },
      { title: "图片去码", role: "找出并消除遮挡文字的码",
        input: "扫描出的图片资源；初筛与视觉复筛得到的候选框",
        output: "确认后的去码框与重绘结果，需手动采用才进补丁",
        pit: "筛出一堆框却没进补丁，是因为重绘后没有逐张「采用」；复筛很慢属正常，思考模型在逐图分析。" },
      { title: "生成与应用", role: "把文本与图片产物写回游戏",
        input: "已完成的译文、译图、去码图",
        output: "补丁或成品包；应用前需要关闭游戏",
        pit: "应用失败先看冲突提示与备份状态；卸载要在这里做，别直接删游戏文件。" },
    ],
  },
  {
    id: "chat", label: "对话", tagline: "连续问答与会话记录", group: "日常",
    steps: [
      { title: "发起对话", role: "把问题交给模型并保留上下文",
        input: "已连接的模型服务、会话记录",
        output: "回复写回该会话，可继续追问",
        pit: "发送失败看消息上的错误；换了模型服务要先在设置里确认连接可用。" },
    ],
  },
  {
    id: "text", label: "文本翻译工程", tagline: "分批翻译并留存进度", group: "日常",
    steps: [
      { title: "建立工程", role: "把原文件拆成可逐条处理的条目",
        input: "原文文件或已有工程",
        output: "条目工程，含原文、译文与问题标记",
        pit: "条目数不对，多半是文件格式或编码没识别对。" },
      { title: "批量翻译", role: "按范围翻译并保留进度",
        input: "选定的条目范围、源语言与目标语言",
        output: "译文条目；失败条目留在问题筛选里",
        pit: "占位符或换行异常，用问题筛选逐条核对后再导出。" },
    ],
  },
  {
    id: "literature", label: "文献翻译", tagline: "边读原文边看译文", group: "资源与识别",
    steps: [
      { title: "打开文献", role: "定位要读的内容",
        input: "PDF 或 EPUB 文献",
        output: "可翻页、可跳转的阅读视图",
        pit: "扫描版 PDF 没有文字层，要先在扫描页做 OCR。" },
      { title: "翻译与核对", role: "按段或按页翻译",
        input: "当前页或选中段落的原文",
        output: "译文，可与原文对照阅读",
        pit: "某一段没有译文，先看是提取失败还是翻译失败。" },
    ],
  },
  {
    id: "image", label: "图片文字识别", tagline: "把图片里的文字取出来", group: "资源与识别",
    steps: [
      { title: "添加与识别", role: "把像素变成可编辑的文字",
        input: "图片，可选框选范围与识别语言",
        output: "带坐标的文字块，可复制或继续翻译",
        pit: "识别为空先换识别模型；只想要局部就在预览里框定范围。" },
      { title: "翻译与导出", role: "把文字变成目标语言并输出",
        input: "识别结果、目标语言与输出格式",
        output: "译文或叠字后的图片",
        pit: "叠字错位是框选范围与字号不匹配。" },
    ],
  },
  {
    id: "redraw", label: "AI 风格重绘", tagline: "让译文贴合原图风格", group: "资源与识别",
    steps: [
      { title: "准备工作流", role: "接入本地的修图工作流",
        input: "ComfyUI 便携版目录、工作流与模型文件",
        output: "可运行的修图工作流",
        pit: "自定义工作流必须用 ComfyUI 导出的 API 格式，节点版格式跑不了。" },
      { title: "生成与采用", role: "生成候选并挑一张写回",
        input: "原图、文字区域或蒙版",
        output: "候选图，采用后成为该图的译图",
        pit: "候选不可用先看 ComfyUI 是否缺模型或节点。" },
    ],
  },
  {
    id: "speech", label: "语音转文字", tagline: "生成带时间轴的字幕", group: "资源与识别",
    steps: [
      { title: "添加音频", role: "解码并确定处理范围",
        input: "音频文件，可选波形区间",
        output: "可转写的音频段落",
        pit: "解码失败看格式是否支持，输出目录是否有权限。" },
      { title: "转写与导出", role: "识别文字并生成字幕",
        input: "识别模型、语言与输出格式",
        output: "SRT / VTT / TXT 字幕，可先校对",
        pit: "队列卡住看当前的错误项；多个文件可并行、可续跑。" },
    ],
  },
  {
    id: "benchmark", label: "记录与测试", tagline: "复盘运行、比较配置", group: "系统",
    steps: [
      { title: "游戏翻译测试", role: "用同一批样本横向比较配置",
        input: "工程、样本范围、多个配置与轮次",
        output: "独立归档的对照结果（质量、耗时、逐图结果）",
        pit: "中途暂停后任务留在队头，继续会从断点接着跑；测试运行与正式运行互斥。" },
      { title: "构建测速", role: "测量构建各阶段耗时",
        input: "勾选的测试项",
        output: "分阶段耗时表",
        pit: "失败时看该阶段的回显，多半是缓存或工具链问题。" },
    ],
  },
  {
    id: "output", label: "输出", tagline: "追查失败发生在哪一步", group: "系统",
    steps: [
      { title: "按模块或报错定位", role: "把失败还原成事件",
        input: "运行产生的日志",
        output: "按模块筛选的事件流，可导出",
        pit: "没有历史说明日志还没写入，先跑一次再看。" },
    ],
  },
  {
    id: "downloads", label: "下载", tagline: "跟踪模型与工具的去向", group: "系统",
    steps: [
      { title: "查看与继续", role: "管理进行中的资源下载",
        input: "模块发起的下载任务",
        output: "已完成的文件位置或回到原模块直接使用",
        pit: "失败看详情里的原因，部分任务支持暂停后续传。" },
    ],
  },
  {
    id: "stats", label: "统计", tagline: "核算请求与用量", group: "系统",
    steps: [
      { title: "查看用量", role: "按时间和模型看消耗",
        input: "请求日志与计价配置",
        output: "请求数、Token 与费用",
        pit: "费用异常先看计价配置；Token 未知说明该服务没有返回用量。" },
    ],
  },
  {
    id: "settings", label: "设置", tagline: "管理长期生效的配置", group: "系统",
    steps: [
      { title: "连接与凭证", role: "让各模块能调用模型服务",
        input: "地址、密钥、代理",
        output: "全局可用的连接，可选连接测试验证",
        pit: "改了连接会影响对话、翻译、视觉和在线语音；单次运行的语言与模型在各自页面调。" },
    ],
  },
  {
    id: "appearance", label: "外观", tagline: "切换界面配色", group: "系统",
    steps: [
      { title: "选择主题", role: "改变整个界面的配色",
        input: "内置主题",
        output: "立即生效并记在本机",
        pit: "重开又变回去，说明本机设置没写成功。" },
    ],
  },
];

const runtimeSteps: HelpStep[] = [
  { title: "检测 Unity 游戏", role: "确认运行环境",
    input: "游戏目录或进程",
    output: "引擎类型与位数",
    pit: "检测不到先确认游戏正在运行且是 Unity 构建。" },
  { title: "安装翻译插件", role: "把翻译注入游戏",
    input: "检测结果",
    output: "可加载的翻译插件",
    pit: "IL2CPP 需先装 BepInEx，首次启动完成初始化后关掉游戏再装插件。" },
  { title: "启动与检查", role: "确认游戏内可用",
    input: "已安装的插件与 LLMChat 模型端点",
    output: "游戏内可显示译文",
    pit: "用本地模型端点时软件要保持运行；卸载先卸插件再卸框架。" },
];

const moduleById = new Map(modules.map(item => [item.id, item]));
const groupOrder: HelpModule["group"][] = ["日常", "资源与识别", "系统"];

function StepCard({ step, index }: { step: HelpStep; index: number }) {
  return <article className="help-step">
    <header className="help-step-head">
      <span className="help-step-no">{index + 1}</span>
      <h3>{step.title}</h3>
      <span className="help-step-role">{step.role}</span>
    </header>
    <div className="help-io">
      <div className="help-io-box"><b>输入</b><span>{step.input}</span></div>
      <span className="help-io-mid" aria-hidden="true">→</span>
      <div className="help-io-box"><b>产出</b><span>{step.output}</span></div>
    </div>
    {step.pit && <p className="help-pit"><b>常见卡点</b><span>{step.pit}</span></p>}
    {step.note && <p className="help-note">{step.note}</p>}
  </article>;
}

function GuideSections({ steps }: { steps: HelpStep[] }) {
  return <>{steps.map((step, index) => <StepCard key={step.title} step={step} index={index} />)}</>;
}

export function ApplicationHelpPage({ onBack }: { onBack: () => void }) {
  const [section, setSection] = useState("unity");
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"guide" | "stuck">("guide");
  const titleId = useId();
  const current = moduleById.get(section) ?? modules[0];

  const hits = useMemo(() => {
    const keyword = query.trim();
    if (!keyword) return undefined;
    const result: { module: HelpModule; step: HelpStep }[] = [];
    for (const item of modules) {
      for (const step of item.steps) {
        const text = [item.label, step.title, step.role, step.input, step.output, step.pit ?? ""].join(" ");
        if (text.toLowerCase().includes(keyword.toLowerCase())) result.push({ module: item, step });
      }
    }
    return result;
  }, [query]);

  const open = (moduleId: string) => { setSection(moduleId); setQuery(""); setMode("guide"); };

  return <main className="help-page" aria-labelledby={titleId}>
    <nav className="help-nav" aria-label="帮助目录">
      <h1 id={titleId}>帮助</h1>
      {groupOrder.map(group => <div key={group} className="help-nav-group">
        <p className="help-nav-title">{group}</p>
        {modules.filter(item => item.group === group).map(item => <button key={item.id} type="button"
          className={item.id === section && !hits ? "help-nav-item on" : "help-nav-item"}
          onClick={() => open(item.id)}>{item.label}</button>)}
      </div>)}
    </nav>

    <div className="help-body">
      <header className="help-head">
        <h2>{current.label}</h2>
        <span className="help-tagline">{current.tagline}</span>
        <label className="help-search">
          <span className="visually-hidden">搜索帮助</span>
          <input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索步骤、报错或术语…" />
        </label>
        <button type="button" className="unity-btn" onClick={onBack}>返回</button>
      </header>

      {hits ? <div className="help-hits">
        <p className="help-hits-count">找到 {hits.length} 处与「{query.trim()}」相关</p>
        {hits.map(({ module, step }) => <button key={module.id + step.title} type="button" className="help-hit"
          onClick={() => open(module.id)}>
          <span className="help-hit-module">{module.label}</span>
          <b>{step.title}</b>
          <span>{step.role}</span>
        </button>)}
        {!hits.length && <p className="help-note">换个说法试试：模块名、步骤名、报错里的关键词都行。</p>}
      </div> : <>
        <div className="help-modes" role="tablist" aria-label="帮助视角">
          <button type="button" role="tab" aria-selected={mode === "guide"} className={mode === "guide" ? "help-mode on" : "help-mode"}
            onClick={() => setMode("guide")}><b>按流程看</b><span>每一步在干什么、交出什么</span></button>
          <button type="button" role="tab" aria-selected={mode === "stuck"} className={mode === "stuck" ? "help-mode on" : "help-mode"}
            onClick={() => setMode("stuck")}><b>我卡住了</b><span>按症状直接查卡点</span></button>
        </div>

        {mode === "guide" && current.steps.length > 1 && <ol className="help-chain" aria-label="步骤顺序">
          {current.steps.map((step, index) => <li key={step.title} className="help-chain-node">
            <span>{step.title}</span>
            {index < current.steps.length - 1 && <i aria-hidden="true" />}
          </li>)}
        </ol>}
        {mode === "guide" && current.steps.length > 1 && <p className="help-chain-note">
          横排顺序就是执行顺序；「图片翻译」与「图片去码」都只依赖扫描结果，可以互换先后，其余步骤按箭头依次进行。
        </p>}

        {mode === "guide"
          ? <GuideSections steps={section === "unity" ? current.steps : current.steps} />
          : <div className="help-stuck">
            {current.steps.filter(step => step.pit).map(step => <article key={step.title} className="help-step is-stuck">
              <header className="help-step-head"><h3>{step.title}</h3><span className="help-step-role">{step.role}</span></header>
              <p className="help-pit"><b>常见卡点</b><span>{step.pit}</span></p>
            </article>)}
            {!current.steps.some(step => step.pit) && <p className="help-note">这一步目前没有记录常见卡点，可以先看「输出」面板里的报错。</p>}
          </div>}
      </>}
    </div>
  </main>;
}

export function GameWorkflowHelpPage({ mode, supportsImages, onClose }: Omit<GameHelpSetup, "kind"> & { onClose: () => void }) {
  const titleId = useId();
  const runtime = mode === "unity-runtime";
  const steps = runtime ? runtimeSteps : modules[0].steps.filter(step => supportsImages || (step.title !== "图片翻译" && step.title !== "图片去码"));
  return <main className="help-page is-window" aria-labelledby={titleId}>
    <div className="help-body">
      <header className="help-head">
        <h2 id={titleId}>{runtime ? "Unity 运行时翻译流程" : "游戏翻译流程"}</h2>
        <span className="help-tagline">每一步在干什么、交出什么</span>
        <button type="button" className="unity-btn" onClick={onClose} style={{ marginLeft: "auto" }}>关闭</button>
      </header>
      <GuideSections steps={steps} />
    </div>
  </main>;
}

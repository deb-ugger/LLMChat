import { useId, useRef } from "react";
import { createPortal } from "react-dom";
import { UnityActionIcon } from "./UnityActionIcon";
import { UnityIconButton } from "./UnityIconButton";

type Section = {
  number: string;
  title: string;
  description: string;
  details?: readonly (readonly [string, string])[];
};

function offlineGuide(unity: boolean, images: boolean): Section[] {
  const sections: Section[] = [
    {
      number: "1", title: "扫描资源",
      description: "读取游戏目录并建立翻译工程。扫描完成后可以查看原文和可处理的资源。",
      details: [
        ["提取文本", unity ? "读取可回写的 Unity 文本和资源位置。代码字面量可按程序集范围选扫。" : "提取引擎支持的游戏文本，建立原文与回写资源的对应关系。"],
        ...(images ? [["整理图片", "登记可处理的原图。是否包含需要翻译的文字，由图片步骤判断。"]] as const : []),
        ...(unity ? [["重新扫描", "更新资源清单，复用能匹配的旧译文、识别结果、导入译图和勾选状态。"]] as const : []),
      ],
    },
    {
      number: "2.1", title: "翻译文本",
      description: "先筛选，再翻译正文。处理后可在右侧检查原文、译文和失败条目。",
      details: [
        ["筛选文本", "根据原文与目标语言选项确定处理范围。可用本地规则或独立的大模型判断哪些内容已经符合目标语言，并将其原样保留。"],
        ["翻译正文", "使用所选翻译引擎或大模型处理剩余正文。大模型可选提示词，也可按设置附带同一资源的上下文。已确定的插件姓名框译名优先复用术语表或已有合格译文。"],
        ["换行与校验", "按所选方式保留原换行、合并翻译后恢复换行，或使用大模型自然断行。写回前检查占位符、富文本标签等格式，失败条目可修正后重试。"],
      ],
    },
  ];
  if (images) {
    sections.push({
      number: "2.2", title: "图片翻译",
      description: "识别图内文字并生成译图。可在右侧检查区域、修改译文、重绘或导入替换图。",
      details: unity ? [
        ["识字与定位", "对所选图片使用 OCR 或视觉大模型，记录识别原文、区域坐标和置信度。"],
        ["翻译图片文字", "翻译符合条件的区域文字，可用指定模型重译校验失败的区域。随后用本地排版或大模型辅助断行生成译图。"],
      ] : [
        ["筛选图片", "从扫描出的图片中找出可能含有待译文字的候选。"],
        ["复筛图片（可选）", "用本地 OCR 或视觉大模型检查「待复核」和「待正式识别」的图片，更新分组和默认勾选。"],
        ["识字与定位", "正式识别已勾选的图片，记录文字、区域坐标和置信度，供翻译和排版使用。"],
        ["翻译图片文字", "用所选引擎或大模型翻译区域文字，保存译文以供复核。"],
        ["复核与重译", "检查翻译结果。配置了重译模型时，可重新处理未通过校验的区域。"],
        ["生成译图", "把区域译文排回原图。可选本地原位排版或大模型辅助断行，生成供应用的译图。"],
      ],
    });
  }
  sections.push(
    {
      number: "3", title: "生成补丁",
      description: images ? "文本和图片处理完成，或分别跳过剩余内容后，即可准备补丁。" : "文本处理完成或跳过剩余内容后，即可准备补丁。",
      details: [
        ["检查待写回内容", "保存当前修改，检查译文与游戏资源是否匹配以及格式是否合法。"],
        ...(unity ? [["检查字库", "选择替换字体后，可检查它是否覆盖译文需要的字符，并查看缺字清单。"]] as const : []),
        ["生成产物", unity ? "将可用结果写入补丁目录，供下一步应用。" : "生成供下一步安装的文本补丁。已有译图在应用阶段写入游戏。"],
      ],
    },
    {
      number: "4", title: "应用到游戏",
      description: "先关闭游戏，再应用补丁。应用完成后启动游戏检查实机显示。",
      details: unity ? [
        ["安装或更新", "将补丁写入游戏目录。检测到已安装的本软件补丁时，应用新补丁前先恢复原件。"],
        ["启动与卸载", "可从应用页启动游戏。需要还原时，使用卸载补丁恢复备份中的原件。"],
      ] : [
        ["备份与安装文本", "按所选备份方式保留原件，再应用新补丁或更新已安装的译文。"],
        ...(images ? [["应用译图", "在图片应用页写入已勾选且生成完成的译图。文本补丁与图片结果可以分别卸载。"]] as const : []),
        ["卸载与恢复", "通过对应的卸载或恢复操作还原游戏原件。检测到资源冲突时，先处理输出中列出的文件。"],
      ],
    },
  );
  return sections;
}

const runtimeGuide: Section[] = [
  { number: "1", title: "检测游戏", description: "选择游戏目录或程序，确认识别结果中的运行环境和位数。" },
  {
    number: "2", title: "安装插件框架", description: "先按运行环境安装对应框架。",
    details: [["Mono", "安装 ReiPatcher。"], ["IL2CPP", "安装 BepInEx，启动一次游戏完成初始化，再关闭游戏。"]],
  },
  {
    number: "3", title: "安装并配置翻译插件", description: "安装 XUnity.AutoTranslator，选择翻译端点并保存配置。使用 LLMChat 大模型端点时，游戏翻译期间需保持 LLMChat 运行。",
  },
  {
    number: "4", title: "启动并检查", description: "启动游戏。Mono 首次可使用「补丁并启动」。在游戏内按 Alt+0 打开翻译面板。卸载时先卸翻译插件，再卸插件框架。",
  },
];

export function GameWorkflowHelp({ mode, supportsImages = true }: {
  mode: "unity-offline" | "unity-runtime" | "embedded";
  supportsImages?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  const runtime = mode === "unity-runtime";
  const sections = runtime ? runtimeGuide : offlineGuide(mode === "unity-offline", supportsImages);
  return <>
    <UnityIconButton title="游戏翻译流程帮助" aria-haspopup="dialog" aria-controls={id}
      onClick={() => dialog.current?.showModal()}>
      <UnityActionIcon kind="help" />
    </UnityIconButton>
    {createPortal(<dialog ref={dialog} id={id} className="game-workflow-help" aria-labelledby={id + "-title"}>
      <header className="game-workflow-help-header">
        <h2 id={id + "-title"}>{runtime ? "Unity 运行时翻译流程" : "游戏翻译流程"}</h2>
        <button type="button" className="unity-btn" aria-label="关闭流程帮助" onClick={() => dialog.current?.close()}>关闭</button>
      </header>
      <div className="game-workflow-help-content">
        {!runtime && <p className="game-workflow-help-summary">
          「一键生成并应用」会连续执行各阶段。{supportsImages && "文本和图片可并行处理。"}中止后可继续，跳过剩余内容会保留已完成结果。
        </p>}
        <nav className="game-workflow-help-index" aria-label="流程目录">
          {sections.map(section => {
            const target = `${id}-${section.number}`;
            return <a key={section.number} href={`#${target}`} onClick={event => {
              event.preventDefault();
              document.getElementById(target)?.scrollIntoView({ block: "start" });
            }}>{section.number} {section.title}</a>;
          })}
        </nav>
        {sections.map(section => <section key={section.number} id={`${id}-${section.number}`} className="game-workflow-help-section">
          <h3><span>{section.number}</span>{section.title}</h3>
          <p>{section.description}</p>
          {section.details && <dl>{section.details.map(([name, description]) =>
            <div key={name}><dt>{name}</dt><dd>{description}</dd></div>,
          )}</dl>}
        </section>)}
      </div>
    </dialog>, document.body)}
  </>;
}

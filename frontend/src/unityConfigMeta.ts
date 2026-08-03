/** Labels & help text for XUnity.AutoTranslator Config.ini (from upstream README). */

export type ConfigFieldMeta = {
  label: string;
  help: string;
};

export type ConfigSectionMeta = {
  label: string;
  help: string;
};

export const CONFIG_SECTION_META: Record<string, ConfigSectionMeta> = {
  Service: {
    label: "翻译服务",
    help: "选择主翻译引擎与备用引擎。",
  },
  General: {
    label: "语言",
    help: "游戏原文语言与翻译目标语言。",
  },
  Files: {
    label: "翻译文件路径",
    help: "缓存、自动生成译文、替换与预/后处理文件所在目录。可用占位符 {Lang}、{GameExeName}。",
  },
  TextFrameworks: {
    label: "文本框架",
    help: "启用后才会翻译对应 Unity UI 框架中的文字。",
  },
  Behaviour: {
    label: "行为与显示",
    help: "翻译长度、空白处理、UI 缩放、字体覆盖、剪贴板等核心行为。",
  },
  Texture: {
    label: "贴图翻译",
    help: "替换或导出游戏内图片（对性能影响较大，默认关闭）。",
  },
  ResourceRedirector: {
    label: "资源重定向",
    help: "拦截并替换游戏加载的文本等资源，用于高级汉化。",
  },
  Http: {
    label: "网络请求",
    help: "翻译 API 的 HTTP 相关选项。",
  },
  TranslationAggregator: {
    label: "翻译对比窗口",
    help: "游戏内多引擎对比窗口（Alt 等热键打开）的尺寸与启用列表。",
  },
  Google: {
    label: "Google（可选）",
    help: "自定义 Google 翻译请求地址，可用于绕过地区限制。",
  },
  GoogleLegitimate: {
    label: "Google Cloud（需 Key）",
    help: "使用官方 Google Cloud Translation 时填写。",
  },
  BingLegitimate: {
    label: "Azure / Bing（需 Key）",
    help: "使用 Azure Translator 时填写订阅密钥。",
  },
  Baidu: {
    label: "百度翻译（需 Key）",
    help: "使用百度翻译开放平台时填写 AppId 与密钥。",
  },
  Yandex: {
    label: "Yandex（需 Key）",
    help: "使用 Yandex 翻译 API 时填写。",
  },
  Watson: {
    label: "IBM Watson（需 Key）",
    help: "使用 Watson Language Translator 时填写。",
  },
  DeepL: {
    label: "DeepL（免 Key 节流）",
    help: "免 Key DeepL 的请求间隔，避免被限流。",
  },
  DeepLLegitimate: {
    label: "DeepL API（需 Key）",
    help: "使用官方 DeepL API 时填写。",
  },
  Custom: {
    label: "自定义接口",
    help: "使用 CustomTranslate 时填写服务地址。",
  },
  LecPowerTranslator15: {
    label: "LEC Power Translator",
    help: "本地 LEC 翻译软件安装路径。",
  },
  LingoCloud: {
    label: "彩云小译",
    help: "使用彩云小译时可选填写 Token。",
  },
  Debug: {
    label: "调试",
    help: "控制台与额外日志；一般无需开启。",
  },
  Migrations: {
    label: "配置迁移",
    help: "插件升级时自动迁移配置。Tag 请勿手动改。",
  },
};

export const CONFIG_FIELD_META: Record<string, ConfigFieldMeta> = {
  // Service
  Endpoint: {
    label: "翻译引擎",
    help: "主翻译服务。常用：GoogleTranslate / GoogleTranslateV2 / BingTranslate / DeepLTranslate 等。",
  },
  FallbackEndpoint: {
    label: "备用引擎",
    help: "主引擎某条译文失败时自动改用的备用服务；可留空。",
  },

  // General
  Language: {
    label: "目标语言",
    help: "要翻译成的语言，例如 zh-CN（简体中文）、en、zh-TW。",
  },
  FromLanguage: {
    label: "原文语言",
    help: "游戏原文语言，例如 ja（日语）。部分引擎支持 auto，但一般不推荐。",
  },

  // Files
  Directory: {
    label: "译文缓存目录",
    help: "手动/缓存译文文件的搜索目录。",
  },
  OutputFile: {
    label: "自动生成译文文件",
    help: "插件自动翻译的结果写入此文件，便于后续校对。",
  },
  SubstitutionFile: {
    label: "替换表文件",
    help: "翻译前按表替换专有名词等（如人名、术语）。",
  },
  PreprocessorsFile: {
    label: "预处理文件",
    help: "送去翻译引擎之前对文本做的规则处理。",
  },
  PostprocessorsFile: {
    label: "后处理文件",
    help: "拿到译文之后对文本做的规则处理。",
  },

  // TextFrameworks
  EnableUGUI: {
    label: "启用 UGUI",
    help: "翻译 Unity 自带 UGUI（Canvas/Text）文字。",
  },
  EnableUIElements: {
    label: "启用 UI Toolkit",
    help: "翻译 UIElements / UI Toolkit 文字。",
  },
  EnableNGUI: {
    label: "启用 NGUI",
    help: "翻译 NGUI 文字。",
  },
  EnableTextMeshPro: {
    label: "启用 TextMeshPro",
    help: "翻译 TMP 文字；缺字时常需配合字体相关选项。",
  },
  EnableTextMesh: {
    label: "启用 TextMesh",
    help: "翻译 3D TextMesh；默认关闭，场景漂浮字较多时才开。",
  },
  EnableIMGUI: {
    label: "启用 IMGUI",
    help: "翻译 OnGUI 即时界面；默认关闭，可能影响其他插件窗口。",
  },
  EnableFairyGUI: {
    label: "启用 FairyGUI",
    help: "翻译 FairyGUI 文字。",
  },

  // Behaviour
  MaxCharactersPerTranslation: {
    label: "单次最大字符数",
    help: "超过此长度的文本不翻译。上限约 2500；过大可能触发引擎限制。",
  },
  IgnoreWhitespaceInDialogue: {
    label: "对话忽略空白",
    help: "对话类文本在匹配/发送前忽略空白与换行，常能提升译文质量。",
  },
  IgnoreWhitespaceInNGUI: {
    label: "NGUI 忽略空白",
    help: "NGUI 文本同样忽略空白与换行。",
  },
  MinDialogueChars: {
    label: "对话判定长度",
    help: "文本长度达到此值才视为「对话」，用于空白处理等逻辑。",
  },
  ForceSplitTextAfterCharacters: {
    label: "强制换行字数",
    help: "译文超过该字数时强制分行；0 表示不强制。",
  },
  CopyToClipboard: {
    label: "复制到剪贴板",
    help: "把钩取到的原文复制到系统剪贴板，便于外部工具使用。",
  },
  MaxClipboardCopyCharacters: {
    label: "剪贴板最大长度",
    help: "一次写入剪贴板的最大字符数。",
  },
  ClipboardDebounceTime: {
    label: "剪贴板防抖（秒）",
    help: "钩取文本延迟多久再写入剪贴板，最小约 0.1。",
  },
  EnableUIResizing: {
    label: "翻译后调整 UI",
    help: "译文变长时尽量调整溢出方式，让文字更容易显示全。",
  },
  EnableBatching: {
    label: "批量请求",
    help: "支持的引擎可将多条文本合并请求，减少网络次数。",
  },
  UseStaticTranslations: {
    label: "使用内置静态词库",
    help: "使用插件自带的常用日英等静态对照，减少在线请求。",
  },
  OverrideFont: {
    label: "覆盖 UGUI 字体",
    help: "强制 UGUI 使用指定字体；仅对 UGUI 有效。",
  },
  OverrideFontSize: {
    label: "覆盖 UGUI 字号",
    help: "强制 UGUI 文字大小；可留空。",
  },
  OverrideFontTextMeshPro: {
    label: "覆盖 TMP 字体",
    help: "直接替换 TMP 字体资源。多数情况更推荐用「TMP 回退字体」。",
  },
  FallbackFontTextMeshPro: {
    label: "TMP 回退字体",
    help: "TMP 缺字时追加回退字体，兼容性通常优于强制覆盖。",
  },
  ResizeUILineSpacingScale: {
    label: "行距缩放",
    help: "UI 调整时的行距倍率，如 0.80；仅 UGUI。",
  },
  ForceUIResizing: {
    label: "强制全部 UI 调整",
    help: "无论是否刚被翻译，都对 UI 应用调整行为。",
  },
  IgnoreTextStartingWith: {
    label: "忽略前缀",
    help: "以这些字符开头的字符串不翻译；用 ; 分隔。",
  },
  TextGetterCompatibilityMode: {
    label: "Text Getter 兼容模式",
    help: "游戏用「显示文字」做逻辑判断时才需要开启，否则可能破坏流程。",
  },
  GameLogTextPaths: {
    label: "游戏日志组件路径",
    help: "持续追加/前置文本的日志类物体路径；高级选项，用 ; 分隔。",
  },
  RomajiPostProcessing: {
    label: "罗马音后处理",
    help: "目标为罗马音时的后处理，解决字体不支持变音符号等问题。",
  },
  TranslationPostProcessing: {
    label: "译文后处理",
    help: "普通译文的后处理，如替换 HTML 实体、全角字符等。",
  },
  RegexPostProcessing: {
    label: "正则捕获后处理",
    help: "对正则捕获组内容做后处理；None 表示不做。",
  },
  CacheRegexLookups: {
    label: "缓存正则查找",
    help: "是否把正则查找结果写入自动生成译文文件。",
  },
  CacheWhitespaceDifferences: {
    label: "缓存空白差异",
    help: "是否把空白差异结果写入输出文件。",
  },
  CacheRegexPatternResults: {
    label: "缓存正则拆分结果",
    help: "是否把正则拆分后的完整译文写入输出文件。",
  },
  CacheParsedTranslations: {
    label: "缓存已解析译文",
    help: "缓存解析后的译文以减少重复请求。",
  },
  GenerateStaticSubstitutionTranslations: {
    label: "生成无变量替换译文",
    help: "使用替换表时生成不含变量的静态译文。",
  },
  GeneratePartialTranslations: {
    label: "生成部分译文",
    help: "支持文字「逐字滚出」时的局部翻译。",
  },
  EnableTranslationScoping: {
    label: "启用翻译作用域",
    help: "解析 TARC 指令，按场景/范围应用译文。",
  },
  EnableSilentMode: {
    label: "静默模式",
    help: "不打印翻译成功类日志，减少刷屏。",
  },
  BlacklistedIMGUIPlugins: {
    label: "IMGUI 黑名单",
    help: "名称包含这些字符串的 IMGUI 窗口不翻译；用 ; 分隔。",
  },
  OutputUntranslatableText: {
    label: "输出不可译文",
    help: "把判定为不可翻译的文本也写入输出文件。",
  },
  IgnoreVirtualTextSetterCallingRules: {
    label: "忽略虚方法赋值规则",
    help: "设置文字时忽略虚方法调用限制，偶发可修复顽固组件。",
  },
  MaxTextParserRecursion: {
    label: "文本解析递归层数",
    help: "分段翻译时的最大递归深度；1 表示基本不递归。",
  },
  HtmlEntityPreprocessing: {
    label: "HTML 实体预处理",
    help: "翻译前解码 HTML 实体，避免部分引擎失败。",
  },
  HandleRichText: {
    label: "处理富文本",
    help: "自动处理带 markup 的富文本，减少标签被翻坏。",
  },
  PersistRichTextMode: {
    label: "富文本存储方式",
    help: "Final=整句存储；Fragment=分段存储（Final 不支持替换变量）。",
  },
  EnableTranslationHelper: {
    label: "翻译辅助日志",
    help: "输出对制作资源重定向汉化有帮助的日志。",
  },
  ForceMonoModHooks: {
    label: "强制 MonoMod Hook",
    help: "不用 Harmony 而强制 MonoMod；解决部分无法 Hook 的情况。",
  },
  InitializeHarmonyDetourBridge: {
    label: "初始化 Harmony Bridge",
    help: "在缺少 Reflection.Emit 的环境启用 Harmony；有插件管理器时通常不必开。",
  },
  RedirectedResourceDetectionStrategy: {
    label: "重定向资源识别策略",
    help: "避免资源已被重定向后再次被在线翻译（防双重翻译）。",
  },
  OutputTooLongText: {
    label: "输出超长原文",
    help: "超过最大字符数、未翻译的文本是否仍写入输出文件。",
  },
  ReloadTranslationsOnFileChange: {
    label: "文件变更时重载",
    help: "译文文件被外部修改后自动重新加载。",
  },
  EnableTextPathLogging: {
    label: "记录文本组件路径",
    help: "把文本组件路径打到日志，便于定位难翻的 UI。",
  },
  TemplateAllNumberAway: {
    label: "数字模板化",
    help: "翻译前把数字抽成模板，减少重复请求、稳定术语。",
  },

  // Texture
  TextureDirectory: {
    label: "贴图目录",
    help: "导出/加载替换贴图的根目录。",
  },
  EnableTextureTranslation: {
    label: "启用贴图替换",
    help: "用目录中的图片替换游戏内贴图。",
  },
  EnableTextureDumping: {
    label: "导出贴图",
    help: "把可替换贴图导出到目录；性能开销大。",
  },
  EnableTextureToggling: {
    label: "热键切换贴图翻译",
    help: "Alt+T 切换翻译时是否也切换贴图；不保证全部生效。",
  },
  EnableTextureScanOnSceneLoad: {
    label: "场景加载时扫描贴图",
    help: "切场景时扫描更多可贴图对象。",
  },
  EnableSpriteRendererHooking: {
    label: "Hook SpriteRenderer",
    help: "尝试处理 SpriteRenderer；有一定性能风险。",
  },
  LoadUnmodifiedTextures: {
    label: "加载未修改贴图",
    help: "仅调试用；可能造成显示异常。",
  },
  TextureHashGenerationStrategy: {
    label: "贴图哈希策略",
    help: "如何生成贴图标识：FromImageName / FromImageData / FromImageNameAndScene。",
  },
  DuplicateTextureNames: {
    label: "重复贴图名列表",
    help: "游戏中重名的贴图名；用 ; 分隔。",
  },
  DetectDuplicateTextureNames: {
    label: "检测重复贴图名",
    help: "自动检测重名贴图。",
  },
  EnableLegacyTextureLoading: {
    label: "旧版贴图加载",
    help: "老引擎游戏可尝试此加载方式。",
  },
  CacheTexturesInMemory: {
    label: "内存缓存贴图",
    help: "常驻内存以提速；关闭可省内存。",
  },

  // ResourceRedirector
  PreferredStoragePath: {
    label: "重定向资源目录",
    help: "存放被重定向资源的首选路径。",
  },
  EnableTextAssetRedirector: {
    label: "重定向 TextAsset",
    help: "拦截并替换 TextAsset。",
  },
  LogAllLoadedResources: {
    label: "记录全部加载资源",
    help: "把加载的资源打到控制台，便于分析可 Hook 项。",
  },
  EnableDumping: {
    label: "导出可译资源",
    help: "发现可翻译资源时导出到磁盘。",
  },
  CacheMetadataForAllFiles: {
    label: "缓存文件元数据",
    help: "为实体文件也建立索引，减少反复 IO（ZIP 默认已索引）。",
  },

  // Http
  UserAgent: {
    label: "User-Agent",
    help: "覆盖部分 API 使用的浏览器标识；可留空。",
  },
  DisableCertificateValidation: {
    label: "禁用证书校验",
    help: "关闭 .NET HTTPS 证书验证；不安全，仅特殊网络环境考虑。",
  },

  // TranslationAggregator
  Width: {
    label: "窗口总宽度",
    help: "翻译对比窗口总宽度（像素）。",
  },
  Height: {
    label: "每引擎高度",
    help: "对比窗口中每个翻译引擎区域的高度。",
  },
  EnabledTranslators: {
    label: "启用的引擎 ID",
    help: "对比窗口中启用的引擎 id 列表；用 ; 分隔。",
  },

  // Provider keys
  ServiceUrl: {
    label: "Google 服务地址",
    help: "可选，把 Google 请求转到其他 URL。",
  },
  GoogleAPIKey: {
    label: "Google API Key",
    help: "GoogleTranslateLegitimate 所需。",
  },
  OcpApimSubscriptionKey: {
    label: "Azure 订阅密钥",
    help: "BingTranslateLegitimate / Azure 所需。",
  },
  BaiduAppId: {
    label: "百度 AppId",
    help: "百度翻译开放平台应用 ID。",
  },
  BaiduAppSecret: {
    label: "百度密钥",
    help: "百度翻译开放平台密钥。",
  },
  YandexAPIKey: {
    label: "Yandex API Key",
    help: "YandexTranslate 所需。",
  },
  Url: {
    label: "服务 URL",
    help: "该引擎所需的服务地址。",
  },
  Key: {
    label: "密钥",
    help: "该引擎所需的访问密钥。",
  },
  MinDelay: {
    label: "最小间隔（秒）",
    help: "DeepL 免 Key 模式下两次请求的最小间隔。",
  },
  MaxDelay: {
    label: "最大间隔（秒）",
    help: "DeepL 免 Key 模式下两次请求的最大间隔。",
  },
  ApiKey: {
    label: "API Key",
    help: "DeepL 官方 API 密钥。",
  },
  Free: {
    label: "使用 Free 套餐",
    help: "DeepL API 是否为 Free 计划。",
  },
  InstallationPath: {
    label: "安装路径",
    help: "LEC Power Translator 的安装目录。",
  },
  LingoCloudToken: {
    label: "彩云 Token",
    help: "彩云小译可选 Token。",
  },

  // Debug / Migrations
  EnableConsole: {
    label: "启用控制台",
    help: "打开插件控制台；若已有 BepInEx 等管理器接管则不要开。",
  },
  EnableLog: {
    label: "额外调试日志",
    help: "输出更多调试信息。",
  },
  Enable: {
    label: "启用自动迁移",
    help: "版本升级时自动迁移本配置文件。",
  },
  Tag: {
    label: "版本标签",
    help: "记录上次运行的插件版本；请勿手动修改。",
  },
};

export function sectionMeta(name: string): ConfigSectionMeta {
  return (
    CONFIG_SECTION_META[name] || {
      label: name,
      help: "该分区来自 AutoTranslator 配置文件。",
    }
  );
}

export function fieldMeta(key: string): ConfigFieldMeta {
  return (
    CONFIG_FIELD_META[key] || {
      label: key,
      help: "详见 XUnity.AutoTranslator 官方 README 配置说明。",
    }
  );
}

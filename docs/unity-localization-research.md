# Unity 嵌字翻译资料核对

核对日期：2026-10-24。目标是为 LLMChat 的 Unity 嵌字翻译模块确定文本提取、翻译、字体处理和资源回写边界。翻译可使用在线服务或本机模型；不能把游戏运行时是否联网与翻译阶段是否联网混为一项设置。

资料仓库：[Unity-Game-localization-tutorial-and-toolkit](https://github.com/mskgroup/Unity-Game-localization-tutorial-and-toolkit)，本次检出的提交为 `ffedea6eb1f32aa9411ff82fdc38dd623f890103`。

## 核对范围与阅读状态

- 仓库的 36 个跟踪文件均已纳入清单，包括零字节说明、Office 占用文件、字符集、工具压缩包和单独的安装程序。
- 16 个外层 ZIP 已递归检查，最终共 30 个压缩包、1709 个目录条目。条目数包含目录、内层压缩包和不同包内的重复文件，不是 1709 个独立工具。
- 30 个包均通过解包工具的完整性检查；检查不等于运行安全认证。Windows 自带 tar 最初不能解码其中三个 RAR 的部分内容，换用从 7-Zip 官方发布下载的解包程序后均可读取。未运行仓库附带的 EXE、DLL、BAT 或 Python 脚本。
- README、流程说明、字符集说明和 Word 教程正文已读；Word 的 438 段正文及 45 张内嵌图片均已检查。环境缺少技能要求的随包 LibreOffice，因此没有进行完整 Word 页面渲染验证。
- README 列举的 16 个工具逐项核对了用途、可取得的上游说明以及包内相关说明。UnityL10nTool 的 7 个核心插件实现源码已逐份阅读；MetaDataStringEditor 的读写及编辑流程也已阅读。
- 二进制程序仅检查包内构成、版本信息及相关文档，不声称已经读过其不存在于包内的源代码。生成的 API XML、字体字形表和 010 Editor 通用模板库已建立清单、读取和分类，未逐行人工审计全部依赖与通用模板。
- README 的 9 个视频链接也已列入下方清单，但没有取得视频正文或字幕；部分页面返回 412，另有页面只提供简介。不能把读过简介称为看完视频。

本记录是全量文件盘点与核心实现阅读记录，不是所有上游仓库和传递依赖的逐行源码审计，也不是已完成模块的验收报告。

## 仓库全部文件

### 根目录

| 文件 | 检查内容 |
| --- | --- |
| `README.md` | 工具来源、教程链接、字符集建议、基本流程 |
| `Unity localization process汉化流程.txt` | Mono / IL2CPP 文本、TextAsset、字体及关联资源替换步骤 |
| `教程：Unity安卓手游汉化笔记.docx` | 序列化资源、PPtr、MonoBehaviour、字体、纹理、TextAsset、代码字符串 |

### CharacterSetMakeForIcetric

字符集按 BOM 分别解码，不统一假定 UTF-8。下表字符数按 Unicode 码点计，包含原文件中的换行等字符；不是可渲染字形数量。

| 文件 | 字符数 / 去重数 |
| --- | --- |
| `0-Icetric制作 Make for Icetric` | 零字节署名占位文件 |
| `0-ReadMe 必看：说明及推荐优先级.txt` | 字符集说明 |
| `CHS1-GBK符号+通用规范汉字表(一级).txt` | 4465 / 4463 |
| `CHS2-GBK符号+通用规范汉字表(二级).txt` | 7465 / 7463 |
| `CHS3-GBK符号+通用规范汉字表(三级).txt` | 9082 / 9079 |
| `CHS4-GBK.txt` | 21968 / 21957 |
| `CHSn1-GB2312精简.txt` | 4567 / 4565 |
| `CHSn2-GB2312.txt` | 8234 / 8216 |
| `CHT1-GBK符号+常用国字表.txt` | 5773 / 5771 |
| `CHT2-GBK符号+(次)常用国字表.txt` | 12105 / 12100 |
| `CHTn1-GB12345繁体.txt` | 7715 / 7681 |
| `Korean1-KS1001.txt` | 3258 / 3256，UTF-16 |
| `Minority script & Multilingual 少数民族及多语言-GB18030.txt` | 143181 / 143179，含一个 U+FFFD |
| `Russian Latin Greek Japanes(Katomi,Hiragana)-GBKsymbol(this file has been optimized).txt` | 936 / 934 |
| `~$ Microsoft Word 文档.docx` | 162 字节 Office 占用文件，不是可打开的教程 DOCX |

字符集应依据实际译文去重生成，并检测字体缺字。不能默认将整个 GB18030 字符集塞入单张图集；不能因扩展名或“FNT”字样就认定字体格式相同。

### Tools

| 子目录 | 文件 |
| --- | --- |
| `.NET Disassembly` | `ILSpy_withReflexil_7.1.0.6587.zip` |
| `.NET Disassembly` | `dnSpy-netframework.zip` |
| `AssetEditor` | `AssetStudio.v0.16.0.zip` |
| `AssetEditor` | `AssetsBundleExtractor_2.2stabled_64bit.zip` |
| `AssetEditor` | `UAAE_20210812.zip` |
| `AssetEditor` | `UABEA_202100811.zip` |
| `AssetEditor` | `UnityEX.zip` |
| `Font` | `FilterRepeatCharacter.zip` |
| `Font` | `FontMergeSupplementaryTools.zip` |
| `Font` | `UnityL10nTool_v0.1.29.zip` |
| `Font` | `UnityTranz.zip` |
| `Font` | `bmfont1.14a.zip` |
| `IL2CPP` | `Il2CppAssemblyUnhollower.0.4.15.4.zip` |
| `IL2CPP` | `Il2CppDumper-v6.6.5.zip` |
| `IL2CPP` | `MelonLoader.x64-v0.4.3.zip` |
| `IL2CPP` | `MetaDataStringEditor.exe`，文件版本 1.0.0.0 |
| `TextTools` | `010Editor v11.0.1 汉化特别版.zip` |
| `TextTools` | `npp.8.1.2.Installer.x64.exe`，文件版本 8.1.2.0 |

以上为根目录 3 个、字符集目录 15 个、Tools 18 个，共 36 个跟踪文件。

## README 列出的全部 16 个工具

包内版本与上游当前版本分开判断。旧二进制携带的许可不能被另一个项目或新版本的许可替代。

| 工具与来源 | 本次核对结论 |
| --- | --- |
| [UABE](https://github.com/SeriousCache/UABE) | 读取、导出和回写序列化资源及 Bundle，带类型数据库与批处理接口。旧包说明包含 CC BY-NC-SA 3.0 等限制；不能直接当作无条件可分发依赖。上游已归档。 |
| [AssetStudio](https://github.com/Perfare/AssetStudio) | 资源识别、预览、导出，不是通用资源回写器。IL2CPP MonoBehaviour 解析可能需要 DummyDll。上游已归档。 |
| [Il2CppDumper](https://github.com/Perfare/Il2CppDumper) | 提取类型与元数据信息、生成 DummyDll，不能把输出 DLL 当成带真实方法实现的原始程序集。已读中文说明、包内配置，并检查附带 IDA / Ghidra 脚本。 |
| [dnSpy](https://github.com/dnSpy/dnSpy) | Mono 托管代码反编译、调试和 IL 编辑；老仓库已归档。不适用于把 IL2CPP 原生代码直接还原成可任意回写的 C#。 |
| [MetaDataStringEditor](https://github.com/JeremieCHN/MetaDataStringEditor) | 修改 IL2CPP 字符串字面量表。已读 `MetadataFile.cs`、`EditorListItem.cs`、主窗口及编辑流程。旧实现不能替代版本、偏移、长度和边界校验。 |
| [UnityL10nTool](https://github.com/dmc31a42/UnityL10nTool) | 字体识别、资源替换、文本插件；7 个核心插件见下节。README 明确声明 CC BY-NC-SA 3.0，不能直接照搬并随产品分发。 |
| [FontMergeSupplementaryTools](https://github.com/nowar-fonts/Warcraft-Font-Merger) | 使用 otfcc 等工具合并字体；包内批处理通过输入顺序决定字形优先级。须另外检查输入字体许可、名称、度量、缺字与输出完整性。上游工程已经演进，旧批处理不是当前接口承诺。 |
| [BMFont](https://www.angelcode.com/products/bmfont/) | 从字体生成位图及字符描述，支持配置与命令行。已读包内 8 份 HTML 文档及 readme；纹理通道、字形度量、分页和边距都影响回写。 |
| [Notepad++](https://github.com/notepad-plus-plus/notepad-plus-plus) | 文本编辑辅助工具，不是游戏资源解析器；不需要把安装程序作为模块运行依赖。 |
| [UnityEX](https://forum.zoneofgames.ru/topic/36240-unityex/) | 包内包含主程序、批处理、纹理、二进制文本、CSV、字体及 metadata 辅助工具，已递归列出。论坛本次返回 502；不能把包内旧命令行参数当作所有版本的稳定接口。 |
| [UnityTranz / CS2CSV](https://github.com/Helly0000/UnityTranz) | 上游本次返回 404；包内 3 个 Python、BAT、INI 均已读。仅针对特定 `this.AddRow(...)` 源码形式，不是通用 C# / DLL 文本提取器；累计 MD5 与遍历顺序还会影响标识。 |
| [UABEA](https://github.com/nesrak1/UABEA) | 基于 AssetsTools.NET 等组件的资源查看和编辑器。上游说明提醒 Addressables Catalog CRC 可能影响修改后的资源加载；回写 Bundle 本身成功不代表游戏能加载。 |
| [FilterRepeatCharacter](https://blog.csdn.net/Heroan1123/article/details/102749051) | 上游文章本次不可取得，已读包内去重脚本和合并批处理。保序去重思路可参考；原脚本存在只处理首层目录及参数处理问题，不宜原样调用。 |
| [UAAE](https://github.com/Igor55x/UAAE) | 上游本次返回 404，已核对包内说明、类型数据库和构成。旧版本声明的支持范围不能推导为支持全部当前 Unity 版本。 |
| [Il2CppAssemblyUnhollower](https://github.com/knah/Il2CppAssemblyUnhollower) | 生成运行时托管代理，不是离线资源翻译器。已读上游说明；旧项目停止维护并指向 Il2CppInterop，不能与静态 metadata 回写混用。 |
| [MelonLoader](https://github.com/LavaGang/MelonLoader) | Mono / IL2CPP 模组加载器，可作为运行时路线的基础设施。已读旧包与上游说明并登记附带组件；运行时可能需要生成代理或下载依赖，离线部署必须另做依赖准备。 |

另外核对了 README 来源表没有单独列出的 [ILSpy](https://github.com/icsharpcode/ILSpy)、[Reflexil](https://github.com/sailro/Reflexil) 和 [010 Editor](https://www.sweetscape.com/010editor/)。Reflexil 已停止维护。010 Editor 包标为“汉化特别版”，不执行、不作为可分发组件；需要的格式信息应从合法上游说明和适当许可的实现取得。

## UnityL10nTool 内部全部 7 个核心插件

已逐份阅读插件主实现，而不是只阅读项目首页。模板数据与生成的 DLL 入口不等同于独立业务插件。

| 类型 | 插件 | 核心行为与边界 |
| --- | --- | --- |
| 文本 | `RawULTTextPlugin` | 原始文本导出、导入；无结构化语义识别。 |
| 文本 | `GetTextPoULTTextPlugin` | PO 的上下文、原文、译文映射；不能默认覆盖所有复数或转义情况。 |
| 文本 | `JsonULTTextPlugin` | 根据配置路径定位数组、键和值；不是把所有 JSON 字符串一律翻译。旧实现的路径遍历与空数组处理不能直接复用。 |
| 文本 | `RegExpULTTextPlugin` | 通过用户配置的捕获和替换处理特定文本；无法自动识别所有自定义格式。 |
| 字体 | `UnityDefaultFontULTFontPlugin` | 替换 FontData，处理字符矩形等字段，并依赖对应版本的类型布局；不是任意位置覆盖 TTF 字节。 |
| 字体 | `NGUIFontULTFontPlugin` | 处理 UIFont、字形表、Atlas、Material、Texture2D 及文件内外引用；替换字体图片本身不够。 |
| 字体 | `TMPFontAssetULTFontPlugin` | FontAsset、材质、纹理、fallback、TMPSettings、PathID、外部引用与资源流；包含不同 TMP 布局和覆盖模式。 |

阅读范围覆盖以上 7 个插件的主要 `.cpp` 文件及 TMP 资源结构头文件；未把完整上游的第三方库、自动生成项目文件称为逐行审计完成。

## 压缩包递归清单

| 压缩包 | 条目数 |
| --- | ---: |
| dnSpy-netframework.zip | 456 |
| ILSpy_withReflexil_7.1.0.6587.zip | 43 |
| AssetsBundleExtractor_2.2stabled_64bit.zip | 42 |
| AssetStudio.v0.16.0.zip | 34 |
| UAAE_20210812.zip | 24 |
| UABEA_202100811.zip | 178 |
| UnityEX.zip | 13 |
| bmfont1.14a.zip | 16 |
| FilterRepeatCharacter.zip | 6 |
| FontMergeSupplementaryTools.zip | 17 |
| UnityL10nTool_v0.1.29.zip | 91 |
| UnityTranz.zip | 6 |
| Il2CppAssemblyUnhollower.0.4.15.4.zip | 9 |
| Il2CppDumper-v6.6.5.zip | 15 |
| MelonLoader.x64-v0.4.3.zip | 162 |
| 010Editor v11.0.1 汉化特别版.zip | 47 |
| UnityEX.zip → UnityEX.rar | 1 |
| UnityEX.zip → UnityEX_BAT.rar | 52 |
| UnityEX.zip → ParserTextBinUnity.rar | 13 |
| UnityEX.zip → Parser_UMDcpp2txt.rar | 4 |
| UnityEX.zip → Export_binary_TEXT.rar | 40 |
| UnityEX.zip → Parser_ULS.rar | 5 |
| UnityEX.zip → fntxml_to_unityfnt.rar | 33 |
| UnityEX.zip → unPacker_CSV.rar | 10 |
| 010Editor…zip → Data/010Repository.zip | 366 |
| 010Editor…zip → Data/Sample.zip | 3 |
| UnityEX.zip → UnityEX_BAT.rar → ConverterTexsture.rar | 12 |
| UnityEX.zip → fntxml_to_unityfnt.rar → EvilGenome.rar | 2 |
| UnityEX.zip → fntxml_to_unityfnt.rar → Freedom Planet 2.rar | 4 |
| UnityEX.zip → fntxml_to_unityfnt.rar → sharedassets0.zip | 5 |

UnityEX 的内层批处理包括导入、导出、Bundle 拆装、UGUI / MonoBehaviour 文本、IL2CPP 字面量、CSV / TSV、FNT 转换和纹理转换。存在按游戏写死的字节偏移，以及原地覆盖、删除目录的命令；仅阅读，没有执行。示例素材只是特定游戏和版本的样本，不能作为通用结构定义。

010 Editor 附带库中 `FNT.v0.1.bt` 实际解析 Windows `.FNT`，并非 BMFont 描述。`UnityMetadata.v0.1.bt` 使用固定旧布局，且程序集、类型数组的数量表达式引用了不匹配的表字段，不能照搬。TTF / OpenType 等通用模板已登记用途，但不是经过运行验证的字体生成方案。`010Repository.xml` 也不能直接作为单根 XML 文档解析。

## 教程外链清单

[文字教程原始入口](https://www.cnblogs.com/guobaoxu/p/12055930.html) 已核对，与仓库 Word 的主要主题一致。下面的视频链接没有遗漏，但本次未能取得完整视听内容或字幕：

| 教程 | 链接 |
| --- | --- |
| Mono / Assembly-CSharp | https://www.bilibili.com/video/BV12K4y1j7w7/ |
| IL2CPP / global-metadata | https://www.bilibili.com/video/BV1Pa411w73y/ |
| MonoBehaviour | https://www.bilibili.com/video/BV1k54y1z7oY/ |
| TextAsset | https://www.bilibili.com/video/BV195411V7GD/ |
| Texture2D | https://www.bilibili.com/video/BV1kz4y1y72z/ |
| Unity Default Font / UGUI | https://www.bilibili.com/video/BV1Pa411w79B/ |
| TMP Font Asset | https://www.bilibili.com/video/BV1D5411V7MK/ |
| NGUI Font Asset | https://www.bilibili.com/video/BV1y5411V7rf/ |
| RAW 与十六进制字符串 | https://www.bilibili.com/video/BV12y4y1q7Yv/ |

## 对模块实现的直接影响

### 文本与资源

自动化至少需要区分外部文本文件、TextAsset、自定义 MonoBehaviour、Mono 程序集中的 `ldstr`、IL2CPP 字符串字面量、图片文字。不同来源需要不同解析与回写方法。不能搜索全部可打印字符串后无差别替换；资源名、脚本标识、JSON 键、路径、格式占位符和富文本标签必须保持语义。

IL2CPP 的字符串字面量表与类型、方法等元数据名称表不是一回事。译文 UTF-8 字节长度变化时，需要更新长度、偏移及数据区域，保持其他元数据不变。固定布局与未保护的旧样例不能证明支持所有版本。

序列化回写必须维护 `fileID/pathID`、外部引用、类型布局、资源流及 Bundle 结构。Addressables 还需要检查 Catalog 一致性。导出成功、保存成功、游戏成功加载、文本实际显示是四个不同的验证阶段。

### 字体与嵌字

UGUI、NGUI 和 TMP 必须分开处理。UGUI 主要涉及 Font 数据及布局；NGUI 涉及位图字形表、材质和图集；TMP 还涉及 SDF 图集、字形/字符表、fallback、材质属性与 TMP 版本。合并 TTF 本身不能完成后三者的资源替换。

应根据原文和实际译文生成所需码点集合，保留原游戏需要的字符并检查缺字、图集容量、行高、字距、裁切及描边。不能用“已放入中文字体文件”代替字体引用与显示验证。

### 翻译阶段与游戏运行

翻译服务允许在线 API 或本机模型；项目中只保存模型标识与翻译结果，不复制凭证。静态资源补丁在生成后可独立使用；运行时插件则属于另一路线，可按模型与配置决定是否联网。现有运行时翻译功能不应被改名后冒充资源回写功能。

### 首版验收边界

首版需要有可检查的扫描结果、文本来源标识、翻译映射、字体覆盖检查、独立补丁输出和恢复清单。未支持的自定义格式、字体布局或资源保护必须明确列出，不显示“全部完成”。原始游戏目录不应成为试验性回写的唯一副本。

目前仅完成上述资料核对与核心流程研究，尚未新增嵌字翻译实现，也没有进行真实游戏加载或显示验证。库的实际版本、许可和回写 API 应在选定实现依赖时继续核实，不直接打包仓库内的旧工具集合。

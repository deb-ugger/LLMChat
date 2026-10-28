using AssetsTools.NET;
using System.Text;

namespace LLMChat.UnityOffline;

public sealed record FontReference(string Field, int FileId, string PathId);
public sealed record FontPlan(string Folder, int CharacterCount, int OriginalReferences, int TranslatedReferences, bool FontChecked, int[] Missing, FontInfo[] Fonts, string[] Requirements);
public static class FontPreparation
{
    public const string Marker = ".llmchat-font-plan";
    public static string[] Requirements(IEnumerable<FontInfo> fonts)
    {
        var kinds = fonts.Select(font => font.Kind).ToArray();
        var tmp = kinds.Any(kind => kind.StartsWith("TMP", StringComparison.Ordinal));
        var ngui = kinds.Any(kind => kind.StartsWith("NGUI", StringComparison.Ordinal));
        var result = new List<string> { "文本提取、翻译、普通文本补丁和已识别的 UGUI 字体替换无需 Unity Editor。" };
        if (!tmp && !ngui) return result.ToArray();
        if (tmp) result.Add("TMP：选择替换字体后原生生成单图集字库，支持 m_GlyphTable / m_CharacterTable 布局，保留材质与对象引用；旧版、跨文件引用及多图集会报告具体原因。");
        if (ngui) result.Add("NGUI：选择替换字体后原生生成独立 BMFont 位图与字形数据；共享 UIAtlas、图标符号、动态或引用字库需处理对应源资源，不覆盖共享图片。");
        result.Add("原生字库生成无需 Unity Editor；支持静态 TTF / OTF 及 BMP 字符。生成后重读校验字库、纹理与材质，实际显示仍需用游戏验证。");
        return result.ToArray();
    }

    public static List<FontReference> References(AssetTypeValueField root)
    {
        var references = new List<FontReference>();
        void Walk(AssetTypeValueField field, string path)
        {
            if (field.TemplateField.Type.StartsWith("PPtr<", StringComparison.Ordinal)) {
                if (!field["m_FileID"].IsDummy && !field["m_PathID"].IsDummy) references.Add(new(path, field["m_FileID"].AsInt, field["m_PathID"].AsLong.ToString()));
                return;
            }
            for (var i = 0; i < field.Children.Count; i++) Walk(field.Children[i], path + "/" + (field.TemplateField.IsArray ? i.ToString() : field.Children[i].FieldName));
        }
        Walk(root, ""); return references;
    }

    public static FontPlan Create(Request request, bool report = true)
    {
        var project = request.Project ?? throw new Exception("请先扫描资源");
        if (!Directory.Exists(project.Folder)) throw new Exception("工程目录不存在");
        var folder = Path.Combine(project.Folder, "font-plan"); Directory.CreateDirectory(folder);
        var ownership = Path.Combine(folder, Marker);
        if (!File.Exists(ownership) && Directory.EnumerateFileSystemEntries(folder).Any()) throw new Exception("字库目录包含未知文件，未覆盖：" + folder);
        File.WriteAllText(ownership, "llmchat-font-plan-v1");
        var incomplete = Path.Combine(folder, "INCOMPLETE.txt"); File.WriteAllText(incomplete, "字库检查尚未完成，请重新检查后使用输出。");
        Program.CheckStop(request, "");
        var selected = request.SelectedIds?.ToHashSet(StringComparer.Ordinal);
        var characters = new SortedSet<int>(Enumerable.Range(32, 95)); var originals = 0; var translations = 0;
        foreach (var entry in project.Entries) {
            Program.CheckStop(request, "");
            var translated = entry.Selected && (selected == null || selected.Contains(entry.Id)) && TranslationIntegrity.Validate(entry.Source, entry.Translation).Length == 0;
            if (translated) translations++; else originals++;
            foreach (var rune in TranslationIntegrity.Visible(translated ? entry.Translation : entry.Source).EnumerateRunes())
                if (!Rune.IsControl(rune) && !Rune.IsWhiteSpace(rune)) characters.Add(rune.Value);
        }
        foreach (var rune in request.ExtraCharacters.EnumerateRunes()) if (!Rune.IsControl(rune)) characters.Add(rune.Value);
        var text = string.Concat(characters.Select(char.ConvertFromUtf32));
        var missing = request.FontPath.Length > 0 ? FontCoverage.Missing(File.ReadAllBytes(request.FontPath), text).ToArray() : [];
        var requirements = Requirements(project.Fonts).ToList();
        if (request.FontPath.Length == 0) requirements.Add("尚未选择替换字体；已生成实际字符集，可用于补字或制作图集。");
        if (missing.Length > 0) requirements.Add($"所选字体缺少 {missing.Length} 个字符，不能用于这些文本的完整显示。");
        requirements.Add("动态变量可能生成额外字符，可在补充字符中加入角色名等内容；字符集覆盖不等于游戏排版已验证。");
        var plan = new FontPlan(folder, characters.Count, originals, translations, request.FontPath.Length > 0, missing, project.Fonts.ToArray(), requirements.ToArray());
        File.WriteAllText(Path.Combine(folder, "characters.txt"), text, new UTF8Encoding(false));
        Program.WriteJson(Path.Combine(folder, "font-plan.json"), plan);
        File.WriteAllText(Path.Combine(folder, "字库检查.txt"), $"字符数：{characters.Count}\n使用译文：{translations} 处；保留原文：{originals} 处\n" + string.Join("\n", requirements) + "\n缺字：" + string.Join(" ", missing.Select(c => $"{char.ConvertFromUtf32(c)} U+{c:X4}")), new UTF8Encoding(false));
        File.Delete(incomplete);
        if (report) Program.Progress($"字符集已保存：{characters.Count} 个字符，{(plan.FontChecked ? missing.Length + " 个缺字" : "未选择字体")}", characters.Count, characters.Count, folder);
        return plan;
    }
}

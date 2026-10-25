using AssetsTools.NET;
using AssetsTools.NET.Extra;
using System.Text.RegularExpressions;

namespace LLMChat.UnityOffline;

public static class GameText
{
    static readonly Regex TechnicalField = new(@"^(?:m_Name|m_EditorClassIdentifier|.*(?:Key|Guid|Path|Address|File|SceneName|AnimationName|SpriteName|DialogueName|Id))$", RegexOptions.IgnoreCase);
    static readonly Regex TextField = new(@"text|message|dialog|sentence|description|caption|title|displayName|speakerName|characterName|label|content|body|choice|prompt", RegexOptions.IgnoreCase);
    public static bool Visible(string field, string value)
    {
        if (!Program.TextCandidate(value) || TechnicalField.IsMatch(field)) return false;
        if (Regex.IsMatch(value.Trim(), @"^(?:[\w.-]+[/\\])+[\w .-]+$|^\d+(?:\.\d+)*[abfp]\d+$")) return false;
        if (Regex.IsMatch(value, "[ぁ-ゖァ-ヺ一-鿿가-힣]")) return true;
        return TextField.IsMatch(field) || !Regex.IsMatch(value.Trim(), @"^[a-zA-Z0-9_.$+:/\\-]+$");
    }
    public static bool PlainFile(string root, string relative)
    {
        var name = Path.GetFileNameWithoutExtension(relative);
        if (Regex.IsMatch(name, @"readme|changelog|licen[sc]e|manual|说明|简介|更新|素材|クレジット|credit|^catalog|^settings$|^ScriptingAssemblies$|^RuntimeInitializeOnLoads$", RegexOptions.IgnoreCase)) return false;
        var parts = relative.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        if (parts.Any(p => p is "Managed" or "MonoBleedingEdge" or "BepInEx" or "MelonLoader")) return false;
        if (!Directory.EnumerateDirectories(root, "*_Data", SearchOption.TopDirectoryOnly).Any()) return true;
        return parts.Any(p => p is "StreamingAssets" or "Resources") || Regex.IsMatch(name, @"dialog|scenario|story|locali[sz]|strings|subtitle", RegexOptions.IgnoreCase);
    }
    public static bool TextAsset(string name) => !Regex.IsMatch(name, @"BuildReport|BuildInfo|ScriptingAssemblies|RuntimeInitializeOnLoads|UnityConnect|PackageInfo", RegexOptions.IgnoreCase);
    public static void VisitStrings(AssetTypeValueField field, Action<string, string, Action<string>> visit, string path = "")
    {
        if (field.TemplateField.ValueType == AssetValueType.String) {
            if (Visible(field.FieldName, field.AsString)) visit(path, field.AsString, text => field.AsString = text);
            return;
        }
        if (field.TemplateField.Type.StartsWith("PPtr<", StringComparison.Ordinal) || field.TemplateField.ValueType == AssetValueType.ByteArray) return;
        for (var i = 0; i < field.Children.Count; i++) {
            var child = field.Children[i];
            var key = field.TemplateField.IsArray ? i.ToString() : child.FieldName.Replace("~", "~0").Replace("/", "~1");
            VisitStrings(child, visit, path + "/" + key);
        }
    }
}

public sealed class GameTypes(string root) : IDisposable
{
    readonly Dictionary<string, MonoCecilTempGenerator> generators = new(StringComparer.OrdinalIgnoreCase);
    public void Configure(AssetsManager manager, string relative)
    {
        string? managed = null;
        for (var folder = Path.GetDirectoryName(Program.Within(root, relative)); folder != null; folder = Path.GetDirectoryName(folder)) {
            var candidate = Path.Combine(folder, "Managed");
            if (Directory.Exists(candidate)) { managed = candidate; break; }
            if (string.Equals(folder.TrimEnd('\\', '/'), Path.GetFullPath(root).TrimEnd('\\', '/'), StringComparison.OrdinalIgnoreCase)) break;
        }
        if (managed == null) return;
        if (!generators.TryGetValue(managed, out var generator)) generators[managed] = generator = new MonoCecilTempGenerator(managed);
        manager.MonoTempGenerator = generator;
    }
    public void Dispose() { foreach (var generator in generators.Values) generator.Dispose(); }
}

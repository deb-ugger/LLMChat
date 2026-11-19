using AssetsTools.NET;
using Mono.Cecil;

namespace LLMChat.UnityOffline;

public static class GameLocalization
{
    static readonly Dictionary<string, Dictionary<string, Dictionary<int, string>>> enums = new(StringComparer.OrdinalIgnoreCase);
    static readonly Dictionary<string, string> defaults = new(StringComparer.OrdinalIgnoreCase);
    static readonly Dictionary<string, Dictionary<string, Dictionary<int, string>>> files = new(StringComparer.OrdinalIgnoreCase);
    static string NamedLocale(string name) => name.ToLowerInvariant().Replace("_", "") switch {
        "english" => "en", "japanese" => "ja", "korean" => "ko", "chinese" or "simplifiedchinese" or "chinesesimplified" => "zh-CN",
        "traditionalchinese" or "chinesetraditional" => "zh-TW", "french" => "fr", "german" => "de", "spanish" => "es", _ => ""
    };
    static Dictionary<string, Dictionary<int, string>> Languages(string root, string relative)
    {
        var identity = root + "\n" + relative;
        if (files.TryGetValue(identity, out var cached)) return cached;
        string? path = null;
        for (var dir = Path.GetDirectoryName(Program.Within(root, relative)); dir != null; dir = Path.GetDirectoryName(dir)) {
            var candidate = Path.Combine(dir, "Managed", "Assembly-CSharp.dll");
            if (File.Exists(candidate)) { path = candidate; break; }
            if (Path.GetFullPath(dir).Equals(Path.GetFullPath(root), StringComparison.OrdinalIgnoreCase)) break;
        }
        if (path == null) return files[identity] = [];
        if (enums.TryGetValue(path, out var result)) return files[identity] = result;
        result = []; using var module = ModuleDefinition.ReadModule(path);
        foreach (var type in module.GetTypes()) foreach (var field in type.Fields.Where(f => f.Name.Equals("language", StringComparison.OrdinalIgnoreCase) && f.FieldType.Scope == module)) {
            var definition = module.GetType(field.FieldType.FullName); if (definition?.IsEnum != true) continue;
            var map = definition.Fields.Where(f => f.HasConstant && NamedLocale(f.Name).Length > 0).ToDictionary(f => Convert.ToInt32(f.Constant), f => NamedLocale(f.Name));
            if (map.Count > 0) result[type.Name] = map;
        }
        enums[path] = result; return files[identity] = result;
    }
    public static void Visit(AssetTypeValueField root, string game, string file, Action<string, string, string, string> visit)
    {
        var languages = Languages(game, file);
        if (!defaults.TryGetValue(game, out var defaultLocale)) {
            defaultLocale = ""; var release = Path.Combine(game, "release-manifest.json");
            if (File.Exists(release)) { using var json = System.Text.Json.JsonDocument.Parse(File.ReadAllText(release)); if (json.RootElement.TryGetProperty("locale", out var language)) defaultLocale = language.GetString() ?? ""; }
            defaults[game] = defaultLocale;
        }
        void Walk(AssetTypeValueField field, string path, string locale, string key) {
            if (GameText.EditorEventDescription(root, path)) return;
            if (field.TemplateField.Type.StartsWith("PPtr<", StringComparison.Ordinal) || field.TemplateField.ValueType == AssetValueType.ByteArray) return;
            if (field.TemplateField.ValueType == AssetValueType.String) {
                var named = field.FieldName;
                var text = field.AsString;
                if (!GameText.Visible(named, text)) return;
                if (named.StartsWith("Chinese", StringComparison.OrdinalIgnoreCase)) locale = "zh-CN";
                else if (named.StartsWith("Japanese", StringComparison.OrdinalIgnoreCase)) locale = "ja";
                else if (named.StartsWith("English", StringComparison.OrdinalIgnoreCase)) locale = "en";
                else if (named.StartsWith("Korean", StringComparison.OrdinalIgnoreCase)) locale = "ko";
                visit(path, text, locale, key);
                return;
            }
            if (field.Children.Count == 0) return;
            if (field.TemplateField.Type == "DialogueLine" && locale.Length == 0) locale = defaultLocale;
            if (languages.TryGetValue(field.TemplateField.Type, out var map)) {
                var language = field["language"];
                if (!language.IsDummy && map.TryGetValue(language.AsInt, out var resolved)) locale = resolved;
            }
            var keyField = field["key"];
            if (!keyField.IsDummy && keyField.TemplateField.ValueType == AssetValueType.String && !field["values"].IsDummy) key = keyField.AsString;
            for (var i = 0; i < field.Children.Count; i++) {
                var child = field.Children[i];
                if (child.Children.Count == 0 && child.TemplateField.ValueType != AssetValueType.String) continue;
                var part = field.TemplateField.IsArray ? i.ToString() : child.FieldName.Replace("~", "~0").Replace("/", "~1");
                Walk(child, path + "/" + part, locale, key);
            }
        }
        Walk(root, "", "", "");
    }
}

using System.Buffers.Binary;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using AssetsTools.NET;
using AssetsTools.NET.Extra;
using Mono.Cecil;
using Mono.Cecil.Cil;

namespace LLMChat.UnityOffline;

public sealed record Entry(string Id, string File, string Container, string ObjectId,
    string Locator, string Kind, string Source)
{
    public string Translation { get; set; } = "";
    public bool Selected { get; set; } = true;
    public string Error { get; set; } = "";
}
public sealed record FontInfo(string File, string Container, string ObjectId, string Name, string Kind);
public sealed class Project
{
    public int Version { get; set; } = 1;
    public string Root { get; set; } = "";
    public string Folder { get; set; } = "";
    public List<Entry> Entries { get; set; } = [];
    public List<FontInfo> Fonts { get; set; } = [];
    public List<string> Warnings { get; set; } = [];
    public Dictionary<string, string> Hashes { get; set; } = [];
}
public sealed class Request
{
    public string Root { get; set; } = "";
    public string OutputRoot { get; set; } = "";
    public string Path { get; set; } = "";
    public string FontPath { get; set; } = "";
    public bool IncludeCode { get; set; }
    public Project? Project { get; set; }
}

public static class Program
{
    public static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, WriteIndented = true };
    static readonly UTF8Encoding Utf8 = new(false, true);
    static readonly Regex Tokens = new(@"\{[^{}\r\n]+\}|%(?:\d+\$)?[-+0 #]*\d*(?:\.\d+)?[sdifouxXeEgGc%]|</?[^>\r\n]+>|\\[nrt]", RegexOptions.Compiled);

    public static int Main(string[] args)
    {
        try
        {
            Console.InputEncoding = new UTF8Encoding(false);
            Console.OutputEncoding = new UTF8Encoding(false);
            if (args.Length > 1)
            {
                var parent = Process.GetProcessById(int.Parse(args[1]));
                _ = Task.Run(async () => { await parent.WaitForExitAsync(); Environment.Exit(2); });
            }
            var request = JsonSerializer.Deserialize<Request>(Console.In.ReadToEnd(), Json) ?? throw new Exception("请求为空");
            object result = args[0] switch
            {
                "scan" => Scan(request),
                "load" => Load(request.Path),
                "save" => Save(request.Project ?? throw new Exception("缺少工程")),
                "export" => Export(request),
                _ => throw new Exception("未知操作")
            };
            Console.Out.Write(JsonSerializer.Serialize(result, Json));
            return 0;
        }
        catch (Exception e) { Console.Error.Write(e.Message); return 1; }
    }

    public static string Within(string root, string relative)
    {
        root = System.IO.Path.GetFullPath(root).TrimEnd(System.IO.Path.DirectorySeparatorChar) + System.IO.Path.DirectorySeparatorChar;
        var path = System.IO.Path.GetFullPath(System.IO.Path.Combine(root, relative));
        if (!path.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new Exception("文件路径越过工程目录");
        return path;
    }
    static string Hash(string path) { using var f = File.OpenRead(path); return Convert.ToHexString(SHA256.HashData(f)); }
    static string NewFolder(string output, string name)
    {
        var folder = System.IO.Path.Combine(System.IO.Path.GetFullPath(output), $"{name}-{DateTime.Now:yyyyMMdd-HHmmss}-{Guid.NewGuid():N}");
        Directory.CreateDirectory(folder);
        return folder;
    }
    public static Project Save(Project project)
    {
        if (project.Version != 1 || !Directory.Exists(project.Folder)) throw new Exception("工程版本或目录无效");
        var path = System.IO.Path.Combine(project.Folder, "unity-project.json");
        var temp = path + ".tmp";
        try { File.WriteAllText(temp, JsonSerializer.Serialize(project, Json), Utf8); File.Move(temp, path, true); }
        finally { if (File.Exists(temp)) File.Delete(temp); }
        return project;
    }
    public static Project Load(string path)
    {
        var project = JsonSerializer.Deserialize<Project>(File.ReadAllText(path, Utf8), Json) ?? throw new Exception("工程无效");
        project.Folder = System.IO.Path.GetDirectoryName(System.IO.Path.GetFullPath(path))!;
        if (project.Version != 1) throw new Exception("不支持此工程版本");
        foreach (var e in project.Entries) _ = Within(project.Root, e.File);
        return project;
    }
    public static bool TextCandidate(string text) => text.Length is > 1 and <= 16000 &&
        !text.Any(c => char.IsControl(c) && c is not '\r' and not '\n' and not '\t') &&
        text.Any(char.IsLetter) && !Regex.IsMatch(text.Trim(), @"^(?:https?://|[\w./\\-]+\.(?:png|jpg|asset|prefab|dll)|[A-Fa-f0-9]{16,}$)");
    public static void ValidateTranslation(string source, string translation)
    {
        if (string.IsNullOrWhiteSpace(translation)) throw new Exception("译文为空");
        var a = Tokens.Matches(source).Select(m => m.Value).Order().ToArray();
        var b = Tokens.Matches(translation).Select(m => m.Value).Order().ToArray();
        if (!a.SequenceEqual(b)) throw new Exception("译文中的占位符、转义或富文本标签与原文不一致");
    }
    static void Add(Project project, string file, string container, long objectId, string locator, string kind, string text)
    {
        if (TextCandidate(text)) project.Entries.Add(new Entry($"{project.Entries.Count + 1}", file, container, objectId.ToString(), locator, kind, text));
    }
    // JSON keys and identifier/path fields are never translated. Locators remain structural, not text-based.
    static void JsonStrings(JsonNode? node, string path, Action<string, string, Action<string>> visit)
    {
        if (node is JsonObject obj)
            foreach (var kv in obj.ToArray())
            {
                if (Regex.IsMatch(kv.Key, @"^(?:id|key|nameId|path|asset|guid|type|url|file|sprite|font)$", RegexOptions.IgnoreCase)) continue;
                var key = kv.Key;
                if (kv.Value is JsonValue v && v.TryGetValue<string>(out var s)) visit(path + "/" + key.Replace("~", "~0").Replace("/", "~1"), s, next => obj[key] = next);
                else JsonStrings(kv.Value, path + "/" + key.Replace("~", "~0").Replace("/", "~1"), visit);
            }
        else if (node is JsonArray array)
            for (var i = 0; i < array.Count; i++)
            {
                var index = i;
                if (array[i] is JsonValue v && v.TryGetValue<string>(out var s)) visit(path + "/" + i, s, next => array[index] = next);
                else JsonStrings(array[i], path + "/" + i, visit);
            }
    }
    public static string TextDocument(string text, Action<string, string, Action<string>> visit)
    {
        if (text.StartsWith('\uFEFF')) return "\uFEFF" + TextDocument(text[1..], visit);
        if (text.TrimStart().StartsWith('{') || text.TrimStart().StartsWith('['))
        {
            var node = JsonNode.Parse(text) ?? throw new Exception("JSON 文本为空");
            JsonStrings(node, "", visit);
            return node.ToJsonString(new JsonSerializerOptions { WriteIndented = true, Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping });
        }
        if (text.Contains('\0')) throw new Exception("不是 UTF-8 文本");
        var lines = Regex.Split(text, "(\r\n|\n|\r)");
        for (var i = 0; i < lines.Length; i += 2)
        {
            var index = i;
            visit("line/" + i / 2, lines[i], next => lines[index] = next);
        }
        return string.Concat(lines);
    }

    public static Project Scan(Request request)
    {
        var root = System.IO.Path.GetFullPath(request.Root);
        if (!Directory.Exists(root)) throw new Exception("游戏目录不存在");
        var output = System.IO.Path.GetFullPath(request.OutputRoot);
        if ((output.TrimEnd('\\', '/') + "/").Replace('\\', '/').StartsWith((root.TrimEnd('\\', '/') + "/").Replace('\\', '/'), StringComparison.OrdinalIgnoreCase))
            throw new Exception("输出目录不能位于游戏目录中，请在 Unity 设置中调整输出目录");
        var project = new Project { Root = root };
        var options = new EnumerationOptions { RecurseSubdirectories = true, AttributesToSkip = FileAttributes.ReparsePoint, IgnoreInaccessible = false };
        foreach (var path in Directory.EnumerateFiles(root, "*", options))
        {
            var rel = System.IO.Path.GetRelativePath(root, path);
            var name = System.IO.Path.GetFileName(path);
            var ext = System.IO.Path.GetExtension(path).ToLowerInvariant();
            var isCode = request.IncludeCode && (name.Equals("global-metadata.dat", StringComparison.OrdinalIgnoreCase) || name.StartsWith("Assembly-CSharp", StringComparison.OrdinalIgnoreCase) && ext == ".dll");
            var asset = ext is ".assets" or ".bundle" or ".unity3d" or ".ab" || name is "resources.assets" or "globalgamemanagers" || Regex.IsMatch(name, @"^(level\d+|CAB-[0-9a-f]+)$", RegexOptions.IgnoreCase);
            var plain = ext is ".txt" or ".json" && !rel.Split(System.IO.Path.DirectorySeparatorChar).Any(p => p is "MonoBleedingEdge" or "BepInEx" or "MelonLoader");
            if (!isCode && !asset && !plain) continue;
            var before = project.Entries.Count;
            var fonts = project.Fonts.Count;
            try
            {
                if (isCode && ext == ".dll") ScanAssembly(path, rel, project);
                else if (isCode) VisitMetadata(File.ReadAllBytes(path), (loc, text, _) => Add(project, rel, "", 0, loc, "IL2CPP 字面量", text));
                else if (asset) VisitResource(path, (am, inst, container) => ScanAssets(am, inst, rel, container, project));
                else TextDocument(File.ReadAllText(path, Utf8), (loc, text, _) => Add(project, rel, "", 0, loc, "文本文件", text));
                if (project.Entries.Count > before || project.Fonts.Count > fonts) project.Hashes[rel] = Hash(path);
            }
            catch (Exception e)
            {
                project.Entries.RemoveRange(before, project.Entries.Count - before);
                project.Fonts.RemoveRange(fonts, project.Fonts.Count - fonts);
                project.Warnings.Add($"{rel}：{e.Message}");
            }
        }
        project.Warnings.Add("图片文字、加密资源、未识别的自定义文本格式不在本次自动回写范围内。");
        if (Directory.EnumerateFiles(root, "catalog*.json", options).Any()) project.Warnings.Add("检测到 Addressables Catalog；首版不改写 Catalog / CRC，相关 Bundle 补丁需要游戏加载验证。");
        project.Folder = NewFolder(output, "unity-project");
        return Save(project);
    }
    static void ScanAssembly(string path, string rel, Project project)
    {
        using var module = ModuleDefinition.ReadModule(path);
        if (module.Assembly?.Name.HasPublicKey == true) throw new Exception("已签名程序集暂不回写");
        foreach (var type in AllTypes(module.Types))
            foreach (var method in type.Methods.Where(m => m.HasBody))
                foreach (var ins in method.Body.Instructions.Where(i => i.OpCode == OpCodes.Ldstr))
                    Add(project, rel, "", 0, $"{method.MetadataToken.ToUInt32()}:{ins.Offset}", "Mono 字面量", (string)ins.Operand);
    }
    static IEnumerable<TypeDefinition> AllTypes(IEnumerable<TypeDefinition> types)
    {
        foreach (var type in types) { yield return type; foreach (var child in AllTypes(type.NestedTypes)) yield return child; }
    }
    public static byte[] VisitMetadata(byte[] bytes, Action<string, string, Action<string>> visit)
    {
        if (bytes.Length < 32 || BinaryPrimitives.ReadUInt32LittleEndian(bytes) != 0xFAB11BAF) throw new Exception("IL2CPP metadata 文件头无效或已加密");
        int I(int p) => BinaryPrimitives.ReadInt32LittleEndian(bytes.AsSpan(p, 4));
        var version = I(4);
        if (version is < 24 or > 31) throw new Exception($"首版未验证 metadata 版本 {version}");
        var table = I(8); var count = I(12); var data = I(16); var length = I(20);
        if (table < 32 || count < 0 || count % 8 != 0 || (long)table + count > bytes.Length || data < (long)table + count || length < 0 || (long)data + length > bytes.Length)
            throw new Exception("IL2CPP 字符串表边界无效");
        using var translated = new MemoryStream();
        var changed = false;
        for (var i = 0; i < count / 8; i++)
        {
            var n = I(table + i * 8); var offset = I(table + i * 8 + 4);
            if (n < 0 || offset < 0 || (long)offset + n > length) throw new Exception("IL2CPP 字符串范围无效");
            var text = Utf8.GetString(bytes, data + offset, n); var next = text;
            visit(i.ToString(), text, s => { next = s; changed |= s != text; });
            var encoded = Utf8.GetBytes(next);
            BinaryPrimitives.WriteInt32LittleEndian(bytes.AsSpan(table + i * 8), encoded.Length);
            BinaryPrimitives.WriteInt32LittleEndian(bytes.AsSpan(table + i * 8 + 4), checked((int)translated.Position));
            translated.Write(encoded);
        }
        if (!changed) return bytes;
        var start = checked((bytes.Length + 3) & ~3);
        var result = new byte[checked(start + (int)translated.Length)];
        bytes.CopyTo(result, 0); translated.ToArray().CopyTo(result, start);
        BinaryPrimitives.WriteInt32LittleEndian(result.AsSpan(16), start);
        BinaryPrimitives.WriteInt32LittleEndian(result.AsSpan(20), checked((int)translated.Length));
        return result;
    }

    static void VisitResource(string path, Action<AssetsManager, AssetsFileInstance, string> visit, string? destination = null)
    {
        var am = new AssetsManager();
        try
        {
            var tpk = System.IO.Path.Combine(AppContext.BaseDirectory, "classdata.tpk");
            if (File.Exists(tpk)) am.LoadClassPackage(tpk);
            using var header = File.OpenRead(path); var signature = new byte[8]; header.ReadExactly(signature); header.Close();
            if (Encoding.ASCII.GetString(signature).StartsWith("Unity"))
            {
                var bundle = am.LoadBundleFile(path, true);
                for (var i = 0; i < bundle.file.BlockAndDirInfo.DirectoryInfos.Count; i++)
                {
                    var inst = am.LoadAssetsFileFromBundle(bundle, i, false);
                    if (inst == null) continue;
                    visit(am, inst, bundle.file.GetFileName(i));
                    if (destination != null) bundle.file.BlockAndDirInfo.DirectoryInfos[i].SetNewData(inst.file);
                }
                if (destination != null) { using var writer = new AssetsFileWriter(destination); bundle.file.Write(writer); }
            }
            else
            {
                var inst = am.LoadAssetsFile(path, false); visit(am, inst, "");
                if (destination != null) { using var writer = new AssetsFileWriter(destination); inst.file.Write(writer); }
            }
        }
        finally { am.UnloadAll(); }
    }
    static void PrepareTypes(AssetsManager am, AssetsFileInstance inst)
    {
        if (!inst.file.Metadata.TypeTreeEnabled)
        {
            if (am.ClassPackage == null) throw new Exception("缺少 Unity 类型数据库，请重新准备嵌字组件");
            am.LoadClassDatabaseFromPackage(inst.file.Metadata.UnityVersion);
        }
    }
    public static void SetFontData(AssetTypeValueField array, byte[] bytes)
    {
        var old = array.TemplateField;
        if (!old.IsArray || old.Children.Count != 2 || old.Children[1].ValueType is not (AssetValueType.Int8 or AssetValueType.UInt8))
            throw new Exception("字体数据不是字节数组");
        // Unity FontData can be serialized as signed char[], while the library only
        // automatically uses its compact byte representation for unsigned arrays.
        array.TemplateField = new AssetTypeTemplateField { Name = old.Name, Type = old.Type, Version = old.Version,
            ValueType = AssetValueType.ByteArray, IsArray = true, IsAligned = old.IsAligned, HasValue = true, Children = old.Children };
        array.Value = new AssetTypeValue(bytes, false);
        array.Children.Clear();
    }
    static void ScanAssets(AssetsManager am, AssetsFileInstance inst, string rel, string container, Project project)
    {
        PrepareTypes(am, inst);
        foreach (var info in inst.file.Metadata.AssetInfos)
        {
            var type = info.TypeId;
            if (type is not (49 or 128 or 114)) continue;
            try
            {
                if (type == 114 && !inst.file.Metadata.TypeTreeEnabled) continue;
                var field = am.GetBaseField(inst, info);
                var name = field["m_Name"].IsDummy ? info.PathId.ToString() : field["m_Name"].AsString;
                if (type == 128) project.Fonts.Add(new FontInfo(rel, container, info.PathId.ToString(), name, "UGUI"));
                if (type == 49)
                    TextDocument(Utf8.GetString(field["m_Script"].AsByteArray), (loc, text, _) => Add(project, rel, container, info.PathId, loc, "TextAsset", text));
                if (type == 114)
                {
                    if (!field["m_Text"].IsDummy && field["m_Text"].Value?.ValueType == AssetValueType.String)
                        Add(project, rel, container, info.PathId, "m_Text", "UI 文本", field["m_Text"].AsString);
                    if (!field["m_CharacterTable"].IsDummy || !field["m_glyphInfoList"].IsDummy)
                        project.Fonts.Add(new FontInfo(rel, container, info.PathId.ToString(), name, "TMP（需兼容图集）"));
                    else if (!field["mFont"].IsDummy) project.Fonts.Add(new FontInfo(rel, container, info.PathId.ToString(), name, "NGUI（需兼容图集）"));
                }
            }
            catch (Exception e) { project.Warnings.Add($"{rel} / {container} / {info.PathId}：{e.Message}"); }
        }
        if (!inst.file.Metadata.TypeTreeEnabled && inst.file.GetAssetsOfType(AssetClassID.MonoBehaviour).Count > 0)
            project.Warnings.Add($"{rel} / {container}：MonoBehaviour 未内嵌类型树，首版未解析其 UI 文本和 TMP / NGUI 字体。");
    }

    public static object Export(Request request)
    {
        var project = request.Project ?? throw new Exception("缺少工程");
        var selected = project.Entries.Where(e => e.Selected).ToArray();
        if (selected.Length == 0) throw new Exception("请先选择需要回写的文本");
        foreach (var entry in selected) ValidateTranslation(entry.Source, entry.Translation);
        byte[]? font = null;
        if (request.FontPath.Length > 0)
        {
            font = File.ReadAllBytes(request.FontPath);
            var missing = FontCoverage.Missing(font, string.Concat(project.Entries.Select(e => e.Source)) + string.Concat(selected.Select(e => e.Translation)));
            if (missing.Count > 0) throw new Exception($"所选字体缺少 {missing.Count} 个字符：{string.Concat(missing.Take(24).Select(char.ConvertFromUtf32))}");
        }
        var fonts = font == null ? [] : project.Fonts.Where(f => f.Kind == "UGUI").ToArray();
        if (font != null && fonts.Length == 0) throw new Exception("未扫描到可替换的 UGUI 字体；TMP / NGUI 图集不能使用此字体替换功能");
        var files = selected.Select(e => e.File).Concat(fonts.Select(f => f.File)).Distinct().ToArray();
        var folder = NewFolder(project.Folder, "patch");
        var marker = System.IO.Path.Combine(folder, "INCOMPLETE.txt");
        File.WriteAllText(marker, "补丁尚未生成完成，不能使用。", Utf8);
        try
        {
            var manifest = new List<object>();
            foreach (var file in files)
            {
                var source = Within(project.Root, file); var original = Within(System.IO.Path.Combine(folder, "original"), file);
                Directory.CreateDirectory(System.IO.Path.GetDirectoryName(original)!); File.Copy(source, original);
                var originalHash = Hash(original);
                if (!project.Hashes.TryGetValue(file, out var expected) || expected != originalHash) throw new Exception($"源文件已变化，请重新扫描：{file}");
                var destination = Within(System.IO.Path.Combine(folder, "patch"), file); Directory.CreateDirectory(System.IO.Path.GetDirectoryName(destination)!);
                var entries = selected.Where(e => e.File == file).ToArray(); var edits = entries.ToDictionary(e => (e.Container, e.ObjectId, e.Locator));
                void Change(string container, long objectId, string loc, string sourceText, Action<string> set)
                {
                    if (!edits.TryGetValue((container, objectId.ToString(), loc), out var entry)) return;
                    if (entry.Source != sourceText) throw new Exception($"原文定位不一致：{file} / {loc}");
                    set(entry.Translation); edits.Remove((container, objectId.ToString(), loc));
                }
                if (entries.Any(e => e.Kind == "Mono 字面量"))
                {
                    using var module = ModuleDefinition.ReadModule(original);
                    if (module.Assembly?.Name.HasPublicKey == true) throw new Exception("已签名程序集不能回写");
                    foreach (var method in AllTypes(module.Types).SelectMany(t => t.Methods).Where(m => m.HasBody))
                        foreach (var ins in method.Body.Instructions.Where(i => i.OpCode == OpCodes.Ldstr))
                            Change("", 0, $"{method.MetadataToken.ToUInt32()}:{ins.Offset}", (string)ins.Operand, s => ins.Operand = s);
                    module.Write(destination);
                }
                else if (entries.Any(e => e.Kind == "IL2CPP 字面量"))
                    File.WriteAllBytes(destination, VisitMetadata(File.ReadAllBytes(original), (loc, text, set) => Change("", 0, loc, text, set)));
                else if (entries.Any(e => e.Kind == "文本文件"))
                    File.WriteAllText(destination, TextDocument(File.ReadAllText(original, Utf8), (loc, text, set) => Change("", 0, loc, text, set)), Utf8);
                else VisitResource(original, (am, inst, container) =>
                {
                    PrepareTypes(am, inst);
                    foreach (var info in inst.file.Metadata.AssetInfos)
                    {
                        var relevant = entries.Where(e => e.Container == container && e.ObjectId == info.PathId.ToString()).ToArray();
                        var replaceFont = fonts.Any(f => f.File == file && f.Container == container && f.ObjectId == info.PathId.ToString());
                        if (relevant.Length == 0 && !replaceFont) continue;
                        var field = am.GetBaseField(inst, info);
                        if (relevant.Any(e => e.Kind == "TextAsset")) field["m_Script"].AsString = TextDocument(field["m_Script"].AsString, (loc, text, set) => Change(container, info.PathId, loc, text, set));
                        else if (relevant.Length > 0) Change(container, info.PathId, "m_Text", field["m_Text"].AsString, s => field["m_Text"].AsString = s);
                        if (replaceFont)
                        {
                            var data = field["m_FontData"]["Array"];
                            if (data.IsDummy) throw new Exception("字体布局不支持替换 FontData");
                            SetFontData(data, font!);
                            if (!field["m_CharacterRects"].IsDummy) field["m_CharacterRects"]["Array"].Children.Clear();
                            if (!field["m_ConvertCase"].IsDummy) field["m_ConvertCase"].AsInt = -2;
                        }
                        info.SetNewData(field);
                    }
                }, destination);
                if (edits.Count != 0) throw new Exception($"部分文本未能回写：{file}");
                manifest.Add(new { file, originalSha256 = originalHash, patchSha256 = Hash(destination), entries = entries.Length });
            }
            Save(project);
            File.WriteAllText(System.IO.Path.Combine(folder, "manifest.json"), JsonSerializer.Serialize(new { version = 1, project.Root, files = manifest, warnings = project.Warnings, fontReplacements = fonts.Length }, Json), Utf8);
            File.WriteAllText(System.IO.Path.Combine(folder, "使用说明.txt"), "先关闭游戏。patch 目录内是按游戏相对路径排列的补丁文件；确认备份后复制到游戏目录。original 目录保存本次修改文件的原件，按相同相对路径复制回去可恢复。manifest.json 记录原件及补丁哈希。\n补丁生成成功不代表已完成游戏加载或显示验证；TMP / NGUI、图片文字、加密资源及 Addressables Catalog 未自动处理。\n", Utf8);
            File.Delete(marker);
            return new { folder, files = files.Length, entries = selected.Length, fontReplacements = fonts.Length };
        }
        catch (Exception e) { File.WriteAllText(marker, "补丁生成失败，不可使用：" + e.Message, Utf8); throw new Exception($"{e.Message}；未完成输出：{folder}"); }
    }
}

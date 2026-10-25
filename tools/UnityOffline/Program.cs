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
    public int ScanRevision { get; set; }
    public string Root { get; set; } = "";
    public string Folder { get; set; } = "";
    public List<Entry> Entries { get; set; } = [];
    public List<FontInfo> Fonts { get; set; } = [];
    public List<string> Warnings { get; set; } = [];
    public Dictionary<string, string> Hashes { get; set; } = [];
}
public sealed class Request
{
    public string StopFile { get; set; } = "";
    public string Root { get; set; } = "";
    public string OutputRoot { get; set; } = "";
    public string Path { get; set; } = "";
    public string FontPath { get; set; } = "";
    public bool IncludeCode { get; set; }
    public string[]? SelectedIds { get; set; }
    public Project? Project { get; set; }
}
public sealed class PausedException(string folder) : Exception("任务已中止，检查点已保存") { public string Folder { get; } = folder; }
public sealed record PatchFile(string File, string OriginalSha256, string PatchSha256, int Entries);
public sealed record ScanCheckpoint(int Next, bool IncludeCode);
public sealed record ExportCheckpoint(string Signature, List<PatchFile> Files);
public sealed record SavedProject(Project? Project, int? ScanCompleted, int? ScanTotal, List<string> Notices) { public bool? IncludeCode { get; init; } }

public static class Program
{
    public const int CurrentScanRevision = 2;
    public static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, WriteIndented = true };
    static readonly UTF8Encoding Utf8 = new(false, true);
    static bool ReportProgress;
    static readonly JsonSerializerOptions ProgressJson = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    static void Progress(string detail, int completed = 0, int? total = null, string? folder = null) {
        if (ReportProgress) Console.Error.WriteLine("LLMCHAT_PROGRESS " + JsonSerializer.Serialize(new { detail, completed, total, folder }, ProgressJson));
    }
    static void CheckStop(Request request, string folder) { if (request.StopFile.Length > 0 && File.Exists(request.StopFile)) throw new PausedException(folder); }
    static void WriteJson(string path, object value) {
        var temp = path + ".tmp";
        try { File.WriteAllText(temp, JsonSerializer.Serialize(value, Json), Utf8); File.Move(temp, path, true); }
        finally { if (File.Exists(temp)) File.Delete(temp); }
    }
    static readonly Regex Tokens = new(@"\{[^{}\r\n]+\}|%(?:\d+\$)?[-+0 #]*\d*(?:\.\d+)?[sdifouxXeEgGc%]|</?[^>\r\n]+>|\\[nrt]", RegexOptions.Compiled);

    public static int Main(string[] args)
    {
        try
        {
            Console.InputEncoding = new UTF8Encoding(false);
            Console.OutputEncoding = new UTF8Encoding(false);
            ReportProgress = args.Contains("--progress");
            if (args.Length > 1)
            {
                var parent = Process.GetProcessById(int.Parse(args[1]));
                _ = Task.Run(async () => { await parent.WaitForExitAsync(); Environment.Exit(2); });
            }
            var request = JsonSerializer.Deserialize<Request>(Console.In.ReadToEnd(), Json) ?? throw new Exception("请求为空");
            object result = args[0] switch
            {
                "scan" => Scan(request),
                "find" => FindSaved(request),
                "load" => Load(request.Path),
                "save" => Save(request.Project ?? throw new Exception("缺少工程")),
                "export" => Export(request),
                "apply" => Apply(request),
                _ => throw new Exception("未知操作")
            };
            Console.Out.Write(JsonSerializer.Serialize(result, Json));
            return 0;
        }
        catch (PausedException e) { Console.Out.Write(JsonSerializer.Serialize(new { paused = true, folder = e.Folder }, Json)); return 0; }
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
    public static SavedProject FindSaved(Request request)
    {
        var notices = new List<string>();
        if (!Directory.Exists(request.OutputRoot)) return new(null, null, null, notices);
        var root = System.IO.Path.GetFullPath(request.Root).TrimEnd('\\', '/');
        var options = new EnumerationOptions { AttributesToSkip = FileAttributes.ReparsePoint };
        var candidates = Directory.EnumerateDirectories(request.OutputRoot, "unity-project-*", options)
            .Select(folder => System.IO.Path.Combine(folder, "unity-project.json")).Where(File.Exists).OrderByDescending(File.GetLastWriteTimeUtc);
        foreach (var path in candidates)
        {
            try {
                using var input = File.OpenRead(path);
                using var document = JsonDocument.Parse(input);
                if (!document.RootElement.TryGetProperty("root", out var savedRoot) || !string.Equals(System.IO.Path.GetFullPath(savedRoot.GetString()!).TrimEnd('\\', '/'), root, StringComparison.OrdinalIgnoreCase)) continue;
                var project = Load(path);
                var statePath = System.IO.Path.Combine(project.Folder, "scan-state.json");
                if (File.Exists(statePath)) {
                    var state = JsonSerializer.Deserialize<ScanCheckpoint>(File.ReadAllText(statePath, Utf8), Json)!;
                    var paths = JsonSerializer.Deserialize<string[]>(File.ReadAllText(System.IO.Path.Combine(project.Folder, "scan-files.json"), Utf8), Json)!;
                    if (state.Next < paths.Length) return new(project, state.Next, paths.Length, notices) { IncludeCode = state.IncludeCode };
                    return new(project, null, null, notices) { IncludeCode = state.IncludeCode };
                }
                return new(project, null, null, notices);
            } catch (Exception e) when (e is JsonException or IOException or UnauthorizedAccessException) {
                notices.Add($"工程读取失败：{path}：{e.Message}");
            }
        }
        return new(null, null, null, notices);
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
        var project = request.Path.Length > 0 ? Load(System.IO.Path.Combine(request.Path, "unity-project.json")) : new Project { Root = root, ScanRevision = CurrentScanRevision, Folder = NewFolder(output, "unity-project") };
        if (!string.Equals(project.Root, root, StringComparison.OrdinalIgnoreCase)) throw new Exception("扫描检查点不属于当前游戏");
        if (project.ScanRevision != CurrentScanRevision) throw new Exception("扫描检查点使用旧提取方式，请重新扫描；原工程和译文会保留");
        using var types = new GameTypes(root);
        Save(project);
        var options = new EnumerationOptions { RecurseSubdirectories = true, AttributesToSkip = FileAttributes.ReparsePoint, IgnoreInaccessible = false };
        var statePath = System.IO.Path.Combine(project.Folder, "scan-state.json");
        var pathsPath = System.IO.Path.Combine(project.Folder, "scan-files.json");
        Progress("正在列出游戏资源文件", folder: project.Folder);
        var state = File.Exists(statePath) ? JsonSerializer.Deserialize<ScanCheckpoint>(File.ReadAllText(statePath, Utf8), Json)! : new ScanCheckpoint(0, request.IncludeCode);
        if (state.IncludeCode != request.IncludeCode) throw new Exception("代码扫描选项已变化，请重新扫描或恢复原选项");
        var paths = File.Exists(pathsPath) ? JsonSerializer.Deserialize<string[]>(File.ReadAllText(pathsPath, Utf8), Json)! : Directory.EnumerateFiles(root, "*", options).ToArray();
        WriteJson(pathsPath, paths); WriteJson(statePath, state);
        foreach (var file in project.Hashes) if (Hash(Within(root, file.Key)) != file.Value) throw new Exception("已扫描文件发生变化，请重新扫描：" + file.Key);
        for (var index = state.Next; index < paths.Length; index++)
        {
            CheckStop(request, project.Folder);
            var path = paths[index];
            var rel = System.IO.Path.GetRelativePath(root, path);
            Progress("检查资源：" + rel, index, paths.Length, project.Folder);
            var name = System.IO.Path.GetFileName(path);
            var ext = System.IO.Path.GetExtension(path).ToLowerInvariant();
            var isCode = request.IncludeCode && (name.Equals("global-metadata.dat", StringComparison.OrdinalIgnoreCase) || name.StartsWith("Assembly-CSharp", StringComparison.OrdinalIgnoreCase) && ext == ".dll");
            var asset = ext is ".assets" or ".bundle" or ".unity3d" or ".ab" || name is "resources.assets" or "globalgamemanagers" || Regex.IsMatch(name, @"^(level\d+|CAB-[0-9a-f]+)$", RegexOptions.IgnoreCase);
            var plain = ext is ".txt" or ".json" && GameText.PlainFile(root, rel);
            if (!isCode && !asset && !plain) { WriteJson(statePath, new ScanCheckpoint(index + 1, request.IncludeCode)); continue; }
            // A crash between project and checkpoint saves replays only the current file.
            project.Entries.RemoveAll(e => e.File == rel); project.Fonts.RemoveAll(f => f.File == rel); project.Hashes.Remove(rel);
            var before = project.Entries.Count;
            var fonts = project.Fonts.Count;
            try
            {
                if (isCode && ext == ".dll") ScanAssembly(path, rel, project);
                else if (isCode) VisitMetadata(File.ReadAllBytes(path), (loc, text, _) => Add(project, rel, "", 0, loc, "IL2CPP 字面量", text));
                else if (asset) VisitResource(path, (am, inst, container) => ScanAssets(am, inst, rel, container, project), types, rel);
                else TextDocument(File.ReadAllText(path, Utf8), (loc, text, _) => { if (GameText.Visible(loc.Split('/').Last(), text)) Add(project, rel, "", 0, loc, "文本文件", text); });
                if (project.Entries.Count > before || project.Fonts.Count > fonts) project.Hashes[rel] = Hash(path);
            }
            catch (Exception e)
            {
                project.Entries.RemoveRange(before, project.Entries.Count - before);
                project.Fonts.RemoveRange(fonts, project.Fonts.Count - fonts);
                project.Warnings.Add($"{rel}：{e.Message}");
            }
            Save(project);
            WriteJson(statePath, new ScanCheckpoint(index + 1, request.IncludeCode));
            Progress("已检查：" + rel, index + 1, paths.Length, project.Folder);
        }
        CheckStop(request, project.Folder);
        project.Warnings.Add("图片文字、加密资源、未识别的自定义文本格式不在本次自动回写范围内。");
        if (Directory.EnumerateFiles(root, "catalog*.json", options).Any()) project.Warnings.Add("检测到 Addressables Catalog；首版不改写 Catalog / CRC，相关 Bundle 补丁需要游戏加载验证。");
        project.Warnings = project.Warnings.Distinct().ToList();
        var saved = Save(project);
        Progress($"扫描完成：{project.Entries.Count} 条文本，{project.Warnings.Count} 条提示", paths.Length, paths.Length, project.Folder);
        return saved;
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

    static void VisitResource(string path, Action<AssetsManager, AssetsFileInstance, string> visit, GameTypes types, string relative, string? destination = null)
    {
        var am = new AssetsManager();
        types.Configure(am, relative);
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
                if (type == 114 && !inst.file.Metadata.TypeTreeEnabled && am.MonoTempGenerator == null) continue;
                var field = am.GetBaseField(inst, info);
                var name = field["m_Name"].IsDummy ? info.PathId.ToString() : field["m_Name"].AsString;
                if (type == 128) project.Fonts.Add(new FontInfo(rel, container, info.PathId.ToString(), name, "UGUI"));
                if (type == 49 && GameText.TextAsset(name))
                    TextDocument(Utf8.GetString(field["m_Script"].AsByteArray), (loc, text, _) => { if (GameText.Visible(name, text)) Add(project, rel, container, info.PathId, loc, "TextAsset", text); });
                if (type == 114)
                {
                    GameText.VisitStrings(field, (loc, text, _) => Add(project, rel, container, info.PathId, loc, "游戏文本", text));
                    if (!field["m_CharacterTable"].IsDummy || !field["m_glyphInfoList"].IsDummy)
                        project.Fonts.Add(new FontInfo(rel, container, info.PathId.ToString(), name, "TMP（需兼容图集）"));
                    else if (!field["mFont"].IsDummy) project.Fonts.Add(new FontInfo(rel, container, info.PathId.ToString(), name, "NGUI（需兼容图集）"));
                }
            }
            catch (Exception e) { project.Warnings.Add($"{rel} / {container} / {info.PathId}：{e.Message}"); }
        }
        if (!inst.file.Metadata.TypeTreeEnabled && am.MonoTempGenerator == null && inst.file.GetAssetsOfType(AssetClassID.MonoBehaviour).Count > 0)
            project.Warnings.Add($"{rel} / {container}：MonoBehaviour 未内嵌类型树，首版未解析其 UI 文本和 TMP / NGUI 字体。");
    }

    public static object Export(Request request)
    {
        Progress("校验译文、占位符与字体");
        var project = request.Project ?? throw new Exception("缺少工程");
        using var types = new GameTypes(project.Root);
        var ids = request.SelectedIds?.ToHashSet(StringComparer.Ordinal);
        var selected = project.Entries.Where(e => e.Selected && (ids == null || ids.Contains(e.Id))).ToArray();
        if (selected.Length == 0) throw new Exception("请先选择需要回写的文本");
        foreach (var entry in selected) ValidateTranslation(entry.Source, entry.Translation);
        byte[]? font = null;
        if (request.FontPath.Length > 0)
        {
            font = File.ReadAllBytes(request.FontPath);
            var missing = FontCoverage.Missing(font, string.Concat(selected.Select(e => e.Source)) + string.Concat(selected.Select(e => e.Translation)));
            if (missing.Count > 0) throw new Exception($"所选字体缺少 {missing.Count} 个字符：{string.Concat(missing.Take(24).Select(char.ConvertFromUtf32))}");
        }
        var fonts = font == null ? [] : project.Fonts.Where(f => f.Kind == "UGUI").ToArray();
        if (font != null && fonts.Length == 0) throw new Exception("未扫描到可替换的 UGUI 字体；TMP / NGUI 图集不能使用此字体替换功能");
        var files = selected.Select(e => e.File).Concat(fonts.Select(f => f.File)).Distinct().ToArray();
        var signature = Convert.ToHexString(SHA256.HashData(Utf8.GetBytes(JsonSerializer.Serialize(new { selected, fonts, font = font == null ? "" : Convert.ToHexString(SHA256.HashData(font)) }, Json))));
        var folder = request.Path.Length > 0 ? Within(project.Folder, System.IO.Path.GetRelativePath(project.Folder, request.Path)) : NewFolder(project.Folder, "patch");
        var checkpointPath = System.IO.Path.Combine(folder, "export-state.json");
        var checkpoint = File.Exists(checkpointPath) ? JsonSerializer.Deserialize<ExportCheckpoint>(File.ReadAllText(checkpointPath, Utf8), Json)! : new ExportCheckpoint(signature, []);
        if (checkpoint.Signature != signature) throw new Exception("译文、选取或字体已变化，请重新生成补丁");
        WriteJson(checkpointPath, checkpoint);
        Progress("准备生成资源补丁", checkpoint.Files.Count, files.Length, folder);
        var marker = System.IO.Path.Combine(folder, "INCOMPLETE.txt");
        File.WriteAllText(marker, "补丁尚未生成完成，不能使用。", Utf8);
        try
        {
            var manifest = checkpoint.Files;
            foreach (var completed in manifest)
                if (Hash(Within(project.Root, completed.File)) != completed.OriginalSha256 || Hash(Within(System.IO.Path.Combine(folder, "original"), completed.File)) != completed.OriginalSha256 || Hash(Within(System.IO.Path.Combine(folder, "patch"), completed.File)) != completed.PatchSha256)
                    throw new Exception("已生成的补丁或原件发生变化：" + completed.File);
            foreach (var file in files)
            {
                CheckStop(request, folder);
                if (manifest.Any(f => f.File == file)) continue;
                Progress("生成补丁：" + file, manifest.Count, files.Length, folder);
                var source = Within(project.Root, file); var original = Within(System.IO.Path.Combine(folder, "original"), file);
                if (!project.Hashes.TryGetValue(file, out var expected) || expected != Hash(source)) throw new Exception($"源文件已变化，请重新扫描：{file}");
                Directory.CreateDirectory(System.IO.Path.GetDirectoryName(original)!);
                if (!File.Exists(original)) File.Copy(source, original);
                var originalHash = Hash(original);
                if (expected != originalHash) throw new Exception($"原件备份校验失败：{file}");
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
                        else if (relevant.Any(e => e.Locator.StartsWith('/'))) GameText.VisitStrings(field, (loc, text, set) => Change(container, info.PathId, loc, text, set));
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
                }, types, file, destination);
                if (edits.Count != 0) throw new Exception($"部分文本未能回写：{file}");
                manifest.Add(new PatchFile(file, originalHash, Hash(destination), entries.Length));
                WriteJson(checkpointPath, checkpoint);
                Progress("已生成：" + file, manifest.Count, files.Length, folder);
            }
            CheckStop(request, folder);
            Save(project);
            File.WriteAllText(System.IO.Path.Combine(folder, "manifest.json"), JsonSerializer.Serialize(new { version = 1, project.Root, files = manifest, warnings = project.Warnings, fontReplacements = fonts.Length }, Json), Utf8);
            File.WriteAllText(System.IO.Path.Combine(folder, "使用说明.txt"), "先关闭游戏。patch 目录内是按游戏相对路径排列的补丁文件；确认备份后复制到游戏目录。original 目录保存本次修改文件的原件，按相同相对路径复制回去可恢复。manifest.json 记录原件及补丁哈希。\n补丁生成成功不代表已完成游戏加载或显示验证；TMP / NGUI、图片文字、加密资源及 Addressables Catalog 未自动处理。\n", Utf8);
            File.Delete(marker);
            Progress("补丁与原件备份已生成", files.Length, files.Length, folder);
            return new { folder, files = files.Length, entries = selected.Length, fontReplacements = fonts.Length };
        }
        catch (PausedException) { throw; }
        catch (Exception e) { File.WriteAllText(marker, "补丁生成失败，不可使用：" + e.Message, Utf8); throw new Exception($"{e.Message}；未完成输出：{folder}"); }
    }

    static void CheckGameClosed(string root)
    {
        var names = Directory.EnumerateFiles(root, "*.exe", new EnumerationOptions { RecurseSubdirectories = true, AttributesToSkip = FileAttributes.ReparsePoint })
            .Select(System.IO.Path.GetFileNameWithoutExtension).ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (var process in Process.GetProcesses())
        {
            using (process)
            {
                if (!names.Contains(process.ProcessName)) continue;
                string? executable;
                try { executable = process.MainModule?.FileName; }
                catch (InvalidOperationException) { continue; } // The process exited during inspection.
                catch (Exception e) { throw new Exception($"无法确认 {process.ProcessName} 是否为当前游戏，请关闭该程序后重试：{e.Message}"); }
                if (executable != null && executable.StartsWith(root.TrimEnd('\\', '/') + System.IO.Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                    throw new Exception("游戏仍在运行，请关闭游戏后再应用补丁");
            }
        }
    }

    static string ApplyPath(string root, string relative)
    {
        var path = Within(root, relative);
        for (var item = path; item != null; item = System.IO.Path.GetDirectoryName(item))
        {
            if ((File.GetAttributes(item) & FileAttributes.ReparsePoint) != 0) throw new Exception("应用路径包含目录联接或符号链接：" + item);
            if (string.Equals(item.TrimEnd('\\', '/'), System.IO.Path.GetFullPath(root).TrimEnd('\\', '/'), StringComparison.OrdinalIgnoreCase)) break;
        }
        return path;
    }

    static void ReplaceFile(string source, string target)
    {
        var temp = target + ".llmchat-" + Guid.NewGuid().ToString("N") + ".tmp";
        try { File.Copy(source, temp); File.Move(temp, target, true); }
        finally { if (File.Exists(temp)) File.Delete(temp); }
    }

    public static object Apply(Request request)
    {
        var root = System.IO.Path.GetFullPath(request.Root);
        var folder = System.IO.Path.GetFullPath(request.Path);
        Progress("检查游戏进程、补丁和原件备份");
        if (File.Exists(System.IO.Path.Combine(folder, "INCOMPLETE.txt"))) throw new Exception("补丁未完整生成，不能应用");
        using var document = JsonDocument.Parse(File.ReadAllText(System.IO.Path.Combine(folder, "manifest.json"), Utf8));
        var manifest = document.RootElement;
        if (manifest.GetProperty("version").GetInt32() != 1 || !string.Equals(System.IO.Path.GetFullPath(manifest.GetProperty("root").GetString()!), root, StringComparison.OrdinalIgnoreCase))
            throw new Exception("补丁不属于当前游戏");
        CheckGameClosed(root);
        var files = manifest.GetProperty("files").EnumerateArray().Select(f => new {
            File = f.GetProperty("file").GetString()!, Original = f.GetProperty("originalSha256").GetString(), Patch = f.GetProperty("patchSha256").GetString()
        }).ToArray();
        var applicationPath = System.IO.Path.Combine(folder, "application-state.json");
        var manifestHash = Hash(System.IO.Path.Combine(folder, "manifest.json"));
        var resuming = File.Exists(applicationPath);
        if (resuming) {
            using var previous = JsonDocument.Parse(File.ReadAllText(applicationPath, Utf8));
            if (previous.RootElement.GetProperty("manifestHash").GetString() != manifestHash) throw new Exception("应用检查点与补丁清单不一致");
        }
        if (files.Length == 0 || files.Select(f => f.File).Distinct(StringComparer.OrdinalIgnoreCase).Count() != files.Length) throw new Exception("补丁文件列表无效");
        var applied = new List<string>();
        foreach (var file in files)
        {
            CheckStop(request, folder);
            var target = ApplyPath(root, file.File);
            var original = ApplyPath(System.IO.Path.Combine(folder, "original"), file.File);
            var patch = ApplyPath(System.IO.Path.Combine(folder, "patch"), file.File);
            var currentHash = Hash(target);
            if (resuming && currentHash == file.Patch) applied.Add(file.File);
            else if (currentHash != file.Original) throw new Exception("游戏文件已变化，未应用补丁，请重新扫描：" + file.File);
            if (Hash(original) != file.Original || Hash(patch) != file.Patch) throw new Exception("补丁或原件备份校验失败：" + file.File);
        }
        WriteJson(applicationPath, new { manifestHash, completed = applied, done = false });
        Progress("应用检查点已就绪；未完成前请勿启动游戏", applied.Count, files.Length, folder);
        try
        {
            foreach (var file in files)
            {
                CheckStop(request, folder);
                if (applied.Contains(file.File)) continue;
                Progress("应用到游戏：" + file.File, applied.Count, files.Length, folder);
                var target = ApplyPath(root, file.File);
                if (Hash(target) != file.Original) throw new Exception("游戏文件在应用前发生变化：" + file.File);
                ReplaceFile(Within(System.IO.Path.Combine(folder, "patch"), file.File), target);
                applied.Add(file.File);
                if (Hash(target) != file.Patch) throw new Exception("写入后校验失败：" + file.File);
                WriteJson(applicationPath, new { manifestHash, completed = applied, done = false });
                Progress("已应用：" + file.File, applied.Count, files.Length, folder);
            }
            CheckStop(request, folder);
        }
        catch (PausedException) { throw; }
        catch (Exception e)
        {
            var failed = new List<string>();
            foreach (var file in applied.AsEnumerable().Reverse())
                try { ReplaceFile(Within(System.IO.Path.Combine(folder, "original"), file), Within(root, file)); }
                catch (Exception rollback) { failed.Add(file + "：" + rollback.Message); }
            throw new Exception(e.Message + (failed.Count == 0 ? "；已回滚本次写入，原游戏文件已保留" : "；部分文件回滚失败，请从原件备份恢复：" + string.Join("；", failed)));
        }
        WriteJson(applicationPath, new { manifestHash, completed = applied, done = true });
        Progress("已应用到游戏，原件备份已保留", files.Length, files.Length, folder);
        return new { folder, files = files.Length };
    }
}

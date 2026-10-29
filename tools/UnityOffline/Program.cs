using System.Buffers.Binary;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using AssetsTools.NET;
using AssetsTools.NET.Extra;
using Mono.Cecil;
using Mono.Cecil.Cil;

namespace LLMChat.UnityOffline;

public sealed record Entry(string Id, string File, string Container, string ObjectId,
    string Locator, string Kind, string Source)
{
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? ParentId { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? ParentLocator { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public int? SourceStart { get; init; }
    public string Translation { get; set; } = "";
    public bool Selected { get; set; } = true;
    public string Error { get; set; } = "";
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Locale { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? LayoutDraft { get; set; }
}
public sealed record FontInfo(string File, string Container, string ObjectId, string Name, string Kind) { [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public List<FontReference>? References { get; init; } }
public sealed class Project
{
    public int Version { get; set; } = 1;
    public int ScanRevision { get; set; }
    public int TextSafetyRevision { get; set; }
    public int ExcludedMetadataCount { get; set; }
    public int NextEntryId { get; set; } = 1;
    public string Root { get; set; } = "";
    public string Folder { get; set; } = "";
    public List<Entry> Entries { get; set; } = [];
    public Dictionary<string, string> SegmentSources { get; set; } = [];
    [JsonIgnore] public SmartTextSegments? Segmenter { get; set; }
    public List<FontInfo> Fonts { get; set; } = [];
    public List<ImageResource> Images { get; set; } = [];
    public bool ImagesSkipped { get; set; }
    public bool TextSkipped { get; set; }
    [JsonIgnore] public Action? CheckCancellation { get; set; }
    [JsonIgnore] public Action<string>? ReportScanDetail { get; set; }
    public List<string> Warnings { get; set; } = [];
    public Dictionary<string, string> Hashes { get; set; } = [];
    public string TextMode { get; set; } = "lines";
    public string TypeDirectory { get; set; } = "";
    public Dictionary<string, string> DefinitionHashes { get; set; } = [];
    public List<ScanIssue> Diagnostics { get; set; } = [];
    public List<ResourceResult> Resources { get; set; } = [];
}
public sealed class Request
{
    public string StopFile { get; set; } = "";
    public string Root { get; set; } = "";
    public string[] Roots { get; set; } = [];
    public string OutputRoot { get; set; } = "";
    public string Path { get; set; } = "";
    public string FontPath { get; set; } = "";
    public bool IncludeCode { get; set; }
    public string[]? CodeAssemblies { get; set; }
    public string TextMode { get; set; } = "paragraphs";
    public string TypeDirectory { get; set; } = "";
    public string ExtraCharacters { get; set; } = "";
    public string ImageId { get; set; } = "";
    public string ImageData { get; set; } = "";
    public bool ImageOnly { get; set; }
    public int Step { get; set; }
    public string[]? SelectedIds { get; set; }
    public string[]? FontSourceIds { get; set; }
    public JsonNode? Task { get; set; }
    public Project? Project { get; set; }
}
public sealed class PausedException(string folder) : Exception("任务已中止，检查点已保存") { public string Folder { get; } = folder; }
public sealed record PatchFile(string File, string OriginalSha256, string PatchSha256, int Entries);
public sealed record ScanCheckpoint(int Next, bool IncludeCode) { public string[]? CodeAssemblies { get; init; } public string TextMode { get; init; } = "lines"; public string TypeDirectory { get; init; } = ""; }
public sealed record ExportCheckpoint(string Signature, List<PatchFile> Files) { public int TotalFiles { get; init; } }
public sealed record SavedProject(Project? Project, int? ScanCompleted, int? ScanTotal, List<string> Notices) { public bool? IncludeCode { get; init; } }

public static class Program
{
    public const int CurrentScanRevision = 5;
    public const int MinimumUsableScanRevision = 2;
    public static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, WriteIndented = true };
    static readonly UTF8Encoding Utf8 = new(false, true);
    static bool ReportProgress;
    static readonly JsonSerializerOptions ProgressJson = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    internal static void Progress(string detail, int completed = 0, int? total = null, string? folder = null) {
        if (ReportProgress) Console.Error.WriteLine("LLMCHAT_PROGRESS " + JsonSerializer.Serialize(new { detail, completed, total, folder }, ProgressJson));
    }
    internal static void CheckStop(Request request, string folder) { if (request.StopFile.Length > 0 && File.Exists(request.StopFile)) throw new PausedException(folder); }
    internal static void WriteJson(string path, object value) {
        var temp = path + ".tmp";
        try { File.WriteAllText(temp, JsonSerializer.Serialize(value, Json), Utf8); File.Move(temp, path, true); }
        finally { if (File.Exists(temp)) File.Delete(temp); }
    }

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
                "inspect" => ScanInspection.Inspect(request.Root),
                "font-plan" => FontPreparation.Create(request),
                "find" => FindSaved(request),
                "workspace" => GameWorkspace.Open(request),
                "resume-info" => GameWorkspace.ResumeInfo(request),
                "save-task" => SaveTask(request),
                "reset-step" => WorkflowReset.Start(request),
                "finish-rescan" => WorkflowReset.FinishRescan(request),
                "load" => Load(request.Path),
                "save" => Save(request.Project ?? throw new Exception("缺少工程")),
                "save-image" => ImageResources.SaveRendered(request),
                "preview-image" => ImageResources.Preview(request),
                "export" => Export(request),
                "apply" => Apply(request),
                "uninstall" => PatchInstallation.Uninstall(request),
                "installation-status" => request.Roots.Select(PatchInstallation.Status).ToArray(),
                _ => throw new Exception("未知操作")
            };
            Console.Out.Write(JsonSerializer.Serialize(result, Json));
            return 0;
        }
        catch (PausedException e) { Console.Out.Write(JsonSerializer.Serialize(new { paused = true, folder = e.Folder }, Json)); return 0; }
        catch (Exception e) { Console.Error.Write(e.Message); return 1; }
    }

    static object SaveTask(Request request) { GameWorkspace.SaveTask(request); return new { ok = true }; }

    public static string Within(string root, string relative)
    {
        root = System.IO.Path.GetFullPath(root).TrimEnd(System.IO.Path.DirectorySeparatorChar) + System.IO.Path.DirectorySeparatorChar;
        var path = System.IO.Path.GetFullPath(System.IO.Path.Combine(root, relative));
        if (!path.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new Exception("文件路径越过工程目录");
        return path;
    }
    internal static string Hash(string path) { using var f = File.OpenRead(path); return Convert.ToHexString(SHA256.HashData(f)); }
    static string NewFolder(string output, string name)
    {
        var folder = System.IO.Path.Combine(System.IO.Path.GetFullPath(output), $"{name}-{DateTime.Now:yyyyMMdd-HHmmss}-{Guid.NewGuid():N}");
        Directory.CreateDirectory(folder);
        return folder;
    }
    public static Project Save(Project project)
    {
        if (project.Version != 1 || !Directory.Exists(project.Folder)) throw new Exception("工程版本或目录无效");
        GameText.ProtectProject(project);
        var parents = project.Entries.Where(e => e.ParentId != null).Select(e => e.ParentId!).ToHashSet();
        foreach (var id in project.SegmentSources.Keys.Where(id => !parents.Contains(id)).ToArray()) project.SegmentSources.Remove(id);
        var path = System.IO.Path.Combine(project.Folder, "unity-project.json");
        var temp = path + ".tmp";
        try { File.WriteAllText(temp, JsonSerializer.Serialize(project, Json), Utf8); File.Move(temp, path, true); }
        finally { if (File.Exists(temp)) File.Delete(temp); }
        ImageResources.CommitStates(project);
        return project;
    }
    public static Project Load(string path)
    {
        var project = JsonSerializer.Deserialize<Project>(File.ReadAllText(path, Utf8), Json) ?? throw new Exception("工程无效");
        project.Folder = System.IO.Path.GetDirectoryName(System.IO.Path.GetFullPath(path))!;
        if (project.Version != 1) throw new Exception("不支持此工程版本");
        var definitions = Path.Combine(project.Folder, "type-definitions");
        if (project.DefinitionHashes.Count > 0 || File.Exists(Path.Combine(definitions, ScanInspection.PendingDefinitions))) project.TypeDirectory = definitions;
        foreach (var e in project.Entries) _ = Within(project.Root, e.File);
        GameText.ProtectProject(project);
        ImageResources.LoadStates(project, File.GetLastWriteTimeUtc(path));
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
    public static bool TextCandidate(string text, int maximum = 16000) => text.Length > 1 && text.Length <= maximum &&
        !text.Any(c => char.IsControl(c) && c is not '\r' and not '\n' and not '\t') &&
        text.Any(char.IsLetter) && !Regex.IsMatch(text.Trim(), @"^(?:https?://|[\w./\\-]+\.(?:png|jpg|asset|prefab|dll)|[A-Fa-f0-9]{16,}$)");
    public static void ValidateTranslation(string source, string translation)
    {
        if (string.IsNullOrWhiteSpace(translation)) throw new Exception("译文为空");
        var problem = TranslationIntegrity.Validate(source, translation);
        if (problem.Length > 0) throw new Exception(problem);
    }
    static void Add(Project project, string file, string container, long objectId, string locator, string kind, string text, string locale = "")
    {
        if (!TextCandidate(text, project.TextMode == "smart" ? int.MaxValue : 16000)) return;
        var entry = new Entry($"{project.NextEntryId}", file, container, objectId.ToString(), locator, kind, text) { Locale = locale.Length > 0 ? locale : null };
        if (GameText.Protected(entry)) return;
        var spans = project.Segmenter?.Split(text, file + " / " + objectId + " / " + locator) ?? [(0, text.Length)];
        if (spans.Length > 1) {
            var parentId = entry.Id; project.SegmentSources[parentId] = text;
            foreach (var (start, length) in spans) {
                var part = entry with { Id = $"{project.NextEntryId++}", Locator = locator + "#segment/" + start, Source = text.Substring(start, length), ParentId = parentId, ParentLocator = locator, SourceStart = start };
                if (part.Source.Any(char.IsLetter) && !GameText.Protected(part)) project.Entries.Add(part);
            }
        } else { project.Entries.Add(entry); project.NextEntryId++; }
    }

    // JSON keys and identifier/path fields are never translated. Locators remain structural, not text-based.
    static void JsonStrings(JsonNode? node, string path, Action<string, string, Action<string>> visit)
    {
        if (node is JsonObject obj)
            foreach (var kv in obj.ToArray())
            {
                if (GameText.IsTechnicalField(kv.Key) || Regex.IsMatch(kv.Key, @"^(?:id|key|nameId|path|asset|guid|type|url|file|sprite|font)$", RegexOptions.IgnoreCase)) continue;
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
        if ((output.TrimEnd('\\', '/') + "/").Replace('\\', '/').StartsWith((root.TrimEnd('\\', '/') + "/").Replace('\\', '/'), StringComparison.OrdinalIgnoreCase) && !GameWorkspace.IsProjectsRoot(root, output))
            throw new Exception("游戏内工程只能保存在 LLMChat-Unity 工作文件夹中");
        var inspection = ScanInspection.Inspect(root);
        var assemblies = request.IncludeCode ? ScanInspection.SelectedAssemblies(request, inspection) : [];
        var project = request.Path.Length > 0 ? Load(System.IO.Path.Combine(request.Path, "unity-project.json")) : new Project { Root = root, ScanRevision = CurrentScanRevision, TextMode = request.TextMode, TypeDirectory = request.TypeDirectory, Folder = NewFolder(output, "unity-project") };
        if (!string.Equals(project.Root, root, StringComparison.OrdinalIgnoreCase)) throw new Exception("扫描检查点不属于当前游戏");
        if (project.ScanRevision != CurrentScanRevision) throw new Exception("扫描检查点使用旧提取方式，请重新扫描；原工程和译文会保留");
        if (request.TextMode is not ("lines" or "paragraphs" or "smart")) throw new Exception("无效文本分段方式");
        Save(project);
        var options = new EnumerationOptions { RecurseSubdirectories = true, AttributesToSkip = FileAttributes.ReparsePoint, IgnoreInaccessible = false };
        var statePath = System.IO.Path.Combine(project.Folder, "scan-state.json");
        var pathsPath = System.IO.Path.Combine(project.Folder, "scan-files.json");
        Progress("正在列出游戏资源文件", folder: project.Folder);
        var state = File.Exists(statePath) ? JsonSerializer.Deserialize<ScanCheckpoint>(File.ReadAllText(statePath, Utf8), Json)! : new ScanCheckpoint(0, request.IncludeCode) { CodeAssemblies = assemblies, TextMode = request.TextMode, TypeDirectory = request.TypeDirectory };
        if (state.IncludeCode != request.IncludeCode || state.TextMode != request.TextMode || state.TypeDirectory != request.TypeDirectory || !(state.CodeAssemblies ?? []).SequenceEqual(assemblies, StringComparer.OrdinalIgnoreCase)) throw new Exception("扫描选项或程序集范围已变化，请重新扫描或恢复原选项");
        var workPrefix = Path.GetFullPath(GameWorkspace.WorkRoot(root)).TrimEnd('\\', '/') + Path.DirectorySeparatorChar;
        var paths = File.Exists(pathsPath) ? JsonSerializer.Deserialize<string[]>(File.ReadAllText(pathsPath, Utf8), Json)! : Directory.EnumerateFiles(root, "*", options).Where(path => !Path.GetFullPath(path).StartsWith(workPrefix, StringComparison.OrdinalIgnoreCase)).ToArray();
        WriteJson(pathsPath, paths); WriteJson(statePath, state);
        if (request.TypeDirectory.Length > 0 && (project.DefinitionHashes.Count == 0 || File.Exists(Path.Combine(project.TypeDirectory, ScanInspection.PendingDefinitions)))) ScanInspection.CacheDefinitions(project, request.TypeDirectory, () => CheckStop(request, project.Folder));
        else ScanInspection.VerifyDefinitions(project);
        Save(project);
        var scanIndex = state.Next;
        long lastDetailReport = 0;
        var loadingModel = false;
        void ReportScanDetail(string detail) {
            var now = Environment.TickCount64;
            var loading = detail.StartsWith("加载分段模型：", StringComparison.Ordinal);
            if (!loading && !loadingModel && now - lastDetailReport < 500) return;
            loadingModel = loading; lastDetailReport = now;
            Progress(detail, scanIndex, paths.Length, project.Folder);
        }
        project.ReportScanDetail = ReportScanDetail;
        using var segmenter = project.TextMode == "smart" ? new SmartTextSegments(Path.Combine(AppContext.BaseDirectory, "wtp-model.onnx"), () => CheckStop(request, project.Folder), ReportScanDetail) : null;
        project.Segmenter = segmenter;
        project.CheckCancellation = () => CheckStop(request, project.Folder);
        using var types = new GameTypes(root, project.TypeDirectory);
        foreach (var file in project.Hashes) if (Hash(Within(root, file.Key)) != file.Value) throw new Exception("已扫描文件发生变化，请重新扫描：" + file.Key);
        for (var index = state.Next; index < paths.Length; index++)
        {
            CheckStop(request, project.Folder);
            scanIndex = index;
            var path = paths[index];
            var rel = System.IO.Path.GetRelativePath(root, path);
            Progress("检查资源：" + rel, index, paths.Length, project.Folder);
            var name = System.IO.Path.GetFileName(path);
            var ext = System.IO.Path.GetExtension(path).ToLowerInvariant();
            var isCode = request.IncludeCode && (name.Equals("global-metadata.dat", StringComparison.OrdinalIgnoreCase) || assemblies.Contains(rel, StringComparer.OrdinalIgnoreCase));
            var asset = ext is ".assets" or ".bundle" or ".unity3d" or ".ab" || name is "resources.assets" or "globalgamemanagers" || Regex.IsMatch(name, @"^(level\d+|CAB-[0-9a-f]+)$", RegexOptions.IgnoreCase);
            var raster = ext is ".png" or ".jpg" or ".jpeg" && GameText.PlainFile(root, rel);
            var plain = ext is ".txt" or ".json" or ".csv" or ".tsv" or ".xml" && GameText.PlainFile(root, rel);
            if (!isCode && !asset && !plain && !raster) { WriteJson(statePath, state with { Next = index + 1 }); continue; }
            // A crash between project and checkpoint saves replays only the current file.
            project.Entries.RemoveAll(e => e.File == rel); project.Fonts.RemoveAll(f => f.File == rel); project.Hashes.Remove(rel); project.Images.RemoveAll(i => i.File == rel);
            project.Diagnostics.RemoveAll(e => e.File == rel); project.Resources.RemoveAll(e => e.File == rel);
            var before = project.Entries.Count;
            var fonts = project.Fonts.Count; var imagesBefore = project.Images.Count;
            try
            {
                if (isCode && ext == ".dll") ScanAssembly(path, rel, project);
                else if (isCode) VisitMetadata(File.ReadAllBytes(path), (loc, text, _) => Add(project, rel, "", 0, loc, "IL2CPP 字面量", text));
                else if (raster) ImageResources.ScanFile(project, path, rel);
                else if (asset) VisitResource(path, (am, inst, container) => ScanAssets(am, inst, rel, container, project), types, rel);
                else TextDocuments.Process(TextDocuments.Read(path), name, project.TextMode, item => { if (GameText.Visible(item.Field, item.Text, project.TextMode == "smart" ? int.MaxValue : 16000)) Add(project, rel, "", 0, item.Locator, "文本文件", item.Text, item.Locale); });
                if (project.Entries.Count > before || project.Fonts.Count > fonts || project.Images.Count > imagesBefore) project.Hashes[rel] = Hash(path);
                var failures = project.Diagnostics.Count(e => e.File == rel);
                project.Resources.Add(new(rel, failures > 0 ? "partial" : project.Entries.Count > before || project.Fonts.Count > fonts ? "ready" : "empty", project.Entries.Count - before, project.Fonts.Count - fonts, failures));
            }
            catch (PausedException) { throw; }
            catch (Exception e)
            {
                project.Entries.RemoveRange(before, project.Entries.Count - before);
                project.Fonts.RemoveRange(fonts, project.Fonts.Count - fonts); project.Images.RemoveRange(imagesBefore, project.Images.Count - imagesBefore);
                project.Diagnostics.Add(ScanInspection.Issue(rel, "", "", e));
                project.Resources.Add(new(rel, "failed", 0, 0, project.Diagnostics.Count(d => d.File == rel)));
            }
            Save(project);
            WriteJson(statePath, state with { Next = index + 1 });
            Progress("已检查：" + rel, index + 1, paths.Length, project.Folder);
        }
        CheckStop(request, project.Folder);
        project.Warnings.Add("加密资源、未识别的自定义文本格式不在本次自动回写范围内。");
        if (inspection.Catalogs.Length > 0) project.Warnings.Add($"检测到 {inspection.Catalogs.Length} 个 Addressables Catalog（JSON / BIN / Bundle）；资源修改后需核对 Catalog / CRC 和依赖，不能将加载失败直接视为加密。");
        project.Warnings = project.Warnings.Distinct().ToList();
        var saved = Save(project);
        Progress($"扫描完成：{project.Entries.Count} 条文本；{project.Resources.Count(r => r.State == "ready")} 个可读取，{project.Resources.Count(r => r.State == "empty")} 个无目标，{project.Resources.Count(r => r.State == "partial")} 个部分解析，{project.Resources.Count(r => r.State == "failed")} 个失败", paths.Length, paths.Length, project.Folder);
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

    static void VisitResource(string path, Action<AssetsManager, AssetsFileInstance, string> visit, GameTypes types, string relative, string? destination = null, string? sourcePath = null)
    {
        var am = new AssetsManager();
        types.Configure(am, relative);
        try
        {
            var tpk = System.IO.Path.Combine(AppContext.BaseDirectory, "classdata.tpk");
            if (File.Exists(tpk)) am.LoadClassPackage(tpk);
            using var input = File.OpenRead(path); var signature = new byte[8]; input.ReadExactly(signature); input.Position = 0;
            // Read the verified backup, but resolve external MonoScript/type
            // dependencies beside the game's original resource, not the backup.
            var dependencyPath = sourcePath ?? path;
            if (Encoding.ASCII.GetString(signature).StartsWith("Unity"))
            {
                var bundle = am.LoadBundleFile(input, dependencyPath, true);
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
                var inst = am.LoadAssetsFile(input, dependencyPath, false); visit(am, inst, "");
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
    static string ObjectDescription(AssetsManager manager, AssetsFileInstance instance, AssetFileInfo info)
    {
        var type = ((AssetClassID)info.TypeId).ToString();
        if (info.TypeId == 114) {
            try {
                var header = manager.GetBaseField(instance, info, AssetReadFlags.SkipMonoBehaviourFields);
                var script = manager.GetExtAsset(instance, header["m_Script"], false, AssetReadFlags.None).baseField;
                if (script != null && !script.IsDummy && !script["m_ClassName"].IsDummy) {
                    var space = script["m_Namespace"].IsDummy ? "" : script["m_Namespace"].AsString;
                    type = (space.Length > 0 ? space + "." : "") + script["m_ClassName"].AsString;
                    if (!script["m_AssemblyName"].IsDummy) type += "（" + script["m_AssemblyName"].AsString + "）";
                }
            } catch (Exception error) { type += "（类型名未读取：" + error.Message + "）"; }
        }
        return type + " / Unity " + instance.file.Metadata.UnityVersion;
    }
    static void ScanAssets(AssetsManager am, AssetsFileInstance inst, string rel, string container, Project project)
    {
        project.ReportScanDetail?.Invoke($"读取类型与纹理索引：{rel} / {container}");
        PrepareTypes(am, inst);
        var fontTextures = ImageResources.FontTextures(am, inst);
        var objectIndex = 0;
        foreach (var info in inst.file.Metadata.AssetInfos)
        {
            project.CheckCancellation?.Invoke();
            objectIndex++;
            if (objectIndex == 1 || objectIndex % 64 == 0)
                project.ReportScanDetail?.Invoke($"读取资源对象：{rel} / {container} · 对象 {objectIndex} / {inst.file.Metadata.AssetInfos.Count} · 已提取 {project.Entries.Count} 条文本");
            var type = info.TypeId;
            if (type is not (28 or 49 or 128 or 114)) continue;
            var textCount = project.Entries.Count; var fontCount = project.Fonts.Count;
            try
            {
                if (type == 114 && !inst.file.Metadata.TypeTreeEnabled && am.MonoTempGenerator == null) {
                    project.Diagnostics.Add(new(rel, container, info.PathId.ToString(), ObjectDescription(am, inst, info) + "：缺少字段类型定义，尚未提取该对象", "选择游戏 Managed 或匹配的 DummyDll 类型目录后重新扫描；IL2CPP 的 GameAssembly.dll 不能代替 DummyDll。"));
                    continue;
                }
                var field = am.GetBaseField(inst, info);
                var name = field["m_Name"].IsDummy ? info.PathId.ToString() : field["m_Name"].AsString;
                if (type == 28) ImageResources.ScanTexture(project, inst, field, rel, container, info.PathId, fontTextures.Contains(info.PathId));
                if (type == 128) project.Fonts.Add(new FontInfo(rel, container, info.PathId.ToString(), name, "UGUI") { References = FontPreparation.References(field) });
                if (type == 49 && GameText.TextAsset(name))
                    TextDocuments.Process(Utf8.GetString(field["m_Script"].AsByteArray), name, project.TextMode, item => { if (GameText.Visible(item.Field, item.Text, project.TextMode == "smart" ? int.MaxValue : 16000)) Add(project, rel, container, info.PathId, item.Locator, "TextAsset", item.Text, item.Locale); });
                if (type == 114)
                {
                    var fontKind = BitmapFontGenerator.FontKind(field);
                    if (fontKind != null) project.Fonts.Add(new FontInfo(rel, container, info.PathId.ToString(), name, fontKind) { References = FontPreparation.References(field) });
                    else GameText.VisitStrings(field, (loc, text, _) => Add(project, rel, container, info.PathId, loc, "游戏文本", text));
                }
            }
            catch (PausedException) { throw; }
            catch (Exception e) {
                project.Entries.RemoveRange(textCount, project.Entries.Count - textCount);
                project.Fonts.RemoveRange(fontCount, project.Fonts.Count - fontCount);
                project.Diagnostics.Add(ScanInspection.Issue(rel, container, info.PathId.ToString(), e, ObjectDescription(am, inst, info)));
            }
        }
    }

    public static object Export(Request request)
    {
        Progress("校验译文、占位符与字体");
        var project = request.Project ?? throw new Exception("缺少工程");
        if (project.ScanRevision < MinimumUsableScanRevision || project.ScanRevision > CurrentScanRevision) throw new Exception("扫描工程格式不兼容，请重新扫描；原工程和译文会保留");
        ScanInspection.VerifyDefinitions(project);
        using var types = new GameTypes(project.Root, project.TypeDirectory);
        var ids = request.SelectedIds?.ToHashSet(StringComparer.Ordinal);
        var candidates = project.Entries.Where(e => e.Selected && (ids == null || ids.Contains(e.Id))).ToArray();
        var selected = candidates.Where(e => e.Error.Length == 0 && TranslationIntegrity.Validate(e.Source, e.Translation).Length == 0).ToArray();
        var images = ImageResources.Ready(project);
        if (selected.Length == 0 && images.Length == 0) throw new Exception("没有可回写的有效译文或译图；出错和未完成的项目已跳过，游戏原文与原图保持不变");
        if (selected.Any(GameText.Protected)) throw new Exception("发现程序类型或事件绑定标识，已阻止生成补丁。请重新打开工程剔除程序标识后再生成");
        foreach (var entry in selected) ValidateTranslation(entry.Source, entry.Translation);
        var fontPlan = FontPreparation.Create(request, false);
        byte[]? font = null;
        if (request.FontPath.Length > 0 && selected.Length > 0)
        {
            font = File.ReadAllBytes(request.FontPath);
            if (fontPlan.Missing.Length > 0) throw new Exception($"所选字体缺少 {fontPlan.Missing.Length} 个字符：{string.Concat(fontPlan.Missing.Take(24).Select(char.ConvertFromUtf32))}；完整清单见字库检查");
        }
        var fonts = font == null ? [] : project.Fonts.Where(f => f.Kind == "UGUI" || f.Kind.StartsWith("TMP", StringComparison.Ordinal) || f.Kind.StartsWith("NGUI", StringComparison.Ordinal)).ToArray();
        if (font != null && fonts.Length == 0) throw new Exception("未扫描到可替换的字体，请先扫描游戏字体资源");
        var characters = File.ReadAllText(System.IO.Path.Combine(fontPlan.Folder, "characters.txt"), Utf8);
        var files = selected.Select(e => e.File).Concat(fonts.Select(f => f.File)).Concat(images.Select(i => i.File)).Distinct().ToArray();
        var signature = Convert.ToHexString(SHA256.HashData(Utf8.GetBytes(JsonSerializer.Serialize(new { selected, images, fonts, characters, atlasRevision = BitmapFontGenerator.Revision, font = font == null ? "" : Convert.ToHexString(SHA256.HashData(font)) }, Json))));
        var folder = request.Path.Length > 0 ? Within(project.Folder, System.IO.Path.GetRelativePath(project.Folder, request.Path)) : NewFolder(project.Folder, "patch");
        var checkpointPath = System.IO.Path.Combine(folder, "export-state.json");
        var checkpoint = File.Exists(checkpointPath) ? JsonSerializer.Deserialize<ExportCheckpoint>(File.ReadAllText(checkpointPath, Utf8), Json)! : new ExportCheckpoint(signature, []) { TotalFiles = files.Length };
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
                var fileImages = images.Where(i => i.File == file).ToArray();
                var entries = selected.Where(e => e.File == file).ToArray(); var edits = entries.ToDictionary(e => (e.Container, e.ObjectId, e.Locator));
                var atlasChecks = new Dictionary<(string Container, long Id), string>();
                void Change(string container, long objectId, string loc, string sourceText, Action<string> set)
                {
                    var segments = edits.Values.Where(e => e.Container == container && e.ObjectId == objectId.ToString() && e.ParentLocator == loc).ToArray();
                    if (segments.Length > 0) {
                        set(SmartTextSegments.Rebuild(sourceText, segments));
                        foreach (var segment in segments) edits.Remove((segment.Container, segment.ObjectId, segment.Locator));
                        return;
                    }
                    if (!edits.TryGetValue((container, objectId.ToString(), loc), out var entry)) return;
                    if (entry.Source != sourceText) throw new Exception($"原文定位不一致：{file} / {loc}");
                    set(entry.Translation); edits.Remove((container, objectId.ToString(), loc));
                }
                if (fileImages.Any(i => i.Kind == "file")) ImageResources.ApplyFile(project, fileImages.Single(), destination);
                else if (entries.Any(e => e.Kind == "Mono 字面量"))
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
                    File.WriteAllText(destination, TextDocuments.Process(TextDocuments.Read(original), file, project.TextMode, item => Change("", 0, item.Locator, item.Text, item.Set)), Utf8);
                else VisitResource(original, (am, inst, container) =>
                {
                    PrepareTypes(am, inst);
                    var bitmapFonts = fonts.Where(f => f.File == file && f.Container == container && f.Kind != "UGUI").ToArray();
                    Dictionary<long, AssetTypeValueField> generated;
                    try { generated = bitmapFonts.Length == 0 ? [] : BitmapFontGenerator.Generate(am, inst, bitmapFonts, request, characters); }
                    catch (PausedException) { throw new PausedException(folder); }
                    foreach (var info in inst.file.Metadata.AssetInfos)
                    {
                        var relevant = entries.Where(e => e.Container == container && e.ObjectId == info.PathId.ToString()).ToArray();
                        var targetImage = fileImages.SingleOrDefault(i => i.Container == container && i.ObjectId == info.PathId.ToString());
                        var replaceFont = fonts.Any(f => f.Kind == "UGUI" && f.File == file && f.Container == container && f.ObjectId == info.PathId.ToString());
                        if (relevant.Length == 0 && targetImage == null && !replaceFont && !generated.ContainsKey(info.PathId)) continue;
                        var field = generated.TryGetValue(info.PathId, out var generatedField) ? generatedField : am.GetBaseField(inst, info);
                        if (targetImage != null) {
                            if (generated.ContainsKey(info.PathId)) throw new Exception("图片与字库共享同一纹理，不能覆盖：" + targetImage.Name);
                            ImageResources.ApplyTexture(project, targetImage, field);
                        }
                        if (relevant.Any(e => e.Kind == "TextAsset")) field["m_Script"].AsString = TextDocuments.Process(field["m_Script"].AsString, field["m_Name"].IsDummy ? "" : field["m_Name"].AsString, project.TextMode, item => Change(container, info.PathId, item.Locator, item.Text, item.Set));
                        else if (relevant.Any(e => e.Locator.StartsWith('/'))) GameText.VisitStrings(field, (loc, text, set) => Change(container, info.PathId, loc, text, set));
                        else if (relevant.Length > 0) Change(container, info.PathId, "m_Text", field["m_Text"].AsString, s => field["m_Text"].AsString = s);
                        var missing = relevant.Where(e => edits.ContainsKey((e.Container, e.ObjectId, e.Locator))).ToArray();
                        if (missing.Length > 0) throw new Exception($"资源文本字段未解析完整：{file} / 对象 {info.PathId} / {string.Join(", ", missing.Take(3).Select(e => e.Locator))}");
                        if (replaceFont)
                        {
                            var data = field["m_FontData"]["Array"];
                            if (data.IsDummy) throw new Exception("字体布局不支持替换 FontData");
                            SetFontData(data, font!);
                            if (!field["m_CharacterRects"].IsDummy) field["m_CharacterRects"]["Array"].Children.Clear();
                            if (!field["m_ConvertCase"].IsDummy) field["m_ConvertCase"].AsInt = -2;
                        }
                        info.SetNewData(field);
                        if (generated.ContainsKey(info.PathId)) atlasChecks[(container, info.PathId)] = BitmapFontGenerator.Digest(field, false);
                    }
                }, types, file, destination, source);
                if (edits.Count != 0) throw new Exception($"部分文本未能回写：{file}，剩余 {edits.Count} 条（{string.Join(", ", edits.Values.Take(3).Select(e => e.ObjectId + e.Locator))}）");
                Progress("重读校验：" + file, manifest.Count, files.Length, folder);
                VerifyWritten(project, file, destination, source, entries, fonts.Where(f => f.File == file && f.Kind == "UGUI").ToArray(), font, types, atlasChecks, fileImages);
                manifest.Add(new PatchFile(file, originalHash, Hash(destination), entries.Length));
                WriteJson(checkpointPath, checkpoint);
                Progress("已生成：" + file, manifest.Count, files.Length, folder);
            }
            CheckStop(request, folder);
            Save(project);
            File.WriteAllText(System.IO.Path.Combine(folder, "manifest.json"), JsonSerializer.Serialize(new { version = 1, textSafetyRevision = GameText.SafetyRevision, project.Root, files = manifest, warnings = project.Warnings, fontReplacements = fonts.Length, verification = "reopened", textureDependencies = images.Where(i => i.DependencyFile.Length > 0).GroupBy(i => i.DependencyFile).ToDictionary(g => g.Key, g => g.First().DependencyHash), fontRequirements = fontPlan.Requirements }, Json), Utf8);
            File.WriteAllText(System.IO.Path.Combine(folder, "使用说明.txt"), "先关闭游戏。patch 目录内是按游戏相对路径排列的补丁文件；确认备份后复制到游戏目录。original 目录保存本次修改文件的原件，按相同相对路径复制回去可恢复。manifest.json 记录原件及补丁哈希。\n补丁生成成功不代表已完成游戏加载或显示验证；图片文字、加密资源及 Addressables Catalog 未自动处理。TMP / NGUI 仅处理已通过布局检查的独立字库，图集与材质已重读校验，实际显示仍需启动游戏验证。\n", Utf8);
            File.Delete(marker);
            Progress("补丁与原件备份已生成", files.Length, files.Length, folder);
            return new { folder, files = files.Length, entries = selected.Length, images = images.Length, fontReplacements = fonts.Length };
        }
        catch (PausedException) { throw; }
        catch (Exception e) { File.WriteAllText(marker, "补丁生成失败，不可使用：" + e.Message, Utf8); throw new Exception($"{e.Message}；未完成输出：{folder}"); }
    }

    static void VerifyWritten(Project project, string file, string written, string sourcePath, Entry[] entries, FontInfo[] fonts, byte[]? font, GameTypes types, Dictionary<(string Container, long Id), string> atlasChecks, ImageResource[] images)
    {
        var remainingImages = images.Select(i => i.Id).ToHashSet();
        var expected = entries.ToDictionary(e => (e.Container, e.ObjectId, e.Locator));
        void Read(string container, long id, string locator, string text) {
            var key = (container, id.ToString(), locator);
            var segments = expected.Values.Where(e => e.Container == container && e.ObjectId == id.ToString() && e.ParentLocator == locator).ToArray();
            if (segments.Length > 0) {
                if (!project.SegmentSources.TryGetValue(segments[0].ParentId!, out var original)) throw new Exception("智能分段缺少完整原文，请重新扫描");
                if (text != SmartTextSegments.Rebuild(original, segments)) throw new Exception($"智能分段写回重读不一致：{file} / {id} / {locator}");
                foreach (var segment in segments) expected.Remove((segment.Container, segment.ObjectId, segment.Locator));
                return;
            }
            if (!expected.TryGetValue(key, out var entry)) return;
            if (text != entry.Translation) throw new Exception($"写回重读不一致：{file} / {id} / {locator}");
            expected.Remove(key);
        }
        if (images.Any(i => i.Kind == "file")) {
            var image = images.Single();
            using var sourceImage = File.OpenRead(written);
            var decoded = StbImageSharp.ImageResult.FromStream(sourceImage, StbImageSharp.ColorComponents.RedGreenBlueAlpha);
            if (decoded.Width != image.Width || decoded.Height != image.Height) throw new Exception("译图重读尺寸不一致：" + file);
            remainingImages.Remove(image.Id);
        } else if (entries.Any(e => e.Kind == "Mono 字面量")) {
            using var module = ModuleDefinition.ReadModule(written);
            foreach (var method in AllTypes(module.Types).SelectMany(t => t.Methods).Where(m => m.HasBody))
                foreach (var instruction in method.Body.Instructions.Where(i => i.OpCode == OpCodes.Ldstr)) Read("", 0, $"{method.MetadataToken.ToUInt32()}:{instruction.Offset}", (string)instruction.Operand);
        } else if (entries.Any(e => e.Kind == "IL2CPP 字面量")) VisitMetadata(File.ReadAllBytes(written), (loc, text, _) => Read("", 0, loc, text));
        else if (entries.Any(e => e.Kind == "文本文件")) TextDocuments.Process(TextDocuments.Read(written), file, project.TextMode, item => Read("", 0, item.Locator, item.Text));
        else VisitResource(written, (manager, instance, container) => {
            PrepareTypes(manager, instance);
            foreach (var info in instance.file.Metadata.AssetInfos) {
                if (atlasChecks.TryGetValue((container, info.PathId), out var digest)) {
                    if (BitmapFontGenerator.Digest(manager.GetBaseField(instance, info), false) != digest) throw new Exception("字库、图集或材质重读不一致：" + file + " / " + info.PathId);
                    atlasChecks.Remove((container, info.PathId));
                }
                var image = images.SingleOrDefault(i => i.Container == container && i.ObjectId == info.PathId.ToString());
                if (image != null) { ImageResources.VerifyTexture(project, image, manager.GetBaseField(instance, info)); remainingImages.Remove(image.Id); }
                var relevant = entries.Where(e => e.Container == container && e.ObjectId == info.PathId.ToString()).ToArray();
                var targetFont = fonts.FirstOrDefault(f => f.Container == container && f.ObjectId == info.PathId.ToString());
                if (relevant.Length == 0 && targetFont == null) continue;
                var field = manager.GetBaseField(instance, info);
                if (relevant.Any(e => e.Kind == "TextAsset")) TextDocuments.Process(field["m_Script"].AsString, field["m_Name"].IsDummy ? "" : field["m_Name"].AsString, project.TextMode, item => Read(container, info.PathId, item.Locator, item.Text));
                else foreach (var entry in relevant) {
                    var located = field;
                    var locator = entry.ParentLocator ?? entry.Locator;
                    if (!expected.ContainsKey((container, info.PathId.ToString(), entry.Locator))) continue;
                    var keys = locator.StartsWith('/') ? locator[1..].Split('/') : [locator];
                    foreach (var escaped in keys) {
                        if (located.IsDummy) break;
                        var key = escaped.Replace("~1", "/").Replace("~0", "~");
                        located = located.TemplateField.IsArray
                            ? int.TryParse(key, out var index) && index >= 0 && index < located.Children.Count ? located.Children[index] : AssetTypeValueField.DUMMY_FIELD
                            : located[key];
                    }
                    if (located.IsDummy || located.TemplateField.ValueType != AssetValueType.String)
                        throw new Exception($"写回重读未找到字段：{file} / 容器 {container} / 对象 {info.PathId} / 字段 {entry.Locator}");
                    Read(container, info.PathId, locator, located.AsString);
                }
                if (targetFont != null) {
                    var array = field["m_FontData"]["Array"];
                    var actual = array.TemplateField.ValueType == AssetValueType.ByteArray ? array.AsByteArray : array.Children.Select(c => unchecked((byte)c.AsInt)).ToArray();
                    if (font == null || !actual.SequenceEqual(font)) throw new Exception("字体数据重读不一致：" + file + " / " + info.PathId);
                    if (targetFont.References != null && !FontPreparation.References(field).SequenceEqual(targetFont.References)) throw new Exception("字体资源引用发生变化：" + file + " / " + info.PathId);
                }
            }
        }, types, file, sourcePath: sourcePath);
        if (expected.Count > 0) throw new Exception($"写回重读缺少 {expected.Count} 个字段：{file}\n" + string.Join("\n", expected.Values.Take(5).Select(entry => $"容器 {entry.Container} / 对象 {entry.ObjectId} / 字段 {entry.Locator}")));
        if (remainingImages.Count > 0) throw new Exception("译图重读缺少资源：" + file);
        if (atlasChecks.Count > 0) throw new Exception("写回重读缺少字库、图集或材质对象：" + file);
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

    internal static void RestorePatch(string root, string folder)
    {
        using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(folder, "manifest.json"), Utf8));
        var manifest = document.RootElement;
        if (!string.Equals(Path.GetFullPath(manifest.GetProperty("root").GetString()!).TrimEnd('\\', '/'), Path.GetFullPath(root).TrimEnd('\\', '/'), StringComparison.OrdinalIgnoreCase))
            throw new Exception("旧补丁不属于当前游戏，未清理");
        CheckGameClosed(root);
        var restore = new List<(string Original, string Target, string Hash)>();
        foreach (var file in manifest.GetProperty("files").EnumerateArray()) {
            var relative = file.GetProperty("file").GetString()!;
            var target = ApplyPath(root, relative); var original = ApplyPath(Path.Combine(folder, "original"), relative);
            var originalHash = file.GetProperty("originalSha256").GetString()!; var patchedHash = file.GetProperty("patchSha256").GetString()!;
            if (Hash(original) != originalHash) throw new Exception("原件备份校验失败，未清理：" + relative);
            var current = Hash(target);
            if (current != originalHash && current != patchedHash) throw new Exception("游戏文件已被其他程序修改，未清理原件备份：" + relative);
            if (current != originalHash) restore.Add((original, target, originalHash));
        }
        foreach (var file in restore) {
            Progress("恢复游戏原件：" + Path.GetRelativePath(root, file.Target));
            ReplaceFile(file.Original, file.Target);
            if (Hash(file.Target) != file.Hash) throw new Exception("游戏原件恢复后校验失败，旧补丁仍保留");
        }
        WriteJson(Path.Combine(folder, "application-state.json"), new { manifestHash = Hash(Path.Combine(folder, "manifest.json")), completed = Array.Empty<string>(), done = false });
    }

    public static object Apply(Request request)
    {
        var root = System.IO.Path.GetFullPath(request.Root);
        var folder = System.IO.Path.GetFullPath(request.Path);
        Progress("检查游戏进程、补丁和原件备份");
        if (File.Exists(System.IO.Path.Combine(folder, "INCOMPLETE.txt"))) throw new Exception("补丁未完整生成，不能应用");
        using var document = JsonDocument.Parse(File.ReadAllText(System.IO.Path.Combine(folder, "manifest.json"), Utf8));
        var manifest = document.RootElement;
        if (!manifest.TryGetProperty("textSafetyRevision", out var safety) || safety.GetInt32() < GameText.SafetyRevision)
            throw new Exception("旧版补丁缺少程序标识保护校验，已阻止应用。请重做生成补丁后再应用");
        if (manifest.GetProperty("version").GetInt32() != 1 || !string.Equals(System.IO.Path.GetFullPath(manifest.GetProperty("root").GetString()!), root, StringComparison.OrdinalIgnoreCase))
            throw new Exception("补丁不属于当前游戏");
        CheckGameClosed(root);
        if (manifest.TryGetProperty("textureDependencies", out var dependencies)) foreach (var dependency in dependencies.EnumerateObject())
            if (Hash(Within(root, dependency.Name)) != dependency.Value.GetString()) throw new Exception("图片外部数据已变化，未应用补丁：" + dependency.Name);
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
            try { WriteJson(applicationPath, new { manifestHash, completed = Array.Empty<string>(), done = false }); }
            catch (Exception checkpointError) { failed.Add("回滚状态保存失败：" + checkpointError.Message); }
            throw new Exception(e.Message + (failed.Count == 0 ? "；已回滚本次写入，原游戏文件已保留" : "；部分文件回滚失败，请从原件备份恢复：" + string.Join("；", failed)));
        }
        WriteJson(applicationPath, new { manifestHash, completed = applied, done = true });
        Progress("已应用到游戏，原件备份已保留", files.Length, files.Length, folder);
        return new { folder, files = files.Length };
    }
}

using System.Buffers.Binary;
using System.Diagnostics;
using System.Runtime.InteropServices;
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
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? LocalizationKey { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? LayoutDraft { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? TranslationTarget { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? LayoutDraftTarget { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? ScreeningDraft { get; set; }
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
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public ScanMetrics? ScanMetrics { get; set; }
}
public sealed class Request
{
    public string StopFile { get; set; } = "";
    public string Url { get; set; } = "";
    public string ReusePath { get; set; } = "";
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
    public string ImageSourceHash { get; set; } = "";
    public bool IncludeMosaic { get; set; }
    public string ImageData { get; set; } = "";
    public bool ImageOnly { get; set; }
    public string ImageResetPhase { get; set; } = "";
    public bool Thumbnail { get; set; }
    public bool CleanImageCache { get; set; }
    public string? SavedRenderedFile {get;set;}
    public int Step { get; set; }
    public string[]? SelectedIds { get; set; }
    public string[]? PatchImageIds { get; set; }
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
    public const int CurrentScanRevision = 9;
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
        var temp = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try {
            using (var stream = File.Create(temp)) JsonSerializer.Serialize(stream, value, Json);
            for (var attempt = 0; ; attempt++) {
                try { File.Move(temp, path, true); return; }
                // Windows may briefly deny replacing a checkpoint that was just published.
                catch (Exception error) when (OperatingSystem.IsWindows() &&
                    unchecked((uint)error.HResult) is 0x80070005 or 0x80070020 or 0x80070021) {
                    if (attempt == 3) throw new IOException($"保存检查点失败：{path}：{error.Message}", error);
                    Thread.Sleep(20 << attempt);
                }
            }
        } finally { if (File.Exists(temp)) File.Delete(temp); }
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
            var request = JsonSerializer.Deserialize<Request>(Console.OpenStandardInput(), Json) ?? throw new Exception("请求为空");
            if (args[0] is "font-plan" or "export") request.FontPath = FontPreparation.ResolveFontPath(request.FontPath);
            object result = args[0] switch
            {
                "scan" => Scan(request),
                "inspect" => ScanInspection.Inspect(request.Root),
                "generate-il2cpp-types" => Il2CppTypeDefinitions.Generate(request),
                "font-plan" => FontPreparation.Create(request),
                "find" => FindSaved(request),
                "workspace" => GameWorkspace.Open(request),
                "translation-directory" => new { folder = GameWorkspace.Ensure(request.Root) },
                "resume-info" => GameWorkspace.ResumeInfo(request),
                "save-task" => SaveTask(request),
                "reset-step" => WorkflowReset.Start(request),
                "prepare-rescan" => WorkflowReset.PrepareRescan(request),
                "finish-rescan" => WorkflowReset.FinishRescan(request),
                "load" => Load(request.Path),
                "save" => SaveRequest(request),
                "save-text-states" => SaveTextStates(request),
                "save-image" => ImageResources.SaveRendered(request),
                "save-image-states" => ImageResources.SaveStates(request),
                "preview-image" => ImageResources.Preview(request),
                "mosaic-status" => UnityMosaic.Status(request),
                "mosaic-preview" => UnityMosaic.Preview(request),
                "mosaic-save" => UnityMosaic.Save(request),
                "mosaic-select" => UnityMosaic.Select(request),
                "download-image" => DownloadImage(request.Url),
                "export" => Export(request),
                "apply" => Apply(request),
                "uninstall" => PatchInstallation.Uninstall(request),
                "installation-status" => request.Roots.Select(PatchInstallation.Status).ToArray(),
                _ => throw new Exception("未知操作")
            };
            JsonSerializer.Serialize(Console.OpenStandardOutput(), result, Json);
            return 0;
        }
        catch (PausedException e) { Console.Out.Write(JsonSerializer.Serialize(new { paused = true, folder = e.Folder }, Json)); return 0; }
        catch (Exception e) { Console.Error.Write(e.Message); return 1; }
    }

    static object DownloadImage(string url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https")) throw new Exception("网页图片地址须使用 HTTP 或 HTTPS");
        using var client = new System.Net.Http.HttpClient { Timeout = TimeSpan.FromSeconds(30) };
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        client.DefaultRequestHeaders.UserAgent.ParseAdd("Mozilla/5.0 LLMChat/1.0");
        using var response = client.GetAsync(uri, System.Net.Http.HttpCompletionOption.ResponseHeadersRead, timeout.Token).GetAwaiter().GetResult();
        if (!response.IsSuccessStatusCode) throw new Exception($"网页图片下载失败，HTTP {(int)response.StatusCode}；链接可能过期或需要登录");
        const int limit = 32 * 1024 * 1024;
        if (response.Content.Headers.ContentLength > limit) throw new Exception("网页图片超过 32 MiB");
        using var input = response.Content.ReadAsStreamAsync(timeout.Token).GetAwaiter().GetResult(); using var output = new MemoryStream();
        var buffer = new byte[65536]; int count;
        while ((count = input.ReadAsync(buffer.AsMemory(), timeout.Token).AsTask().GetAwaiter().GetResult()) > 0) { if (output.Length + count > limit) throw new Exception("网页图片超过 32 MiB"); output.Write(buffer, 0, count); }
        return new { data = Convert.ToBase64String(output.ToArray()), mime = response.Content.Headers.ContentType?.MediaType ?? "application/octet-stream" };
    }
    static object SaveTask(Request request) { GameWorkspace.SaveTask(request); return new { ok = true }; }
    static object SaveRequest(Request request) { var project=request.Project ?? throw new Exception("缺少工程");Save(project);var cleanup=request.CleanImageCache?ImageResources.CleanupCache(project):new ImageCacheCleanup(0,[]);return new { ok = true, cacheRemoved=cleanup.Removed,cacheErrors=cleanup.Errors }; }

    sealed record TextState(string Id, string Source, string Translation, bool Selected, string Error,
        string? TranslationTarget, string? LayoutDraft, string? LayoutDraftTarget, string? ScreeningDraft);
    sealed record TextStateBatch(string Revision, List<TextState> Rows);
    static string TextStatePath(string folder) => Within(folder, "text-translation-states.jsonl");
    static string ProjectRevision(string path) {
        var file = new FileInfo(path);
        return file.Length + "-" + file.LastWriteTimeUtc.Ticks;
    }
    static object SaveTextStates(Request request) {
        var project = request.Project ?? throw new Exception("缺少文本工程");
        var path = Within(project.Folder, "unity-project.json");
        if (!File.Exists(path)) throw new Exception("文本工程尚未保存");
        var batch = new TextStateBatch(ProjectRevision(path), project.Entries.Select(row => new TextState(row.Id, row.Source,
            row.Translation, row.Selected, row.Error, row.TranslationTarget, row.LayoutDraft, row.LayoutDraftTarget, row.ScreeningDraft)).ToList());
        CheckStop(request, project.Folder);
        using var output = new FileStream(TextStatePath(project.Folder), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.Read);
        if (output.Length > 0) {
            output.Position = output.Length - 1;
            if (output.ReadByte() != '\n') {
                Span<byte> tail = stackalloc byte[4096];
                var end = output.Length;
                long validLength = 0;
                while (end > 0) {
                    var length = (int)Math.Min(end, tail.Length); end -= length;
                    output.Position = end; output.ReadExactly(tail[..length]);
                    var newline = tail[..length].LastIndexOf((byte)'\n');
                    if (newline >= 0) { validLength = end + newline + 1; break; }
                }
                output.SetLength(validLength);
            }
        }
        output.Position = output.Length;
        output.Write(Utf8.GetBytes(JsonSerializer.Serialize(batch, ProgressJson) + "\n"));
        output.Flush(true);
        return new { saved = batch.Rows.Count };
    }
    static void LoadTextStates(Project project, string manifest) {
        var path = TextStatePath(project.Folder);
        if (!File.Exists(path)) return;
        var revision = ProjectRevision(manifest);
        var entries = project.Entries.ToDictionary(row => row.Id, StringComparer.Ordinal);
        using var reader = new StreamReader(path, Utf8);
        while (reader.ReadLine() is { } line) {
            TextStateBatch? batch;
            try { batch = JsonSerializer.Deserialize<TextStateBatch>(line, ProgressJson); }
            catch (JsonException) when (reader.EndOfStream) { break; }
            if (batch?.Revision != revision) continue;
            foreach (var saved in batch.Rows) {
                if (!entries.TryGetValue(saved.Id, out var entry) || entry.Source != saved.Source) continue;
                entry.Selected = saved.Selected; entry.Translation = saved.Translation; entry.Error = saved.Error;
                entry.TranslationTarget = saved.TranslationTarget;
                entry.LayoutDraft = saved.LayoutDraft; entry.LayoutDraftTarget = saved.LayoutDraftTarget;
                entry.ScreeningDraft = saved.ScreeningDraft;
            }
        }
    }

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
    static void WriteProjectSnapshot(Project project) => WriteJson(Path.Combine(project.Folder, "unity-project.json"), project);

    public static Project Save(Project project)
    {
        if (project.Version != 1 || !Directory.Exists(project.Folder)) throw new Exception("工程版本或目录无效");
        GameText.ProtectProject(project);
        var parents = project.Entries.Where(e => e.ParentId != null).Select(e => e.ParentId!).ToHashSet();
        foreach (var id in project.SegmentSources.Keys.Where(id => !parents.Contains(id)).ToArray()) project.SegmentSources.Remove(id);
        WriteProjectSnapshot(project);
        File.Delete(TextStatePath(project.Folder));
        ImageResources.CommitStates(project);
        return project;
    }
    public static Project Load(string path)
    {
        using var input = File.OpenRead(path);
        var project = JsonSerializer.Deserialize<Project>(input, Json) ?? throw new Exception("工程无效");
        project.Folder = System.IO.Path.GetDirectoryName(System.IO.Path.GetFullPath(path))!;
        if (project.Version != 1) throw new Exception("不支持此工程版本");
        var definitions = Path.Combine(project.Folder, "type-definitions");
        if (project.DefinitionHashes.Count > 0 || File.Exists(Path.Combine(definitions, ScanInspection.PendingDefinitions))) project.TypeDirectory = definitions;
        foreach (var e in project.Entries) _ = Within(project.Root, e.File);
        GameText.ProtectProject(project);
        LoadTextStates(project, path);
        ImageResources.LoadStates(project, File.GetLastWriteTimeUtc(path));
        var performance = Path.Combine(project.Folder, ScanMetrics.FileName);
        if (File.Exists(performance)) project.ScanMetrics = JsonSerializer.Deserialize<ScanMetrics>(File.ReadAllText(performance), Json);
        var imageFiles = project.Images.Select(image => image.File).ToHashSet(StringComparer.OrdinalIgnoreCase);
        project.Resources = project.Resources.Select(resource => resource.State == "empty" && imageFiles.Contains(resource.File) ? resource with { State = "ready" } : resource).ToList();
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
    public static bool TextCandidate(string text, int maximum = 16000) => text.Length > 0 && text.Length <= maximum &&
        (text.Length > 1 || Regex.IsMatch(text, "[ぁ-ゖァ-ヺ一-鿿가-힣]")) &&
        !text.Any(c => char.IsControl(c) && c is not '\r' and not '\n' and not '\t') &&
        text.Any(char.IsLetter) && !Regex.IsMatch(text.Trim(), @"^(?:https?://|[\w./\\-]+\.(?:png|jpg|asset|prefab|dll)|[A-Fa-f0-9]{16,}$)");
    public static void ValidateTranslation(string source, string translation)
    {
        var problem = TranslationIntegrity.Validate(source, translation);
        if (problem.Length > 0) throw new Exception(problem);
    }
    internal static Func<Entry, bool> WritableSelection(string[]? selectedIds)
    {
        var ids = selectedIds?.ToHashSet(StringComparer.Ordinal);
        return entry => entry.Selected && entry.Error.Length == 0 && (ids == null || ids.Contains(entry.Id))
            && TranslationIntegrity.Validate(entry.Source, entry.Translation).Length == 0;
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
        var clock = new ScanClock();
        var root = System.IO.Path.GetFullPath(request.Root);
        if (!Directory.Exists(root)) throw new Exception("游戏目录不存在");
        var output = System.IO.Path.GetFullPath(request.OutputRoot);
        if (GameWorkspace.IsProjectsRoot(root, output))
            GameWorkspace.Ensure(root);
        else if ((output.TrimEnd('\\', '/') + "/").Replace('\\', '/').StartsWith((root.TrimEnd('\\', '/') + "/").Replace('\\', '/'), StringComparison.OrdinalIgnoreCase))
            throw new Exception("游戏内工程只能保存在 LLMChat-Unity 工作文件夹中");
        var inspection = ScanInspection.Inspect(root);
        var yooPackages = YooAssetPackages.Find(root);
        var assemblies = request.IncludeCode ? ScanInspection.SelectedAssemblies(request, inspection) : [];
        var project = request.Path.Length > 0 ? Load(System.IO.Path.Combine(request.Path, "unity-project.json")) : new Project { Root = root, ScanRevision = CurrentScanRevision, TextMode = request.TextMode, TypeDirectory = request.TypeDirectory, Folder = NewFolder(output, "unity-project") };
        if (!string.Equals(project.Root, root, StringComparison.OrdinalIgnoreCase)) throw new Exception("扫描检查点不属于当前游戏");
        if (project.ScanRevision != CurrentScanRevision) throw new Exception("扫描检查点使用旧提取方式，请重新扫描；原工程和译文会保留");
        if (request.TextMode is not ("lines" or "paragraphs" or "smart")) throw new Exception("无效文本分段方式");
        var priorMetrics = project.ScanMetrics;
        using (clock.Measure(ScanPhase.Save)) Save(project);
        var options = new EnumerationOptions { RecurseSubdirectories = true, AttributesToSkip = FileAttributes.ReparsePoint, IgnoreInaccessible = false };
        var statePath = System.IO.Path.Combine(project.Folder, "scan-state.json");
        var pathsPath = System.IO.Path.Combine(project.Folder, "scan-files.json");
        Progress("正在列出游戏资源文件", folder: project.Folder);
        var state = File.Exists(statePath) ? JsonSerializer.Deserialize<ScanCheckpoint>(File.ReadAllText(statePath, Utf8), Json)! : new ScanCheckpoint(0, request.IncludeCode) { CodeAssemblies = assemblies, TextMode = request.TextMode, TypeDirectory = request.TypeDirectory };
        if (state.IncludeCode != request.IncludeCode || state.TextMode != request.TextMode || state.TypeDirectory != request.TypeDirectory || !(state.CodeAssemblies ?? []).SequenceEqual(assemblies, StringComparer.OrdinalIgnoreCase)) throw new Exception("扫描选项或程序集范围已变化，请重新扫描或恢复原选项");
        var workFolder = Path.GetFullPath(GameWorkspace.WorkRoot(root)).TrimEnd('\\', '/');
        var hasFileList = File.Exists(pathsPath);
        var paths = hasFileList ? JsonSerializer.Deserialize<string[]>(File.ReadAllText(pathsPath, Utf8), Json)!
            : new System.IO.Enumeration.FileSystemEnumerable<string>(root, (ref System.IO.Enumeration.FileSystemEntry entry) => entry.ToFullPath(), options) {
                ShouldIncludePredicate = (ref System.IO.Enumeration.FileSystemEntry entry) => !entry.IsDirectory,
                ShouldRecursePredicate = (ref System.IO.Enumeration.FileSystemEntry entry) =>
                    !entry.ToFullPath().Equals(workFolder, StringComparison.OrdinalIgnoreCase)
            }.ToArray();
        using (clock.Measure(ScanPhase.Save)) {
            if (!hasFileList) WriteJson(pathsPath, paths);
            if (!File.Exists(statePath)) WriteJson(statePath, state);
        }
        using (clock.Measure(ScanPhase.Check)) {
            if (request.TypeDirectory.Length > 0 && (project.DefinitionHashes.Count == 0 || File.Exists(Path.Combine(project.TypeDirectory, ScanInspection.PendingDefinitions)))) ScanInspection.CacheDefinitions(project, request.TypeDirectory, () => CheckStop(request, project.Folder));
            else ScanInspection.VerifyDefinitions(project);
        }
        using (clock.Measure(ScanPhase.Save)) Save(project);
        var scanIndex = state.Next;
        var lastSavedIndex = state.Next;
        var dirtyScan = false;
        var lastScanSave = Environment.TickCount64;
        var checkpointInterval = 2000L;
        var originals = PatchInstallation.OriginalFiles(root);
        var incremental = new IncrementalScan(project, paths, originals, clock, request.ReusePath);
        void CommitScan(int next, bool force = false) {
            var now = Environment.TickCount64;
            if (!force && now - lastScanSave < checkpointInterval) return;
            using var time = clock.Measure(ScanPhase.Save);
            if (dirtyScan) {
                // Load and explicit checkpoints normalize new entries. Periodic
                // snapshots only persist the state needed to resume the scan.
                if (force) Save(project);
                else WriteProjectSnapshot(project);
                incremental.Save();
                checkpointInterval = Math.Clamp((Environment.TickCount64 - now) * 8, 2000L, 10000L);
                dirtyScan = false;
            }
            // Advance the checkpoint only after the matching project snapshot is
            // durable. A crash replays the short unsaved tail, never skips it.
            if (next != lastSavedIndex) { WriteJson(statePath, state with { Next = next }); lastSavedIndex = next; }
            if (force) WriteJson(Path.Combine(project.Folder, ScanMetrics.FileName), clock.Snapshot(priorMetrics));
            lastScanSave = Environment.TickCount64;
        }
        long nextStopCheck = 0;
        void CheckScanStop() {
            if (request.StopFile.Length == 0) return;
            var now = Environment.TickCount64;
            if (now < nextStopCheck) return;
            nextStopCheck = now + 40;
            if (!File.Exists(request.StopFile)) return;
            CommitScan(scanIndex, true); throw new PausedException(project.Folder);
        }
        ImageResources.TextureScanCache? textureCache;
        using (clock.Measure(ScanPhase.Reuse))
            textureCache = request.ReusePath.Length > 0 ? new ImageResources.TextureScanCache(root, request.ReusePath) : null;
        incremental.Prepare(hasFileList, state.Next);
        long lastDetailReport = 0;
        var loadingModel = false;
        void ReportScanDetail(string detail) {
            var now = Environment.TickCount64;
            var loading = detail.StartsWith("加载分段模型：", StringComparison.Ordinal);
            if (!loading && !loadingModel && now - lastDetailReport < 250) return;
            loadingModel = loading; lastDetailReport = now;
            Progress(detail, scanIndex, paths.Length, project.Folder);
        }
        project.ReportScanDetail = ReportScanDetail;
        using var segmenter = project.TextMode == "smart" ? new SmartTextSegments(Path.Combine(AppContext.BaseDirectory, "wtp-model.onnx"), CheckScanStop, ReportScanDetail) : null;
        project.Segmenter = segmenter;
        project.CheckCancellation = CheckScanStop;
        using var types = new GameTypes(root, project.TypeDirectory);
        foreach (var file in project.Hashes)
            if (incremental.Hash(originals.GetValueOrDefault(file.Key) ?? Within(root, file.Key)) != file.Value)
                throw new Exception("已扫描文件发生变化，请重新扫描：" + file.Key);
        clock.Set(ScanPhase.Other);
        if (hasFileList && state.Next < paths.Length)
        {
            // The snapshot can be ahead of the checkpoint after a crash or
            // contain an unfinished file after a cooperative stop.
            var remaining = paths.Skip(state.Next).Select(path => Path.GetRelativePath(root, path)).ToHashSet(StringComparer.Ordinal);
            project.Entries.RemoveAll(entry => remaining.Contains(entry.File));
            project.Fonts.RemoveAll(font => remaining.Contains(font.File));
            project.Images.RemoveAll(image => remaining.Contains(image.File));
            project.Diagnostics.RemoveAll(issue => remaining.Contains(issue.File));
            project.Resources.RemoveAll(resource => remaining.Contains(resource.File));
            foreach (var file in project.Hashes.Keys.Where(remaining.Contains).ToArray()) project.Hashes.Remove(file);
        }
        for (var index = state.Next; index < paths.Length; index++)
        {
            scanIndex = index;
            CheckScanStop();
            var path = paths[index];
            var rel = System.IO.Path.GetRelativePath(root, path);
            var readPath = originals.GetValueOrDefault(rel) ?? path;
            var name = System.IO.Path.GetFileName(path);
            var ext = System.IO.Path.GetExtension(path).ToLowerInvariant();
            var isCode = request.IncludeCode && (name.Equals("global-metadata.dat", StringComparison.OrdinalIgnoreCase) || assemblies.Contains(rel, StringComparer.OrdinalIgnoreCase));
            var asset = ext is ".assets" or ".bundle" or ".unity3d" or ".ab" || name is "resources.assets" or "globalgamemanagers" || Regex.IsMatch(name, @"^(level\d+|CAB-[0-9a-f]+)$", RegexOptions.IgnoreCase);
            var raster = ext is ".png" or ".jpg" or ".jpeg" && GameText.PlainFile(root, rel);
            var plain = ext is ".txt" or ".json" or ".csv" or ".tsv" or ".xml" && GameText.PlainFile(root, rel) && !YooAssetPackages.IsCatalog(yooPackages, rel);
            if (!isCode && !asset && !plain && !raster) { CommitScan(index + 1); continue; }
            Progress("检查资源：" + rel, index, paths.Length, project.Folder);
            dirtyScan = true;
            var before = project.Entries.Count;
            var fonts = project.Fonts.Count; var imagesBefore = project.Images.Count;
            var diagnosticsBefore = project.Diagnostics.Count;
            try
            {
                var sourceDigest = new Lazy<string>(() => incremental.Hash(readPath));
                if (incremental.TryReuse(rel, readPath, sourceDigest.Value, CheckScanStop)) {
                    clock.Reused++;
                    CommitScan(index + 1);
                    Progress("已复用资源索引：" + rel, index + 1, paths.Length, project.Folder);
                    continue;
                }
                clock.Parsed++;
                var externals = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                int? metadataLiteralCount = null;
                using (clock.Measure(ScanPhase.Parse)) {
                    if (isCode && ext == ".dll") ScanAssembly(readPath, rel, project);
                    else if (isCode) {
                        var bytes = File.ReadAllBytes(readPath);
                        if (Il2CppMetadata.ReadVersion(bytes) == 39) {
                            var literals = Il2CppMetadata.ReadV39Literals(bytes, CheckScanStop);
                            var report = Path.Combine("il2cpp-strings", rel + ".json");
                            var destination = Within(project.Folder, report);
                            Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
                            WriteJson(destination, new { sourceFile = rel, metadataVersion = 39, literalCount = literals.Length, literals });
                            metadataLiteralCount = literals.Length;
                            project.Warnings.Add($"IL2CPP v39 字符串报告包含 {literals.Length} 条原始字面量，位于工程目录的 {report}。报告仅供查看。");
                        } else {
                            VisitMetadata(bytes, (loc, text, _) => Add(project, rel, "", 0, loc, "IL2CPP 字面量", text));
                        }
                    }
                    else if (raster) { using var decode = clock.Measure(ScanPhase.Decode); ImageResources.ScanFile(project, readPath, rel); }
                    else if (asset) VisitResource(readPath, (am, inst, container) => {
                        foreach (var external in inst.file.Metadata.Externals) externals.Add(external.PathName);
                        ScanAssets(am, inst, rel, container, project, textureCache, sourceDigest, clock);
                    }, types, rel, sourcePath: path, detail: ReportScanDetail, clock: clock);
                    else TextDocuments.Process(TextDocuments.Read(readPath), name, project.TextMode, item => { if (GameText.Visible(item.Field, item.Text, project.TextMode == "smart" ? int.MaxValue : 16000)) Add(project, rel, "", 0, item.Locator, "文本文件", item.Text, item.Locale); });
                }
                var failures = project.Diagnostics.Count - diagnosticsBefore;
                var hasResults = metadataLiteralCount.HasValue || project.Entries.Count > before || project.Fonts.Count > fonts || project.Images.Count > imagesBefore;
                if (hasResults) project.Hashes[rel] = sourceDigest.Value;
                if (failures == 0 && !metadataLiteralCount.HasValue) {
                    foreach (var image in project.Images.Skip(imagesBefore)) externals.Add(image.DependencyFile);
                    incremental.Remember(rel, sourceDigest.Value, asset, externals);
                }
                project.Resources.Add(new(rel, failures > 0 ? "partial" : hasResults ? "ready" : "empty", metadataLiteralCount ?? project.Entries.Count - before, project.Fonts.Count - fonts, failures));
            }
            catch (PausedException) { throw; }
            catch (Exception e)
            {
                project.Hashes.Remove(rel);
                project.Entries.RemoveRange(before, project.Entries.Count - before);
                project.Fonts.RemoveRange(fonts, project.Fonts.Count - fonts); project.Images.RemoveRange(imagesBefore, project.Images.Count - imagesBefore);
                project.Diagnostics.Add(ScanInspection.Issue(rel, "", "", e));
                project.Resources.Add(new(rel, "failed", 0, 0, project.Diagnostics.Count - diagnosticsBefore));
            }
            CommitScan(index + 1);
            Progress("已检查：" + rel, index + 1, paths.Length, project.Folder);
        }
        CommitScan(paths.Length, true);
        CheckStop(request, project.Folder);
        if (inspection.Catalogs.Length > 0) project.Warnings.Add($"检测到 {inspection.Catalogs.Length} 个 Addressables Catalog（JSON / BIN / Bundle）；资源修改后需核对 Catalog / CRC 和依赖，不能将加载失败直接视为加密。");
        foreach (var package in yooPackages) {
            CheckStop(request, project.Folder);
            project.Warnings.Add(YooAssetPackages.Describe(root, package, () => CheckStop(request, project.Folder)));
        }
        project.Warnings = project.Warnings.Distinct().ToList();
        using (clock.Measure(ScanPhase.Save)) {
            Save(project);
            incremental.Save(complete: true);
        }
        project.ScanMetrics = clock.Snapshot(priorMetrics);
        WriteJson(Path.Combine(project.Folder, ScanMetrics.FileName), project.ScanMetrics);
        Progress($"扫描完成：{project.Entries.Count} 条文本；{project.Resources.Count(r => r.State == "ready")} 个可读取，{project.Resources.Count(r => r.State == "empty")} 个无目标，{project.Resources.Count(r => r.State == "partial")} 个部分解析，{project.Resources.Count(r => r.State == "failed")} 个失败", paths.Length, paths.Length, project.Folder);
        return project;
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
        var version = Il2CppMetadata.ReadVersion(bytes);
        if (version == 39) throw new InvalidDataException("IL2CPP v39 字面量只支持读取报告");
        if (version is < 24 or > 31) throw new InvalidDataException($"不支持 IL2CPP metadata 版本 {version}");
        int I(int p) => BinaryPrimitives.ReadInt32LittleEndian(bytes.AsSpan(p, 4));
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

    internal static void VisitResource(string path, Action<AssetsManager, AssetsFileInstance, string> visit, GameTypes types, string relative, string? destination = null, string? sourcePath = null, Action<string>? detail = null, ScanClock? clock = null)
    {
        var am = new AssetsManager();
        types.Configure(am, relative);
        try
        {
            using var input = File.OpenRead(path);
            var signature = new byte[8];
            using (clock?.Measure(ScanPhase.Open)) {
                var tpk = System.IO.Path.Combine(AppContext.BaseDirectory, "classdata.tpk");
                if (File.Exists(tpk)) am.LoadClassPackage(tpk);
                input.ReadExactly(signature); input.Position = 0;
            }
            // Read the verified backup, but resolve external MonoScript/type
            // dependencies beside the game's original resource, not the backup.
            var dependencyPath = sourcePath ?? path;
            if (Encoding.ASCII.GetString(signature).StartsWith("Unity"))
            {
                detail?.Invoke("正在打开资源包：" + relative);
                BundleFileInstance bundle;
                using (clock?.Measure(ScanPhase.Open)) bundle = am.LoadBundleFile(input, dependencyPath, true);
                for (var i = 0; i < bundle.file.BlockAndDirInfo.DirectoryInfos.Count; i++)
                {
                    detail?.Invoke($"正在读取资源块 {i + 1}/{bundle.file.BlockAndDirInfo.DirectoryInfos.Count}：{bundle.file.GetFileName(i)}");
                    AssetsFileInstance? inst;
                    using (clock?.Measure(ScanPhase.Open)) inst = am.LoadAssetsFileFromBundle(bundle, i, false);
                    if (inst == null) continue;
                    visit(am, inst, bundle.file.GetFileName(i));
                    if (destination != null) bundle.file.BlockAndDirInfo.DirectoryInfos[i].SetNewData(inst.file);
                }
                if (destination != null) { using var writer = new AssetsFileWriter(destination); bundle.file.Write(writer); }
            }
            else
            {
                detail?.Invoke("正在读取资源文件：" + relative);
                AssetsFileInstance inst;
                using (clock?.Measure(ScanPhase.Open)) inst = am.LoadAssetsFile(input, dependencyPath, false);
                visit(am, inst, "");
                if (destination != null) { using var writer = new AssetsFileWriter(destination); inst.file.Write(writer); }
            }
        }
        finally { am.UnloadAll(); }
    }
    internal static void PrepareTypes(AssetsManager am, AssetsFileInstance inst)
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
    static void ScanAssets(AssetsManager am, AssetsFileInstance inst, string rel, string container, Project project, ImageResources.TextureScanCache? textureCache, Lazy<string> sourceDigest, ScanClock clock)
    {
        project.ReportScanDetail?.Invoke($"读取类型与纹理索引：{rel} / {container}");
        PrepareTypes(am, inst);
        var fontTextures = ImageResources.FontTextures(am, inst);
        var hidc = new HidcImages.ScanIndex();
        var firstImage = project.Images.Count;
        var dependencyHashes = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var objectIndex = 0;
        long nextObjectReport = 0;
        foreach (var info in inst.file.Metadata.AssetInfos)
        {
            project.CheckCancellation?.Invoke();
            objectIndex++;
            var now = Environment.TickCount64;
            if (now >= nextObjectReport) {
                nextObjectReport = now + 260;
                var location = container.Length > 0 ? rel + " / " + container : rel;
                project.ReportScanDetail?.Invoke($"读取资源对象：{location} · 对象 {objectIndex} / {inst.file.Metadata.AssetInfos.Count} · 已提取 {project.Entries.Count} 条文本");
            }
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
                if (type == 28) ImageResources.ScanTexture(project, inst, field, rel, container, info.PathId, fontTextures.Contains(info.PathId), dependencyHashes, textureCache, sourceDigest,
                    stage => project.ReportScanDetail?.Invoke($"{stage}：{name} · {rel} · 对象 {objectIndex} / {inst.file.Metadata.AssetInfos.Count}"), clock);
                if (type == 128) project.Fonts.Add(new FontInfo(rel, container, info.PathId.ToString(), name, "UGUI") { References = FontPreparation.References(field) });
                if (type == 49) {
                    var bytes = field["m_Script"].AsByteArray;
                    if (!hidc.AddChunk(name, info.PathId, bytes) && GameText.TextAsset(name))
                        TextDocuments.Process(Utf8.GetString(bytes), name, project.TextMode, item => { if (GameText.Visible(item.Field, item.Text, project.TextMode == "smart" ? int.MaxValue : 16000)) Add(project, rel, container, info.PathId, item.Locator, "TextAsset", item.Text, item.Locale); });
                }
                if (type == 114)
                {
                    hidc.AddManifest(field);
                    var fontKind = BitmapFontGenerator.FontKind(field);
                    if (fontKind != null) project.Fonts.Add(new FontInfo(rel, container, info.PathId.ToString(), name, fontKind) { References = FontPreparation.References(field) });
                    else GameLocalization.Visit(field, project.Root, rel, (loc, text, locale, key) => {
                        var start = project.Entries.Count;
                        Add(project, rel, container, info.PathId, loc, "游戏文本", text, locale);
                        for (var n = start; n < project.Entries.Count; n++) project.Entries[n].LocalizationKey = key.Length == 0 ? null : key;
                    });
                }
            }
            catch (PausedException) { throw; }
            catch (Exception e) {
                project.Entries.RemoveRange(textCount, project.Entries.Count - textCount);
                project.Fonts.RemoveRange(fontCount, project.Fonts.Count - fontCount);
                project.Diagnostics.Add(ScanInspection.Issue(rel, container, info.PathId.ToString(), e, ObjectDescription(am, inst, info)));
            }
        }
        hidc.Publish(project, rel, container, firstImage);
    }

    public static object Export(Request request)
    {
        Progress("校验译文、占位符与字体");
        var project = request.Project ?? throw new Exception("缺少工程");
        GameText.ProtectProject(project);
        var originals = PatchInstallation.OriginalFiles(project.Root);
        if (project.ScanRevision < MinimumUsableScanRevision || project.ScanRevision > CurrentScanRevision) throw new Exception("扫描工程格式不兼容，请重新扫描；原工程和译文会保留");
        ScanInspection.VerifyDefinitions(project);
        using var types = new GameTypes(project.Root, project.TypeDirectory);
        var selected = project.Entries.Where(WritableSelection(request.SelectedIds)).ToArray();
        var translatedImages = ImageResources.Ready(project, request.PatchImageIds);
        var mosaic = UnityMosaic.Included(project);
        if (selected.Length == 0 && translatedImages.Length == 0 && mosaic.Count == 0)
            throw new Exception("没有可回写的译文、译图或去码图");
        ImageResource[] images = UnityMosaic.Prepare(project, translatedImages, mosaic, () => CheckStop(request, request.Path));
        if (mosaic.Count > 0) ImageResources.VerifyDependencies(project, images.Where(image => mosaic.ContainsKey(image.Id)));
        var writable = new HashSet<Entry>(selected, ReferenceEqualityComparer.Instance);
        var (fontPlan, characters, font) = FontPreparation.Prepare(request, project, writable.Contains, false);
        if (selected.Length == 0) font = null;
        if (font != null && fontPlan.Missing.Length > 0) throw new Exception($"所选字体缺少 {fontPlan.Missing.Length} 个字符：{string.Join("、", fontPlan.Missing.Take(24).Select(code => $"{char.ConvertFromUtf32(code)} U+{code:X4}"))}。检查报告：{Path.Combine(fontPlan.Folder, "字库检查.txt")}");
        var fonts = font == null ? [] : project.Fonts.Where(f => f.Kind == "UGUI" || f.Kind.StartsWith("TMP", StringComparison.Ordinal) || f.Kind.StartsWith("NGUI", StringComparison.Ordinal)).ToArray();
        if (font != null && fonts.Length == 0) throw new Exception("未扫描到可替换的字体，请先扫描游戏字体资源");
        var files = selected.Select(e => e.File).Concat(fonts.Select(f => f.File)).Concat(images.Select(i => i.File)).Distinct().ToArray();
        YooAssetPackages.EnsureWritable(project.Root, files);
        var signature = Convert.ToHexString(SHA256.HashData(Utf8.GetBytes(JsonSerializer.Serialize(new { selected, images, fonts, characters, atlasRevision = BitmapFontGenerator.Revision, font = font == null ? "" : Convert.ToHexString(SHA256.HashData(font)) }, Json))));
        var folder = request.Path.Length > 0 ? Within(project.Folder, System.IO.Path.GetRelativePath(project.Folder, request.Path)) : NewFolder(project.Folder, "patch");
        var checkpointPath = System.IO.Path.Combine(folder, "export-state.json");
        var checkpoint = File.Exists(checkpointPath) ? JsonSerializer.Deserialize<ExportCheckpoint>(File.ReadAllText(checkpointPath, Utf8), Json)! : new ExportCheckpoint(signature, []) { TotalFiles = files.Length };
        if (checkpoint.Signature != signature) throw new Exception("译文、选取、字体或字库生成方式已变化，请重做生成补丁；已有译文保留");
        WriteJson(checkpointPath, checkpoint);
        Progress("准备生成资源补丁", checkpoint.Files.Count, files.Length, folder);
        var marker = System.IO.Path.Combine(folder, "INCOMPLETE.txt");
        File.WriteAllText(marker, "补丁尚未生成完成，不能使用。", Utf8);
        try
        {
            var manifest = checkpoint.Files;
            var completedFiles = manifest.Select(item => item.File).ToHashSet(StringComparer.Ordinal);
            var imagesByFile = images.ToLookup(item => item.File, StringComparer.Ordinal);
            var textByFile = selected.ToLookup(item => item.File, StringComparer.Ordinal);
            var fontsByFile = fonts.ToLookup(item => item.File, StringComparer.Ordinal);
            foreach (var completed in manifest)
                if (Hash(originals.GetValueOrDefault(completed.File) ?? Within(project.Root, completed.File)) != completed.OriginalSha256 || Hash(Within(System.IO.Path.Combine(folder, "original"), completed.File)) != completed.OriginalSha256 || Hash(Within(System.IO.Path.Combine(folder, "patch"), completed.File)) != completed.PatchSha256)
                    throw new Exception("已生成的补丁或原件发生变化：" + completed.File);
            foreach (var file in files)
            {
                CheckStop(request, folder);
                if (completedFiles.Contains(file)) continue;
                Progress("生成补丁：" + file, manifest.Count, files.Length, folder);
                var source = originals.GetValueOrDefault(file) ?? Within(project.Root, file); var original = Within(System.IO.Path.Combine(folder, "original"), file);
                if (!project.Hashes.TryGetValue(file, out var expected) || expected != Hash(source)) throw new Exception($"源文件已变化，请重新扫描：{file}");
                Directory.CreateDirectory(System.IO.Path.GetDirectoryName(original)!);
                if (!File.Exists(original)) File.Copy(source, original);
                var originalHash = Hash(original);
                if (expected != originalHash) throw new Exception($"原件备份校验失败：{file}");
                var destination = Within(System.IO.Path.Combine(folder, "patch"), file); Directory.CreateDirectory(System.IO.Path.GetDirectoryName(destination)!);
                var fileImages = imagesByFile[file].ToArray();
                var entries = textByFile[file].ToArray(); var edits = entries.ToDictionary(e => (e.Container, e.ObjectId, e.Locator));
                var byObject = entries.ToLookup(e => (e.Container, e.ObjectId));
                var byParent = entries.Where(e => e.ParentLocator != null).ToLookup(e => (e.Container, e.ObjectId, e.ParentLocator));
                var atlasChecks = new Dictionary<(string Container, long Id), string>();
                void Change(string container, long objectId, string loc, string sourceText, Action<string> set)
                {
                    var segments = byParent[(container, objectId.ToString(), loc)].Where(e => edits.ContainsKey((e.Container, e.ObjectId, e.Locator))).ToArray();
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
                    using var resolver = new DefaultAssemblyResolver();
                    resolver.AddSearchDirectory(Path.GetDirectoryName(Within(project.Root, file))!);
                    using var module = ModuleDefinition.ReadModule(original, new ReaderParameters { AssemblyResolver = resolver });
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
                    var bitmapFonts = fontsByFile[file].Where(f => f.Container == container && f.Kind != "UGUI").ToArray();
                    Dictionary<long, AssetTypeValueField> generated;
                    try { generated = bitmapFonts.Length == 0 ? [] : BitmapFontGenerator.Generate(am, inst, bitmapFonts, request, characters); }
                    catch (PausedException) { throw new PausedException(folder); }
                    foreach (var info in inst.file.Metadata.AssetInfos)
                    {
                        var relevant = byObject[(container, info.PathId.ToString())].ToArray();
                        var targetImages = fileImages.Where(i => i.Container == container && i.ObjectId == info.PathId.ToString()).ToArray();
                        var targetImage = targetImages.FirstOrDefault();
                        var replaceFont = fonts.Any(f => f.Kind == "UGUI" && f.File == file && f.Container == container && f.ObjectId == info.PathId.ToString());
                        if (relevant.Length == 0 && targetImage == null && !replaceFont && !generated.ContainsKey(info.PathId)) continue;
                        var field = generated.TryGetValue(info.PathId, out var generatedField) ? generatedField : am.GetBaseField(inst, info);
                        if (targetImage != null) {
                            if (generated.ContainsKey(info.PathId)) throw new Exception("图片与字库共享同一纹理，不能覆盖：" + targetImage.Name);
                            if (targetImage.Kind == "hidc") HidcImages.Apply(project, targetImages, field);
                            else ImageResources.ApplyTexture(project, targetImage, field);
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
                }, types, file, destination, Within(project.Root, file));
                if (edits.Count != 0) throw new Exception($"部分文本未能回写：{file}，剩余 {edits.Count} 条（{string.Join(", ", edits.Values.Take(3).Select(e => e.ObjectId + e.Locator))}）");
                Progress("重读校验：" + file, manifest.Count, files.Length, folder);
                var verificationTick = 0L;
                void ReportVerification(string detail, bool force = false) {
                    var now = Environment.TickCount64;
                    if (!force && now - verificationTick < 500) return;
                    verificationTick = now;
                    Progress(detail, manifest.Count, files.Length, folder);
                }
                VerifyWritten(project, file, destination, Within(project.Root, file), entries, fontsByFile[file].Where(f => f.Kind == "UGUI").ToArray(), font, types, atlasChecks, fileImages, ReportVerification, () => CheckStop(request, folder));
                ReportVerification("正在计算补丁校验值：" + file, true);
                manifest.Add(new PatchFile(file, originalHash, Hash(destination), entries.Length));
                ReportVerification("正在保存生成进度：" + file, true);
                WriteJson(checkpointPath, checkpoint);
                Progress("已生成：" + file, manifest.Count, files.Length, folder);
            }
            CheckStop(request, folder);
            AddressableCatalog.Update(project, folder, manifest, originals, () => CheckStop(request, folder));
            checkpoint = checkpoint with { TotalFiles = manifest.Count };
            WriteJson(checkpointPath, checkpoint);
            Progress("正在保存工程和补丁清单", manifest.Count, manifest.Count, folder);
            Save(project);
            File.WriteAllText(System.IO.Path.Combine(folder, "manifest.json"), JsonSerializer.Serialize(new { version = 1, textSafetyRevision = GameText.SafetyRevision, project.Root, files = manifest, warnings = project.Warnings, fontReplacements = fonts.Length, verification = "reopened", textureDependencies = images.Where(i => i.DependencyFile.Length > 0).GroupBy(i => i.DependencyFile).ToDictionary(g => g.Key, g => g.First().DependencyHash), fontRequirements = fontPlan.Requirements }, Json), Utf8);
            File.WriteAllText(System.IO.Path.Combine(folder, "使用说明.txt"), "先关闭游戏。patch 目录内是按游戏相对路径排列的补丁文件；确认备份后复制到游戏目录。original 目录保存本次修改文件的原件，按相同相对路径复制回去可恢复。manifest.json 记录原件及补丁哈希。\n图片写回包含已完成且选中的译图，以及已纳入补丁的去码图。支持 Texture2D、普通图片与 HIDC v2/v3。Addressables 二进制 Catalog v2 的 CRC、缓存哈希会同步更新；其他 Catalog 格式会明确停止生成。TMP / NGUI 仅处理已通过布局检查的独立字库，图集与材质已重读校验，实际显示仍需启动游戏验证。\n", Utf8);
            File.Delete(marker);
            Progress("补丁与原件备份已生成", manifest.Count, manifest.Count, folder);
            return new { folder, files = manifest.Count, entries = selected.Length, images = translatedImages.Length, mosaicImages = mosaic.Count, fontReplacements = fonts.Length, fontMappings = fontPlan.Requirements.Where(line => line.StartsWith("真实字形补入：", StringComparison.Ordinal)).ToArray() };
        }
        catch (PausedException) { throw; }
        catch (Exception e) { File.WriteAllText(marker, "补丁生成失败，不可使用：" + e.Message, Utf8); throw new Exception($"{e.Message}；未完成输出：{folder}"); }
    }

    static void VerifyWritten(Project project, string file, string written, string sourcePath, Entry[] entries, FontInfo[] fonts, byte[]? font, GameTypes types, Dictionary<(string Container, long Id), string> atlasChecks, ImageResource[] images, Action<string, bool> report, Action checkStop)
    {
        var remainingImages = images.Select(i => i.Id).ToHashSet();
        var expected = entries.ToDictionary(e => (e.Container, e.ObjectId, e.Locator));
        var segmentsByParent = entries.Where(entry => entry.ParentLocator != null).GroupBy(entry => (entry.Container, entry.ObjectId, Locator: entry.ParentLocator!)).ToDictionary(group => group.Key, group => group.ToArray());
        var entriesByObject = entries.GroupBy(entry => (entry.Container, entry.ObjectId)).ToDictionary(group => group.Key, group => group.ToArray());
        var imagesByObject = images.GroupBy(image => (image.Container, image.ObjectId)).ToDictionary(group => group.Key, group => group.ToArray());
        var fontsByObject = fonts.ToDictionary(item => (item.Container, item.ObjectId));
        var nextTextReport = 128;
        void ReportText() {
            var verified = entries.Length - expected.Count;
            if (verified < nextTextReport) return;
            nextTextReport = verified + 128;
            checkStop(); report($"正在核对译文：{verified}/{entries.Length} 条 · {file}", false);
        }
        checkStop(); report("正在重新打开补丁资源：" + file, true);
        void Read(string container, long id, string locator, string text) {
            var key = (container, id.ToString(), locator);
            if (segmentsByParent.Remove(key, out var segments)) {
                if (!project.SegmentSources.TryGetValue(segments[0].ParentId!, out var original)) throw new Exception("智能分段缺少完整原文，请重新扫描");
                if (text != SmartTextSegments.Rebuild(original, segments)) throw new Exception($"智能分段写回重读不一致：{file} / {id} / {locator}");
                foreach (var segment in segments) expected.Remove((segment.Container, segment.ObjectId, segment.Locator));
                ReportText();
                return;
            }
            if (!expected.TryGetValue(key, out var entry)) return;
            if (text != entry.Translation) throw new Exception($"写回重读不一致：{file} / {id} / {locator}");
            expected.Remove(key);
            ReportText();
        }
        if (images.Any(i => i.Kind == "file")) {
            var image = images.Single();
            using var sourceImage = File.OpenRead(written);
            var decoded = StbImageSharp.ImageResult.FromStream(sourceImage, StbImageSharp.ColorComponents.RedGreenBlueAlpha);
            if (decoded.Width != image.Width || decoded.Height != image.Height) throw new Exception("译图重读尺寸不一致：" + file);
            remainingImages.Remove(image.Id);
        } else if (entries.Any(e => e.Kind == "Mono 字面量")) {
            using var resolver = new DefaultAssemblyResolver();
            resolver.AddSearchDirectory(Path.GetDirectoryName(Within(project.Root, file))!);
            using var module = ModuleDefinition.ReadModule(written, new ReaderParameters { AssemblyResolver = resolver });
            foreach (var method in AllTypes(module.Types).SelectMany(t => t.Methods).Where(m => m.HasBody))
                foreach (var instruction in method.Body.Instructions.Where(i => i.OpCode == OpCodes.Ldstr)) Read("", 0, $"{method.MetadataToken.ToUInt32()}:{instruction.Offset}", (string)instruction.Operand);
        } else if (entries.Any(e => e.Kind == "IL2CPP 字面量")) VisitMetadata(File.ReadAllBytes(written), (loc, text, _) => Read("", 0, loc, text));
        else if (entries.Any(e => e.Kind == "文本文件")) TextDocuments.Process(TextDocuments.Read(written), file, project.TextMode, item => Read("", 0, item.Locator, item.Text));
        else VisitResource(written, (manager, instance, container) => {
            checkStop(); report("正在准备资源类型：" + container, false);
            PrepareTypes(manager, instance);
            var objectIndex = 0;
            foreach (var info in instance.file.Metadata.AssetInfos) {
                objectIndex++;
                if ((objectIndex & 127) == 1) { checkStop(); report($"正在核对资源对象：{container} · {objectIndex}/{instance.file.Metadata.AssetInfos.Count} · 已核对译文 {entries.Length - expected.Count}/{entries.Length} 条", false); }
                if (atlasChecks.TryGetValue((container, info.PathId), out var digest)) {
                    checkStop(); report($"正在核对{(info.TypeId == 28 ? "图集" : info.TypeId == 21 ? "材质" : "字库")}：{container} · 对象 {info.PathId}", true);
                    if (BitmapFontGenerator.Digest(manager.GetBaseField(instance, info), false) != digest) throw new Exception("字库、图集或材质重读不一致：" + file + " / " + info.PathId);
                    atlasChecks.Remove((container, info.PathId));
                }
                var objectKey = (container, info.PathId.ToString());
                if (imagesByObject.TryGetValue(objectKey, out var objectImages)) {
                    report($"正在核对译图：{objectImages[0].Name} · 对象 {info.PathId}", false);
                    var imageField = manager.GetBaseField(instance, info);
                    if (objectImages[0].Kind == "hidc") HidcImages.Verify(project, objectImages, imageField);
                    else ImageResources.VerifyTexture(project, objectImages.Single(), imageField);
                    foreach (var image in objectImages) remainingImages.Remove(image.Id);
                }
                var relevant = entriesByObject.TryGetValue(objectKey, out var objectEntries) ? objectEntries : [];
                fontsByObject.TryGetValue(objectKey, out var targetFont);
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
                    report($"正在核对字体数据：{targetFont.Name} · 对象 {info.PathId}", true);
                    var array = field["m_FontData"]["Array"];
                    var actual = array.TemplateField.ValueType == AssetValueType.ByteArray ? array.AsByteArray : array.Children.Select(c => unchecked((byte)c.AsInt)).ToArray();
                    if (font == null || !actual.SequenceEqual(font)) throw new Exception("字体数据重读不一致：" + file + " / " + info.PathId);
                    if (targetFont.References != null && !FontPreparation.References(field).SequenceEqual(targetFont.References)) throw new Exception("字体资源引用发生变化：" + file + " / " + info.PathId);
                }
            }
        }, types, file, sourcePath: sourcePath, detail: detail => { checkStop(); report(detail, false); });
        if (expected.Count > 0) throw new Exception($"写回重读缺少 {expected.Count} 个字段：{file}\n" + string.Join("\n", expected.Values.Take(5).Select(entry => $"容器 {entry.Container} / 对象 {entry.ObjectId} / 字段 {entry.Locator}")));
        if (remainingImages.Count > 0) throw new Exception("译图重读缺少资源：" + file);
        if (atlasChecks.Count > 0) throw new Exception("写回重读缺少字库、图集或材质对象：" + file);
        report($"重读校验完成：{file} · {entries.Length} 条译文", true);
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    static extern uint GetShortPathNameW(string path, StringBuilder? buffer, uint capacity);

    static void CheckGameClosed(string root)
    {
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var path in Directory.EnumerateFiles(root, "*.exe", new EnumerationOptions { RecurseSubdirectories = true, AttributesToSkip = FileAttributes.ReparsePoint })) {
            names.Add(System.IO.Path.GetFileNameWithoutExtension(path));
            if (!OperatingSystem.IsWindows()) continue;
            // ProcessName can itself be the 8.3 alias when launched from a shortcut.
            var capacity = GetShortPathNameW(path, null, 0);
            if (capacity == 0) continue;
            var shortPath = new StringBuilder(checked((int)capacity));
            var written = GetShortPathNameW(path, shortPath, capacity);
            if (written > 0 && written < capacity)
                names.Add(System.IO.Path.GetFileNameWithoutExtension(shortPath.ToString()));
        }
        foreach (var process in Process.GetProcesses())
        {
            using (process)
            {
                if (!names.Contains(process.ProcessName)) continue;
                string? executable;
                try { executable = process.MainModule?.FileName; }
                catch (InvalidOperationException) { continue; } // The process exited during inspection.
                catch (Exception e) { throw new Exception($"无法确认 {process.ProcessName} 是否为当前游戏，请关闭该程序后重试：{e.Message}"); }
                if (executable != null && System.IO.Path.GetFullPath(executable).StartsWith(root.TrimEnd('\\', '/') + System.IO.Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
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
        var manifestBytes = File.ReadAllBytes(System.IO.Path.Combine(folder, "manifest.json"));
        var offset = manifestBytes.AsSpan().StartsWith(new byte[] { 0xef, 0xbb, 0xbf }) ? 3 : 0;
        using var document = JsonDocument.Parse(manifestBytes.AsMemory(offset));
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
        var manifestHash = Convert.ToHexString(SHA256.HashData(manifestBytes));
        var resuming = File.Exists(applicationPath);
        if (resuming) {
            using var previous = JsonDocument.Parse(File.ReadAllText(applicationPath, Utf8));
            if (previous.RootElement.GetProperty("manifestHash").GetString() != manifestHash) throw new Exception("应用检查点与补丁清单不一致");
        }
        if (files.Length == 0 || files.Select(f => f.File).Distinct(StringComparer.OrdinalIgnoreCase).Count() != files.Length) throw new Exception("补丁文件列表无效");
        YooAssetPackages.EnsureWritable(root, files.Select(f => f.File));
        foreach (var file in files) if (Hash(Within(Path.Combine(folder, "original"), file.File)) != file.Original || Hash(Within(Path.Combine(folder, "patch"), file.File)) != file.Patch) throw new Exception("新补丁或备份校验失败：" + file.File);
        var restoredPatches = PatchInstallation.RestoreBeforeApply(root, folder);
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
            var remaining = new List<string>();
            var originalHashes = files.ToDictionary(file => file.File, file => file.Original);
            foreach (var file in applied.AsEnumerable().Reverse())
                try {
                    var target = Within(root, file);
                    ReplaceFile(Within(System.IO.Path.Combine(folder, "original"), file), target);
                    if (Hash(target) != originalHashes[file]) throw new Exception("恢复后校验失败");
                }
                catch (Exception rollback) { remaining.Add(file); failed.Add(file + "：" + rollback.Message); }
            try { WriteJson(applicationPath, new { manifestHash, completed = remaining, done = false }); }
            catch (Exception checkpointError) { failed.Add("回滚状态保存失败：" + checkpointError.Message); }
            throw new Exception(e.Message + (failed.Count == 0 ? "；已回滚本次写入，原游戏文件已保留" : "；部分文件回滚失败，请从原件备份恢复：" + string.Join("；", failed)));
        }
        WriteJson(applicationPath, new { manifestHash, completed = applied, done = true });
        Progress("已应用到游戏，原件备份已保留", files.Length, files.Length, folder);
        return new { folder, files = files.Length, restoredPatches };
    }
}

using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace LLMChat.UnityOffline;

public sealed record WorkspaceResult(string WorkRoot, string ProjectsRoot, SavedProject Saved, JsonNode? Task);

public static class GameWorkspace
{
    public const string FolderName = "LLMChat-Unity";
    static readonly string[] FolderKeys = ["projectFolder", "scanFolder", "patchFolder", "previousProjectFolder"];
    static string Full(string path) => Path.GetFullPath(path).TrimEnd('\\', '/');
    static bool Same(string a, string b) => string.Equals(Full(a), Full(b), StringComparison.OrdinalIgnoreCase);
    static bool Inside(string root, string path) => Full(path).StartsWith(Full(root) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
    public static string WorkRoot(string root) => Program.Within(root, FolderName);
    public static bool IsProjectsRoot(string root, string path) => Same(path, Program.Within(WorkRoot(root), "projects"));
    static string Ensure(string root)
    {
        if (!Directory.Exists(root)) throw new Exception("游戏目录不存在");
        var work = WorkRoot(root); var marker = Path.Combine(work, "workspace.json");
        if (Directory.Exists(work)) {
            if ((File.GetAttributes(work) & FileAttributes.ReparsePoint) != 0) throw new Exception("游戏工作目录不能是目录联接或符号链接");
            if (!File.Exists(marker) && Directory.EnumerateFileSystemEntries(work).Any()) throw new Exception("LLMChat-Unity 目录已存在且不是本软件工作区，请先保留并重命名该目录");
        }
        Directory.CreateDirectory(work);
        if (!File.Exists(marker)) Program.WriteJson(marker, new { version = 1, root = Full(root), legacyChecked = false });
        var metadata = JsonNode.Parse(File.ReadAllText(marker))!;
        if (metadata["version"]?.GetValue<int>() != 1) throw new Exception("游戏工作目录版本不受支持");
        Directory.CreateDirectory(Path.Combine(work, "projects"));
        return work;
    }
    static JsonNode CopyTask(JsonNode task)
    {
        var result = new JsonObject();
        foreach (var key in new[] { "step", "endStep", "automatic", "finished", "projectFolder", "scanFolder", "patchFolder", "previousProjectFolder", "scopeVersion", "translationKind", "engine", "source", "target", "includeCode", "fontPath", "progress", "patch" })
            if (task[key] != null) result[key] = task[key]!.DeepClone();
        return result;
    }
    static void MapPaths(JsonNode task, Func<string, string> map)
    {
        foreach (var key in FolderKeys) if (task[key]?.GetValue<string>() is { Length: > 0 } folder) task[key] = map(folder);
        if (task["patch"]?["folder"]?.GetValue<string>() is { Length: > 0 } patch) task["patch"]!["folder"] = map(patch);
        if (task["progress"]?["folder"]?.GetValue<string>() is { Length: > 0 } progress) task["progress"]!["folder"] = map(progress);
    }
    public static void SaveTask(Request request)
    {
        var work = Ensure(request.Root);
        var task = CopyTask(request.Task ?? throw new Exception("缺少任务检查点"));
        MapPaths(task, path => {
            if (!Path.IsPathRooted(path)) { _ = Program.Within(work, path); return path; }
            if (!Inside(work, path)) throw new Exception("检查点路径不在当前游戏工作目录中");
            return Path.GetRelativePath(work, path);
        });
        Program.WriteJson(Path.Combine(work, "task-state.json"), task);
    }
    static void CopyDirectory(string source, string destination)
    {
        Directory.CreateDirectory(destination);
        foreach (var file in Directory.EnumerateFileSystemEntries(source)) {
            if ((File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0) throw new Exception("工程包含目录联接或符号链接，未迁移：" + file);
            var target = Path.Combine(destination, Path.GetFileName(file));
            if (Directory.Exists(file)) CopyDirectory(file, target); else File.Copy(file, target);
        }
    }
    static void BindMovedGame(string root, string projects, string oldRoot)
    {
        foreach (var directory in Directory.EnumerateDirectories(projects, "unity-project-*")) {
            var path = Path.Combine(directory, "unity-project.json"); if (!File.Exists(path)) continue;
            var project = Program.Load(path);
            if (!Same(project.Root, oldRoot) && !Same(project.Root, root)) throw new Exception("工作区包含不属于当前游戏的工程");
            var modified = File.GetLastWriteTimeUtc(path); project.Root = root; Program.Save(project); File.SetLastWriteTimeUtc(path, modified);
            var scanPaths = Path.Combine(directory, "scan-files.json");
            if (File.Exists(scanPaths)) {
                var files = JsonSerializer.Deserialize<string[]>(File.ReadAllText(scanPaths), Program.Json)!;
                files = files.Select(file => Inside(oldRoot, file) ? Program.Within(root, Path.GetRelativePath(oldRoot, file)) : Inside(root, file) ? file : throw new Exception("扫描检查点引用了游戏目录之外的文件")).ToArray();
                Program.WriteJson(scanPaths, files);
            }
            foreach (var patch in Directory.EnumerateDirectories(directory, "patch-*")) {
                var manifestPath = Path.Combine(patch, "manifest.json"); if (!File.Exists(manifestPath)) continue;
                var manifest = JsonNode.Parse(File.ReadAllText(manifestPath))!;
                if (!Same(manifest["root"]!.GetValue<string>(), oldRoot) && !Same(manifest["root"]!.GetValue<string>(), root)) throw new Exception("工作区补丁与当前游戏不一致");
                var before = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(manifestPath)));
                var statePath = Path.Combine(patch, "application-state.json");
                var state = File.Exists(statePath) ? JsonNode.Parse(File.ReadAllText(statePath)) : null;
                if (state != null && state["manifestHash"]!.GetValue<string>() != before) throw new Exception("应用检查点的清单校验失败，未自动重绑定");
                manifest["root"] = root; Program.WriteJson(manifestPath, manifest);
                if (File.Exists(statePath)) {
                    state!["manifestHash"] = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(manifestPath))); Program.WriteJson(statePath, state);
                }
            }
        }
    }
    static string MigrateProject(string root, string projects, string source)
    {
        var project = Program.Load(Path.Combine(source, "unity-project.json"));
        if (!Same(project.Root, root)) throw new Exception("旧工程不属于当前游戏，未迁移");
        var destination = Program.Within(projects, Path.GetFileName(Full(source)));
        if (Directory.Exists(destination)) {
            var oldBytes = File.ReadAllBytes(Path.Combine(source, "unity-project.json"));
            var newProject = Program.Load(Path.Combine(destination, "unity-project.json"));
            var original = JsonSerializer.Deserialize<Project>(oldBytes, Program.Json)!;
            original.Folder = destination;
            if (JsonSerializer.Serialize(original, Program.Json) != JsonSerializer.Serialize(newProject, Program.Json)) throw new Exception("游戏工作目录已有同名工程且内容不同，已保留双方数据");
            return destination;
        }
        var staging = Program.Within(projects, ".migrating-" + Guid.NewGuid().ToString("N"));
        CopyDirectory(source, staging);
        var sourceJson = Path.Combine(source, "unity-project.json");
        var copiedJson = Path.Combine(staging, "unity-project.json");
        if (!SHA256.HashData(File.ReadAllBytes(sourceJson)).SequenceEqual(SHA256.HashData(File.ReadAllBytes(copiedJson)))) throw new Exception("工程复制校验失败，原工程已保留");
        project.Folder = staging; Program.Save(project);
        Directory.Move(staging, destination);
        project.Folder = destination; Program.Save(project);
        return destination;
    }
    public static WorkspaceResult Open(Request request)
    {
        var root = Full(request.Root); var work = Ensure(root); var projects = Path.Combine(work, "projects");
        var markerPath = Path.Combine(work, "workspace.json");
        var marker = JsonNode.Parse(File.ReadAllText(markerPath))!;
        if (!Same(marker["root"]!.GetValue<string>(), root)) {
            BindMovedGame(root, projects, marker["root"]!.GetValue<string>()); marker["root"] = root; Program.WriteJson(markerPath, marker);
        }
        var taskPath = Path.Combine(work, "task-state.json");
        if (!File.Exists(taskPath) && marker["legacyChecked"]?.GetValue<bool>() != true) {
            var legacy = request.Task == null ? null : CopyTask(request.Task);
            var sources = FolderKeys.Where(key => legacy?[key]?.GetValue<string>() is { Length: > 0 }).Select(key => legacy![key]!.GetValue<string>()).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
            // patchFolder is a child of a project, not a project in its own right.
            sources = sources.Where(path => File.Exists(Path.Combine(path, "unity-project.json"))).ToList();
            if (sources.Count == 0 && !string.IsNullOrWhiteSpace(request.OutputRoot)) {
                var found = Program.FindSaved(new Request { Root = root, OutputRoot = request.OutputRoot });
                if (found.Project != null) sources.Add(found.Project.Folder);
            }
            var mapped = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var source in sources) mapped[source] = Inside(work, source) ? source : MigrateProject(root, projects, source);
            if (legacy != null) {
                MapPaths(legacy, path => {
                    var match = mapped.Keys.OrderByDescending(s => s.Length).FirstOrDefault(from => Same(from, path) || Inside(from, path));
                    if (match == null) {
                        if (Inside(work, path)) return path;
                        throw new Exception("无法迁移任务引用的工作文件，原进度已保留：" + path);
                    }
                    return Same(match, path) ? mapped[match] : Path.Combine(mapped[match], Path.GetRelativePath(match, path));
                });
                SaveTask(new Request { Root = root, Task = legacy });
            }
            marker["legacyChecked"] = true; Program.WriteJson(markerPath, marker);
        }
        JsonNode? task = File.Exists(taskPath) ? JsonNode.Parse(File.ReadAllText(taskPath)) : null;
        if (task != null) MapPaths(task, path => Path.IsPathRooted(path) ? throw new Exception("任务检查点路径格式无效") : Program.Within(work, path));
        var saved = Program.FindSaved(new Request { Root = root, OutputRoot = projects });
        var folder = task?["projectFolder"]?.GetValue<string>();
        if (string.IsNullOrEmpty(folder)) folder = task?["scanFolder"]?.GetValue<string>();
        if (!string.IsNullOrEmpty(folder)) {
            var project = Program.Load(Path.Combine(folder, "unity-project.json"));
            if (!Same(project.Root, root)) throw new Exception("游戏工作区工程与当前游戏路径不一致");
            saved = new SavedProject(project, saved.ScanCompleted, saved.ScanTotal, saved.Notices) { IncludeCode = saved.IncludeCode };
        }
        if (task != null && saved.Project != null && string.IsNullOrEmpty(task["projectFolder"]?.GetValue<string>())) {
            task["projectFolder"] = saved.Project.Folder;
            if (saved.ScanTotal != null) task["scanFolder"] = saved.Project.Folder;
        }
        if (task != null && task["step"]?.GetValue<int>() == 1 && saved.Project != null) {
            var state = Path.Combine(saved.Project.Folder, "scan-state.json"); var paths = Path.Combine(saved.Project.Folder, "scan-files.json");
            if (File.Exists(state) && File.Exists(paths)) {
                task["progress"]!["completed"] = JsonNode.Parse(File.ReadAllText(state))!["next"]!.DeepClone();
                task["progress"]!["total"] = JsonNode.Parse(File.ReadAllText(paths))!.AsArray().Count;
            }
        }
        if (task != null && task["step"]?.GetValue<int>() is 3 or 4 && saved.Project != null) {
            var patch = task["patchFolder"]?.GetValue<string>();
            if (string.IsNullOrEmpty(patch) && task["step"]!.GetValue<int>() == 3) {
                var started = File.GetLastWriteTimeUtc(taskPath);
                patch = Directory.EnumerateDirectories(saved.Project.Folder, "patch-*").Where(p => File.Exists(Path.Combine(p, "export-state.json")) && File.GetLastWriteTimeUtc(Path.Combine(p, "export-state.json")) >= started).OrderByDescending(p => File.GetLastWriteTimeUtc(Path.Combine(p, "export-state.json"))).FirstOrDefault();
                if (patch != null) task["patchFolder"] = patch;
            }
            if (!string.IsNullOrEmpty(patch)) {
                var applying = task["step"]!.GetValue<int>() == 4;
                var statePath = Path.Combine(patch, applying ? "application-state.json" : "export-state.json");
                if (File.Exists(statePath)) {
                    var state = JsonNode.Parse(File.ReadAllText(statePath))!;
                    task["progress"]!["completed"] = applying ? state["completed"]!.AsArray().Count : state["files"]!.AsArray().Count;
                    var total = applying ? JsonNode.Parse(File.ReadAllText(Path.Combine(patch, "manifest.json")))!["files"]!.AsArray().Count : state["totalFiles"]?.GetValue<int>() ?? 0;
                    if (total > 0) task["progress"]!["total"] = total;
                }
            }
        }
        return new(work, projects, saved, task);
    }
}

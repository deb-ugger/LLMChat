using System.Text.Json;
using System.Text.Json.Nodes;

namespace LLMChat.UnityOffline;

public sealed record ResetResult(int Step, WorkspaceResult Workspace);
public sealed record ResetPlan(int Step, string Project, string[] Delete, string[] Restore, JsonNode Task, bool Restored = false, bool ImageOnly = false);

public static class WorkflowReset
{
    static string Full(string path) => Path.GetFullPath(path).TrimEnd('\\', '/');
    static bool Same(string a, string b) => string.Equals(Full(a), Full(b), StringComparison.OrdinalIgnoreCase);
    static void NoLinks(string path)
    {
        if (!Directory.Exists(path)) return;
        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new Exception("清理目录包含目录联接或符号链接，未删除：" + path);
        foreach (var item in Directory.EnumerateFileSystemEntries(path)) {
            if ((File.GetAttributes(item) & FileAttributes.ReparsePoint) != 0) throw new Exception("清理目录包含目录联接或符号链接，未删除：" + item);
            if (Directory.Exists(item)) NoLinks(item);
        }
    }
    static void OwnedProject(string root, string projects, string folder)
    {
        if (!Same(Path.GetDirectoryName(folder)!, projects) || !Path.GetFileName(folder).StartsWith("unity-project-", StringComparison.Ordinal)) throw new Exception("清理目标不是当前游戏的工程目录");
        var project = Program.Load(Path.Combine(folder, "unity-project.json"));
        if (!Same(project.Root, root)) throw new Exception("清理目标不属于当前游戏");
        NoLinks(folder);
    }
    public static ResetResult Start(Request request)
    {
        if (request.Step is < 1 or > 4) throw new Exception("无效重做步骤");
        var workspace = GameWorkspace.Open(new Request { Root = request.Root });
        var root = Full(request.Root); var work = workspace.WorkRoot; var projects = workspace.ProjectsRoot;
        var step = request.Step;
        var folders = step == 1 ? Directory.GetDirectories(projects, "unity-project-*") : [Full(request.Path)];
        var task = (request.Task ?? workspace.Task ?? throw new Exception("缺少当前任务设置")).DeepClone();
        var obsolete = step != 1 && task["previousProjectFolder"]?.GetValue<string>() is { Length: > 0 } old && !Same(old, folders[0]) ? new[] { Full(old) } : [];
        foreach (var folder in folders) OwnedProject(root, projects, folder);
        foreach (var folder in obsolete) OwnedProject(root, projects, folder);
        var patches = folders.Concat(obsolete).SelectMany(folder => Directory.GetDirectories(folder, "patch-*")).ToArray();
        var fontPlans = folders.Select(folder => Path.Combine(folder, "font-plan")).Where(Directory.Exists).ToArray();
        foreach (var fontPlan in fontPlans) if (!File.Exists(Path.Combine(fontPlan, FontPreparation.Marker))) throw new Exception("字库目录缺少本软件标记，未删除：" + fontPlan);
        foreach (var patch in patches) {
            if (!File.Exists(Path.Combine(patch, "manifest.json")) && !File.Exists(Path.Combine(patch, "export-state.json"))) throw new Exception("补丁目录缺少本软件的标记，未删除：" + patch);
            NoLinks(patch);
        }
        var restore = patches.Where(p => File.Exists(Path.Combine(p, "application-state.json")))
            .OrderByDescending(p => File.GetLastWriteTimeUtc(Path.Combine(p, "application-state.json"))).ToArray();
        var reusable = "";
        if (step == 4) {
            reusable = task["patch"]?["folder"]?.GetValue<string>() ?? "";
            if (reusable.Length == 0 || !patches.Any(p => Same(p, reusable)) || !Same(Path.GetDirectoryName(Full(reusable))!, folders[0])) throw new Exception("请先生成完整补丁，再重做应用");
            ValidateReusablePatch(root, reusable);
        }
        var previous = Math.Max(1, step - 1);
        task["step"] = previous; task["endStep"] = previous; task["automatic"] = false; task["finished"] = true;
        task["projectFolder"] = step == 1 ? "" : folders[0]; task["scanFolder"] = ""; task["previousProjectFolder"] = "";
        task["patchFolder"] = reusable;
        if (step != 4) task["patch"] = null;
        if (step <= 2) { task["partial"] = false; task["translationFailure"] = null; }
        task["progress"] = new JsonObject { ["step"] = previous, ["state"] = "done", ["completed"] = 0, ["total"] = 0, ["detail"] = "可调整参数后重新开始" };
        var plan = new ResetPlan(step, step == 1 ? "" : Path.GetRelativePath(work, folders[0]),
            (step == 1 ? folders : patches.Where(p => reusable.Length == 0 || !Same(p, reusable)).Where(p => !obsolete.Any(old => Same(Path.GetDirectoryName(p)!, old))).Concat(step < 4 ? fontPlans : []).Concat(obsolete)).Select(p => Path.GetRelativePath(work, p)).ToArray(),
            restore.Select(p => Path.GetRelativePath(work, p)).ToArray(), GameWorkspace.PackTask(root, task), ImageOnly: request.ImageOnly);
        Program.WriteJson(Path.Combine(work, "reset-state.json"), plan);
        ResumePending(root);
        return new(step, GameWorkspace.Open(new Request { Root = root }));
    }
    static void ValidateReusablePatch(string root, string folder)
    {
        if (File.Exists(Path.Combine(folder, "INCOMPLETE.txt"))) throw new Exception("补丁尚未完整生成，请重做生成补丁");
        using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(folder, "manifest.json")));
        var manifest = document.RootElement;
        if (!Same(manifest.GetProperty("root").GetString()!, root) || !manifest.TryGetProperty("textSafetyRevision", out var safety) || safety.GetInt32() < GameText.SafetyRevision) throw new Exception("补丁不适用于当前工程，请重做生成补丁");
        foreach (var file in manifest.GetProperty("files").EnumerateArray()) {
            var relative = file.GetProperty("file").GetString()!;
            if (Program.Hash(Program.Within(Path.Combine(folder, "original"), relative)) != file.GetProperty("originalSha256").GetString() || Program.Hash(Program.Within(Path.Combine(folder, "patch"), relative)) != file.GetProperty("patchSha256").GetString()) throw new Exception("补丁或原件备份校验失败，请重做生成补丁：" + relative);
        }
    }
    public static object FinishRescan(Request request)
    {
        var root = Full(request.Root); var work = GameWorkspace.Ensure(root); var projects = Path.Combine(work, "projects");
        var task = request.Task ?? throw new Exception("缺少重新扫描的任务检查点");
        var current = Full(task["projectFolder"]?.GetValue<string>() ?? throw new Exception("缺少新工程目录"));
        var previous = Full(request.Path);
        if (Same(current, previous)) throw new Exception("不能清理当前工程");
        OwnedProject(root, projects, current); OwnedProject(root, projects, previous);
        var project = Program.Load(Path.Combine(current, "unity-project.json"));
        var state = JsonSerializer.Deserialize<ScanCheckpoint>(File.ReadAllText(Path.Combine(current, "scan-state.json")), Program.Json)!;
        var files = JsonSerializer.Deserialize<string[]>(File.ReadAllText(Path.Combine(current, "scan-files.json")), Program.Json)!;
        if (project.ScanRevision != Program.CurrentScanRevision || state.Next != files.Length) throw new Exception("新工程扫描尚未完成，旧工程仍保留");
        foreach (var patch in Directory.GetDirectories(previous, "patch-*")) {
            var path = Path.Combine(patch, "application-state.json");
            if (!File.Exists(path)) continue;
            var applied = JsonNode.Parse(File.ReadAllText(path))!;
            if (applied["done"]?.GetValue<bool>() == true || (applied["completed"]?.AsArray().Count ?? 0) > 0) throw new Exception("旧工程仍有已应用补丁，须先恢复游戏原件再清理");
        }
        var plan = new ResetPlan(1, "", [Path.GetRelativePath(work, previous)], [], GameWorkspace.PackTask(root, task));
        Program.WriteJson(Path.Combine(work, "reset-state.json"), plan);
        ResumePending(root);
        return new { ok = true };
    }
    public static void ResumePending(string root)
    {
        var work = GameWorkspace.WorkRoot(root); var marker = Path.Combine(work, "reset-state.json");
        if (!File.Exists(marker)) return;
        var plan = JsonSerializer.Deserialize<ResetPlan>(File.ReadAllText(marker), Program.Json) ?? throw new Exception("重做清理检查点无效");
        if (plan.Step is < 1 or > 4) throw new Exception("重做清理步骤无效");
        var project = plan.Step == 1 ? "" : Program.Within(work, plan.Project);
        var projects = Path.Combine(work, "projects");
        if (plan.Step != 1) OwnedProject(root, projects, project);
        var targets = plan.Delete.Select(p => Program.Within(work, p)).ToArray();
        foreach (var target in targets) {
            var obsolete = plan.Step != 1 && Same(Path.GetDirectoryName(target)!, projects) && !Same(target, project);
            var expectedParent = plan.Step == 1 || obsolete ? projects : project;
            var prefix = plan.Step == 1 || obsolete ? "unity-project-" : "patch-";
            var fontPlan = plan.Step != 1 && Path.GetFileName(target) == "font-plan";
            if (!Same(Path.GetDirectoryName(target)!, expectedParent) || !fontPlan && !Path.GetFileName(target).StartsWith(prefix, StringComparison.Ordinal)) throw new Exception("清理检查点包含工程目录之外的路径");
            if (fontPlan && Directory.Exists(target) && !File.Exists(Path.Combine(target, FontPreparation.Marker))) throw new Exception("字库目录缺少本软件标记，未删除：" + target);
            NoLinks(target);
        }
        if (!plan.Restored) {
            foreach (var patch in plan.Restore) {
                var folder = Program.Within(work, patch);
                if (!File.Exists(Path.Combine(folder, "application-state.json"))) throw new Exception("旧补丁应用记录缺失，未清理原件备份");
                Program.RestorePatch(root, folder);
            }
            plan = plan with { Restored = true }; Program.WriteJson(marker, plan);
        }
        if (plan.Step == 2) {
            var saved = Program.Load(Path.Combine(project, "unity-project.json"));
            if (!plan.ImageOnly) {
                foreach (var entry in saved.Entries) { entry.Translation = ""; entry.LayoutDraft = null; entry.Error = ""; }
                saved.TextSkipped = false;
            }
            ImageResources.Reset(saved);
            Program.Save(saved);
        }
        if (plan.Step == 4) {
            var retained = Program.Within(work, plan.Task["patchFolder"]!.GetValue<string>());
            if (!Same(Path.GetDirectoryName(retained)!, project) || !Path.GetFileName(retained).StartsWith("patch-", StringComparison.Ordinal)) throw new Exception("保留补丁不属于当前工程");
            NoLinks(retained);
            File.Delete(Path.Combine(retained, "application-state.json"));
        }
        GameWorkspace.SaveTask(new Request { Root = root, Task = plan.Task });
        for (var index = 0; index < targets.Length; index++) {
            Program.Progress("清理旧产物：" + Path.GetFileName(targets[index]), index, targets.Length);
            if (Directory.Exists(targets[index])) Directory.Delete(targets[index], true);
        }
        File.Delete(marker);
        Program.Progress("清理完成，可调整参数后重新开始", targets.Length, targets.Length);
    }
}

using System.Text.Json;
using System.Text.Json.Nodes;

namespace LLMChat.UnityOffline;

public sealed record ResetResult(int Step, WorkspaceResult Workspace);
public sealed record ResetPlan(int Step, string Project, string[] Delete, string[] Restore, JsonNode Task, bool Restored = false);

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
        // An applied patch is removed on redo, so redoing application requires a new patch.
        var step = Math.Min(request.Step, 3);
        var folders = step == 1 ? Directory.GetDirectories(projects, "unity-project-*") : [Full(request.Path)];
        foreach (var folder in folders) OwnedProject(root, projects, folder);
        var patches = folders.SelectMany(folder => Directory.GetDirectories(folder, "patch-*")).ToArray();
        foreach (var patch in patches) {
            if (!File.Exists(Path.Combine(patch, "manifest.json")) && !File.Exists(Path.Combine(patch, "export-state.json"))) throw new Exception("补丁目录缺少本软件的标记，未删除：" + patch);
            NoLinks(patch);
        }
        var restore = patches.Where(p => File.Exists(Path.Combine(p, "application-state.json")))
            .OrderByDescending(p => File.GetLastWriteTimeUtc(Path.Combine(p, "application-state.json"))).ToArray();
        var task = (request.Task ?? workspace.Task ?? throw new Exception("缺少当前任务设置")).DeepClone();
        var previous = Math.Max(1, step - 1);
        task["step"] = previous; task["endStep"] = previous; task["automatic"] = false; task["finished"] = true;
        task["projectFolder"] = step == 1 ? "" : folders[0]; task["scanFolder"] = ""; task["previousProjectFolder"] = "";
        task["patchFolder"] = ""; task["patch"] = null;
        if (step <= 2) task["partial"] = false;
        task["progress"] = new JsonObject { ["step"] = previous, ["state"] = "done", ["completed"] = 0, ["total"] = 0, ["detail"] = "可调整参数后重新开始" };
        var plan = new ResetPlan(step, step == 1 ? "" : Path.GetRelativePath(work, folders[0]),
            (step == 1 ? folders : patches).Select(p => Path.GetRelativePath(work, p)).ToArray(),
            restore.Select(p => Path.GetRelativePath(work, p)).ToArray(), GameWorkspace.PackTask(root, task));
        Program.WriteJson(Path.Combine(work, "reset-state.json"), plan);
        ResumePending(root);
        return new(step, GameWorkspace.Open(new Request { Root = root }));
    }
    public static void ResumePending(string root)
    {
        var work = GameWorkspace.WorkRoot(root); var marker = Path.Combine(work, "reset-state.json");
        if (!File.Exists(marker)) return;
        var plan = JsonSerializer.Deserialize<ResetPlan>(File.ReadAllText(marker), Program.Json) ?? throw new Exception("重做清理检查点无效");
        if (plan.Step is < 1 or > 3) throw new Exception("重做清理步骤无效");
        var project = plan.Step == 1 ? "" : Program.Within(work, plan.Project);
        var projects = Path.Combine(work, "projects");
        if (plan.Step != 1) OwnedProject(root, projects, project);
        var targets = plan.Delete.Select(p => Program.Within(work, p)).ToArray();
        foreach (var target in targets) {
            var expectedParent = plan.Step == 1 ? projects : project;
            var prefix = plan.Step == 1 ? "unity-project-" : "patch-";
            if (!Same(Path.GetDirectoryName(target)!, expectedParent) || !Path.GetFileName(target).StartsWith(prefix, StringComparison.Ordinal)) throw new Exception("清理检查点包含工程目录之外的路径");
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
            foreach (var entry in saved.Entries) { entry.Translation = ""; entry.Error = ""; }
            Program.Save(saved);
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

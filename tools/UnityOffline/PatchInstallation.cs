using System.Text.Json.Nodes;

namespace LLMChat.UnityOffline;

public sealed record InstallationStatus(string Root, bool Installed);
public static class PatchInstallation
{
    sealed record AppliedPatch(string Folder, DateTime Updated);
    static AppliedPatch[] Applied(string root)
    {
        var work = GameWorkspace.WorkRoot(root);
        var projects = Path.Combine(work, "projects");
        if (!File.Exists(Path.Combine(work, "workspace.json")) || !Directory.Exists(projects)) return [];
        var result = new List<AppliedPatch>();
        foreach (var project in Directory.EnumerateDirectories(projects, "unity-project-*"))
            foreach (var patch in Directory.EnumerateDirectories(project, "patch-*")) {
                var statePath = Path.Combine(patch, "application-state.json");
                if (!File.Exists(statePath)) continue;
                var state = JsonNode.Parse(File.ReadAllText(statePath))!;
                var done = state["done"]?.GetValue<bool>() == true;
                if (done || (state["completed"]?.AsArray().Count ?? 0) > 0) result.Add(new(patch, File.GetLastWriteTimeUtc(statePath)));
            }
        return result.OrderByDescending(p => p.Updated).ToArray();
    }
    internal sealed record InstallationSnapshot(string Folder, string State);
    internal static InstallationSnapshot[] Capture(string root) => Applied(root)
        .Select(patch => new InstallationSnapshot(patch.Folder, File.ReadAllText(Path.Combine(patch.Folder, "application-state.json"))))
        .ToArray();

    internal static void RestoreSnapshot(string root, InstallationSnapshot[] snapshots)
    {
        foreach (var snapshot in snapshots.Reverse()) {
            var state = JsonNode.Parse(snapshot.State)!;
            var completed = state["completed"]!.AsArray().Select(file => file!.GetValue<string>()).ToHashSet(StringComparer.OrdinalIgnoreCase);
            var manifest = JsonNode.Parse(File.ReadAllText(Path.Combine(snapshot.Folder, "manifest.json")))!;
            foreach (var file in manifest["files"]!.AsArray()) {
                var relative = file!["file"]!.GetValue<string>();
                if (!completed.Contains(relative)) continue;
                var target = Program.ApplyPath(root, relative);
                var source = Program.ApplyPath(Path.Combine(snapshot.Folder, "patch"), relative);
                var hash = file["patchSha256"]!.GetValue<string>();
                var current = Program.Hash(target);
                if (Program.Hash(source) != hash || (current != hash && current != file["originalSha256"]!.GetValue<string>()))
                    throw new IOException("停止后恢复旧补丁失败：" + relative);
                if (current != hash) Program.ReplaceFile(source, target);
                if (Program.Hash(target) != hash) throw new IOException("旧补丁恢复校验失败：" + relative);
            }
            Program.WriteJson(Path.Combine(snapshot.Folder, "application-state.json"), state);
        }
    }


    public static InstallationStatus Status(string root) => new(Path.GetFullPath(root), Applied(root).Length > 0);
    public static Dictionary<string, string> OriginalFiles(string root)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var patch in Applied(root)) {
            var manifest = JsonNode.Parse(File.ReadAllText(Path.Combine(patch.Folder, "manifest.json")))!;
            foreach (var file in manifest["files"]!.AsArray()) {
                var relative = file!["file"]!.GetValue<string>();
                if (result.ContainsKey(relative)) continue;
                var target = Program.Within(root, relative);
                var original = Program.Within(Path.Combine(patch.Folder, "original"), relative);
                var current = Program.Hash(target);
                if (current != file["patchSha256"]!.GetValue<string>() && current != file["originalSha256"]!.GetValue<string>()) throw new Exception("已安装补丁的资源被外部修改：" + relative);
                if (Program.Hash(original) != file["originalSha256"]!.GetValue<string>()) throw new Exception("原件备份校验失败：" + relative);
                result[relative] = original;
            }
        }
        return result;
    }
    public static bool HasApplied(string folder) => File.Exists(Path.Combine(folder, "application-state.json")) &&
        (JsonNode.Parse(File.ReadAllText(Path.Combine(folder, "application-state.json"))) is { } state) &&
        (state["done"]?.GetValue<bool>() == true || (state["completed"]?.AsArray().Count ?? 0) > 0);
    public static int RestoreBeforeApply(string root, string currentFolder)
    {
        var patches = Applied(root).Where(p => !Path.GetFullPath(p.Folder).Equals(Path.GetFullPath(currentFolder), StringComparison.OrdinalIgnoreCase)).ToArray();
        if (patches.Length > 0) Program.Progress($"检测到 {patches.Length} 个已安装旧补丁，准备卸载");
        for (var i = 0; i < patches.Length; i++) {
            Program.Progress($"正在卸载旧补丁 {i + 1} / {patches.Length}，恢复游戏原件");
            Program.RestorePatch(root, patches[i].Folder);
        }
        if (patches.Length > 0) Program.Progress("旧补丁已卸载，游戏原件恢复完成，准备应用新补丁");
        return patches.Length;
    }
    public static WorkspaceResult Uninstall(Request request)
    {
        var workspace = GameWorkspace.Open(new Request { Root = request.Root });
        var patches = Applied(request.Root);
        foreach (var patch in patches) Program.RestorePatch(request.Root, patch.Folder);
        if (workspace.Task is { } task) {
            task["step"] = 2; task["endStep"] = 2; task["automatic"] = false; task["finished"] = true;
            task["patch"] = null; task["patchFolder"] = "";
            task["progress"] = new JsonObject { ["step"] = 2, ["state"] = "done", ["completed"] = 0, ["total"] = 0, ["detail"] = "补丁已卸载，原件已恢复；工程和译文已保留" };
            GameWorkspace.SaveTask(new Request { Root = request.Root, Task = task });
        }
        return GameWorkspace.Open(new Request { Root = request.Root });
    }
}

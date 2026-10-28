using System.Text.Json.Nodes;

namespace LLMChat.UnityOffline;

public sealed record InstallationStatus(string Root, bool Installed);
public static class PatchInstallation
{
    sealed record AppliedPatch(string Folder, bool Done, DateTime Updated);
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
                if (done || (state["completed"]?.AsArray().Count ?? 0) > 0) result.Add(new(patch, done, File.GetLastWriteTimeUtc(statePath)));
            }
        return result.OrderByDescending(p => p.Updated).ToArray();
    }
    public static InstallationStatus Status(string root) => new(Path.GetFullPath(root), Applied(root).Any(p => p.Done));
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

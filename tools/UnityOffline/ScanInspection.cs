using Mono.Cecil;
using System.Text.RegularExpressions;
using System.Security.Cryptography;

namespace LLMChat.UnityOffline;

public sealed record AssemblyChoice(string Path, bool Writable, string Reason);
public sealed record Inspection(string Runtime, AssemblyChoice[] Assemblies, string[] Catalogs);
public sealed record ScanIssue(string File, string Container, string ObjectId, string Reason, string Action);
public sealed record ResourceResult(string File, string State, int Texts, int Fonts, int FailedObjects);

public static class ScanInspection
{
    public const string PendingDefinitions = "INCOMPLETE.json";
    static string Digest(string path) { using var stream = File.OpenRead(path); return Convert.ToHexString(SHA256.HashData(stream)); }
    public static void CacheDefinitions(Project project, string source, Action? checkStop = null)
    {
        project.TypeDirectory = "";
        if (source.Length == 0) return;
        if (!Directory.Exists(source)) throw new Exception("类型定义目录不存在，请选择 Managed 或匹配的 DummyDll");
        var files = Directory.EnumerateFiles(source, "*.dll", new EnumerationOptions { AttributesToSkip = FileAttributes.ReparsePoint }).Order(StringComparer.OrdinalIgnoreCase).ToArray();
        if (files.Length == 0) throw new Exception("类型定义目录内没有 DLL，请选择 Managed 或 DummyDll 本身");
        var folder = Path.Combine(project.Folder, "type-definitions"); Directory.CreateDirectory(folder);
        var pending = Path.Combine(folder, PendingDefinitions); var names = files.Select(Path.GetFileName).ToArray();
        if (File.Exists(pending) && !System.Text.Json.JsonSerializer.Deserialize<string[]>(File.ReadAllText(pending))!.SequenceEqual(names, StringComparer.OrdinalIgnoreCase)) throw new Exception("类型定义源目录内容已变化，请重新扫描");
        if (!File.Exists(pending)) Program.WriteJson(pending, names);
        project.TypeDirectory = folder; Program.Save(project);
        foreach (var file in files) {
            checkStop?.Invoke();
            var name = Path.GetFileName(file); var target = Path.Combine(folder, name); var sourceHash = Digest(file);
            if (project.DefinitionHashes.TryGetValue(name, out var expected)) {
                if (sourceHash != expected || !File.Exists(target) || Digest(target) != expected) throw new Exception("类型定义发生变化，请重新扫描：" + name);
                continue;
            }
            try { using (ModuleDefinition.ReadModule(file)) { } }
            catch (BadImageFormatException) { throw new Exception("类型定义不是托管 DLL，请提供 Managed 或 DummyDll，不要选择 GameAssembly.dll：" + name); }
            File.Copy(file, target, true);
            if (Digest(target) != sourceHash) throw new Exception("类型定义复制校验失败：" + name);
            project.DefinitionHashes[name] = sourceHash; Program.Save(project);
        }
        File.Delete(pending);
    }
    public static void VerifyDefinitions(Project project)
    {
        if (project.TypeDirectory.Length > 0 && File.Exists(Path.Combine(project.TypeDirectory, PendingDefinitions))) throw new Exception("类型定义尚未准备完成，请恢复扫描");
        foreach (var item in project.DefinitionHashes) {
            var path = Program.Within(project.TypeDirectory, item.Key);
            if (!File.Exists(path)) throw new Exception("工程类型定义缺失，请重新扫描：" + item.Key);
            using var stream = File.OpenRead(path);
            if (Convert.ToHexString(SHA256.HashData(stream)) != item.Value) throw new Exception("工程类型定义发生变化，请重新扫描：" + item.Key);
        }
    }
    public static bool GameAssembly(string relative) => relative.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar).Any(p => p.Equals("Managed", StringComparison.OrdinalIgnoreCase)) &&
        Path.GetExtension(relative).Equals(".dll", StringComparison.OrdinalIgnoreCase) &&
        !Regex.IsMatch(Path.GetFileName(relative), @"^(?:mscorlib\.|netstandard\.|System(?:\.|$)|Microsoft\.|Mono\.|UnityEngine\.|UnityEditor\.|Unity\.|Newtonsoft\.|BepInEx\.|MelonLoader\.)", RegexOptions.IgnoreCase);

    public static Inspection Inspect(string root)
    {
        root = Path.GetFullPath(root);
        if (!Directory.Exists(root)) throw new Exception("游戏目录不存在");
        var options = new EnumerationOptions { RecurseSubdirectories = true, AttributesToSkip = FileAttributes.ReparsePoint };
        var assemblies = new List<AssemblyChoice>();
        var dataFolders = Directory.EnumerateDirectories(root, "*_Data", new EnumerationOptions { AttributesToSkip = FileAttributes.ReparsePoint }).ToArray();
        foreach (var folder in dataFolders.Select(data => Path.Combine(data, "Managed")).Append(Path.Combine(root, "Managed")).Where(folder => Directory.Exists(folder) && (File.GetAttributes(folder) & FileAttributes.ReparsePoint) == 0))
            foreach (var file in Directory.EnumerateFiles(folder, "*.dll", new EnumerationOptions { AttributesToSkip = FileAttributes.ReparsePoint })) {
                var relative = Path.GetRelativePath(root, file);
                if (!GameAssembly(relative)) continue;
                try {
                    using var module = ModuleDefinition.ReadModule(file);
                    var signed = module.Assembly?.Name.HasPublicKey == true;
                    assemblies.Add(new(relative, !signed, signed ? "已签名程序集，不自动回写" : ""));
                } catch (Exception error) when (error is BadImageFormatException or IOException) {
                    assemblies.Add(new(relative, false, "无法读取托管程序集：" + error.Message));
                }
            }
        var streams = dataFolders.Select(data => Path.Combine(data, "StreamingAssets")).Append(Path.Combine(root, "StreamingAssets")).Where(Directory.Exists);
        var catalogs = streams.SelectMany(folder => Directory.EnumerateFiles(folder, "catalog*", options)).Concat(Directory.EnumerateFiles(root, "catalog*", SearchOption.TopDirectoryOnly)).Where(path => Path.GetExtension(path).ToLowerInvariant() is ".json" or ".bin" or ".bundle").Select(path => Path.GetRelativePath(root, path)).ToArray();
        var il2cpp = dataFolders.Any(data => Directory.Exists(Path.Combine(data, "il2cpp_data"))) || Directory.EnumerateFiles(root, "GameAssembly.dll", SearchOption.TopDirectoryOnly).Any();
        return new(il2cpp ? "IL2CPP" : assemblies.Count > 0 ? "Mono" : "未确定", assemblies.OrderBy(a => a.Path).ToArray(), catalogs);
    }

    public static string[] SelectedAssemblies(Request request, Inspection inspection)
    {
        var available = inspection.Assemblies.Where(a => a.Writable).Select(a => a.Path).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var selected = request.CodeAssemblies ?? available.ToArray();
        foreach (var path in selected) if (!available.Contains(path)) throw new Exception("程序集不可回写或不属于当前游戏 Managed：" + path);
        return selected.Distinct(StringComparer.OrdinalIgnoreCase).Order(StringComparer.OrdinalIgnoreCase).ToArray();
    }

    public static ScanIssue Issue(string file, string container, string id, Exception error, string context = "")
    {
        var action = error is EndOfStreamException ? "检查资源版本、文件完整性和 Managed 或 DummyDll 类型定义是否匹配；该对象未提取，不影响其他已解析对象。" :
            error is FileNotFoundException || error.Message.Contains("assembly", StringComparison.OrdinalIgnoreCase) ? "选择当前游戏的 Managed 或匹配的 DummyDll 目录，补齐所需程序集后重新扫描。" :
            "检查该资源的格式和类型定义；保留原文件，使用资源查看工具核对后重新扫描。";
        var reason = error is EndOfStreamException ? "对象数据未能按当前类型定义读完，可能是类型布局不匹配或文件内容不足。技术原因：" + error.Message : error.Message;
        return new(file, container, id, context.Length > 0 ? context + "：" + reason : reason, action);
    }
}

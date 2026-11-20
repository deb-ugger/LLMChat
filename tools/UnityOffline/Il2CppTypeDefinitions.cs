using System.Diagnostics;
using System.Text.Json;
using Mono.Cecil;

namespace LLMChat.UnityOffline;

internal static class Il2CppTypeDefinitions
{
    const string Dumper = "Il2CppDumper.exe";

    internal static object Generate(Request request)
    {
        var root = Path.GetFullPath(request.Root);
        var binary = Path.Combine(root, "GameAssembly.dll");
        if (!File.Exists(binary)) throw new FileNotFoundException("游戏目录缺少 GameAssembly.dll");
        var options = new EnumerationOptions { AttributesToSkip = FileAttributes.ReparsePoint };
        var metadata = Directory.EnumerateDirectories(root, "*_Data", options)
            .Select(folder => Path.Combine(folder, "il2cpp_data", "Metadata", "global-metadata.dat"))
            .Where(File.Exists).ToArray();
        if (metadata.Length != 1) throw new InvalidDataException("游戏目录必须包含一份可识别的 global-metadata.dat");
        var tool = Path.Combine(AppContext.BaseDirectory, Dumper);
        if (!File.Exists(tool)) throw new FileNotFoundException("缺少 Il2CppDumper 组件，请使用包含完整 Unity 工具的安装包");

        Span<byte> header = stackalloc byte[32];
        using (var input = File.OpenRead(metadata[0])) input.ReadExactly(header);
        var version = Il2CppMetadata.ReadVersion(header);

        var scratch = Path.Combine(Path.GetTempPath(), "llmchat-il2cpp-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(scratch);
        try
        {
            var isolatedTool = Path.Combine(scratch, Dumper);
            File.Copy(tool, isolatedTool);
            File.WriteAllText(Path.Combine(scratch, "config.json"), JsonSerializer.Serialize(new {
                RequireAnyKey = false,
                GenerateDummyDll = true,
                GenerateStruct = false
            }));
            var output = Path.Combine(scratch, "output");
            Directory.CreateDirectory(output);
            Program.CheckStop(request, "");
            Program.Progress($"正在生成 IL2CPP v{version} 类型定义");
            RunDumper(request, isolatedTool, scratch, binary, metadata[0], output);

            var dummy = Path.Combine(output, "DummyDll");
            var modules = Directory.Exists(dummy) ? Directory.GetFiles(dummy, "*.dll") : [];
            if (modules.Length == 0) throw new InvalidDataException("Il2CppDumper 未生成类型定义");
            foreach (var module in modules)
            {
                Program.CheckStop(request, "");
                using var definition = ModuleDefinition.ReadModule(module);
            }

            var workspace = GameWorkspace.Ensure(root);
            var directory = Path.Combine(workspace, "il2cpp-types-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(directory);
            try
            {
                foreach (var module in modules)
                    File.Copy(module, Path.Combine(directory, Path.GetFileName(module)));
            }
            catch
            {
                Directory.Delete(directory, true);
                throw;
            }
            return new { directory, count = modules.Length };
        }
        finally { Directory.Delete(scratch, true); }
    }

    static void RunDumper(Request request, string tool, string scratch, string binary, string metadata, string output)
    {
        var start = new ProcessStartInfo(tool) {
            WorkingDirectory = scratch,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true
        };
        start.ArgumentList.Add(binary);
        start.ArgumentList.Add(metadata);
        start.ArgumentList.Add(output);
        using var process = Process.Start(start) ?? throw new IOException("无法启动 Il2CppDumper");
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        try
        {
            while (!process.WaitForExit(100)) Program.CheckStop(request, "");
        }
        catch (PausedException)
        {
            if (!process.HasExited) process.Kill();
            process.WaitForExit();
            throw;
        }

        var log = stdout.GetAwaiter().GetResult() + "\n" + stderr.GetAwaiter().GetResult();
        // Some Il2CppDumper versions report a failure with exit code zero.
        if (process.ExitCode != 0 || !Directory.Exists(Path.Combine(output, "DummyDll")))
        {
            var lines = log.Split('\n', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
            var details = lines.FirstOrDefault(line => line.Contains("ERROR", StringComparison.OrdinalIgnoreCase))
                ?? lines.LastOrDefault() ?? $"退出码 {process.ExitCode}";
            throw new InvalidDataException($"Il2CppDumper 未生成类型定义：{details}");
        }
    }
}

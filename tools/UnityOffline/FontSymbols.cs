using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace LLMChat.UnityOffline;

public static class FontSymbols
{
    public sealed record Mapping(int Codepoint, string Font, string Glyph);
    public sealed record Report(Mapping[] Mappings, int[] Missing);
    public sealed record BaseCache(string Font, Report Report);
    public static byte[] Supplement(byte[] source, out string[] changes, string text = "►", string? cacheDirectory = null, Action? checkStop = null)
    {
        changes = [];
        var codes = FontCoverage.Missing(source, text).Where(IsSymbol).Order().ToArray();
        if (codes.Length == 0) return source;
        var directory = Path.Combine(AppContext.BaseDirectory, "font-symbols");
        var executable = Path.Combine(directory, "llmchat-font-symbols.exe");
        var donors = new[] { "NotoSansSymbols2-Regular.ttf", "NotoSansSymbols[wght].ttf", "NotoSansMath-Regular.ttf" }.Select(name => Path.Combine(directory, name)).ToArray();
        if (!File.Exists(executable) || donors.Any(path => !File.Exists(path))) throw new Exception("缺少特殊符号补字组件，请更新完整软件资源；构建环境需运行 scripts/prepare-font-symbols.ps1");
        var baseSignature = Convert.ToHexString(SHA256.HashData(source)) + Program.Hash(executable) + string.Join("", donors.Select(Program.Hash));
        var signature = baseSignature + string.Join(",", codes);
        var key = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(signature))).ToLowerInvariant();
        var folder = cacheDirectory ?? Path.Combine(Path.GetTempPath(), "llmchat-font-symbols");
        Directory.CreateDirectory(folder);
        var output = Path.Combine(folder, key + ".font"); var reportPath = Path.Combine(folder, key + ".json");
        var basePath = Path.Combine(folder, Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(baseSignature))) + ".base.json");
        Report report;
        byte[] result;
        if (File.Exists(output) && File.Exists(reportPath)) {
            report = JsonSerializer.Deserialize<Report>(File.ReadAllText(reportPath), Program.Json) ?? throw new Exception("补字检查记录无效");
            result = File.ReadAllBytes(output);
        } else {
            var input = Path.Combine(folder, key + ".source"); var temporary = output + ".tmp";
            File.WriteAllBytes(input, source);
            try {
                Program.Progress($"正在从备用字体补入 {codes.Length} 个特殊字符的真实字形");
                var info = new ProcessStartInfo(executable) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8 };
                using var process = Process.Start(info) ?? throw new Exception("无法启动特殊符号补字组件");
                var stdout = process.StandardOutput.ReadToEndAsync();
                var stderr = Task.Run(async () => {
                    var errors = new StringBuilder(); string? line;
                    while ((line = await process.StandardError.ReadLineAsync()) != null) {
                        if (line.StartsWith("LLMCHAT_FONT_PROGRESS ", StringComparison.Ordinal)) {
                            using var update = JsonDocument.Parse(line[22..]);
                            Program.Progress(update.RootElement.GetProperty("detail").GetString()!);
                        } else errors.AppendLine(line);
                    }
                    return errors.ToString();
                });
                var prepared = File.Exists(basePath) ? JsonSerializer.Deserialize<BaseCache>(File.ReadAllText(basePath), Program.Json) : null;
                var baseFont = prepared == null ? null : Program.Within(folder, prepared.Font);
                if (baseFont != null && !File.Exists(baseFont)) { baseFont = null; prepared = null; }
                process.StandardInput.Write(JsonSerializer.Serialize(new { source = input, output = temporary, donors, codepoints = codes, baseFont, baseMappings = prepared?.Report.Mappings }, Program.Json)); process.StandardInput.Close();
                try { while (!process.WaitForExit(100)) checkStop?.Invoke(); }
                catch { if (!process.HasExited) process.Kill(true); process.WaitForExit(); throw; }
                var error = stderr.GetAwaiter().GetResult(); var response = stdout.GetAwaiter().GetResult();
                if (process.ExitCode != 0) throw new Exception("特殊符号补字失败：" + error.Trim());
                report = JsonSerializer.Deserialize<Report>(response, Program.Json) ?? throw new Exception("补字组件响应无效");
                result = File.ReadAllBytes(temporary);
                var mapped = string.Concat(report.Mappings.Select(mapping => char.ConvertFromUtf32(mapping.Codepoint)));
                if (mapped.Length > 0 && FontCoverage.Missing(result, mapped).Count > 0) throw new Exception("补入的字符映射未通过校验");
                File.Move(temporary, output, true); Program.WriteJson(reportPath, report);
                Program.WriteJson(basePath, new BaseCache(Path.GetFileName(output), report));
            } finally { File.Delete(input); File.Delete(temporary); }
        }
        changes = report.Mappings.Where(mapping => codes.Contains(mapping.Codepoint)).Select(mapping => $"真实字形补入：{char.ConvertFromUtf32(mapping.Codepoint)} U+{mapping.Codepoint:X4} → {mapping.Font}，源字形 {mapping.Glyph}，保留原 Unicode 编码。").ToArray();
        foreach (var change in changes) Program.Progress(change);
        foreach (var code in report.Missing) Program.Progress($"备用符号字体未覆盖：{char.ConvertFromUtf32(code)} U+{code:X4}");
        return result;
    }
    static bool IsSymbol(int code)
    {
        var category = Rune.GetUnicodeCategory(new Rune(code));
        return category is UnicodeCategory.MathSymbol or UnicodeCategory.CurrencySymbol or UnicodeCategory.ModifierSymbol or UnicodeCategory.OtherSymbol
            or UnicodeCategory.ConnectorPunctuation or UnicodeCategory.DashPunctuation or UnicodeCategory.OpenPunctuation or UnicodeCategory.ClosePunctuation
            or UnicodeCategory.InitialQuotePunctuation or UnicodeCategory.FinalQuotePunctuation or UnicodeCategory.OtherPunctuation or UnicodeCategory.LetterNumber or UnicodeCategory.OtherNumber;
    }
}

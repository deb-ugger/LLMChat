using System.Buffers.Binary;
using System.Globalization;
using System.Security.Cryptography;

namespace LLMChat.UnityOffline;

internal static class YooAssetPackages
{
    internal static string[] Find(string root)
    {
        var options = new EnumerationOptions { AttributesToSkip = FileAttributes.ReparsePoint };
        var dataFolders = Directory.EnumerateDirectories(root, "*_Data", options).Prepend(root);
        return dataFolders.Select(data => Path.Combine(data, "StreamingAssets", "yoo"))
            .Where(path => Directory.Exists(path) && (File.GetAttributes(path) & FileAttributes.ReparsePoint) == 0)
            .SelectMany(path => Directory.EnumerateDirectories(path, "*", options))
            .Where(path => File.Exists(Path.Combine(path, Path.GetFileName(path) + ".version")))
            .Select(path => Path.GetRelativePath(root, path).Replace('\\', '/'))
            .Order(StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    static bool BelongsTo(string relative, string package) =>
        relative.StartsWith(package + "/", StringComparison.OrdinalIgnoreCase);

    internal static bool IsCatalog(string[] packages, string relative)
    {
        var name = Path.GetFileName(relative);
        if (!name.Equals("BuiltinCatalog.json", StringComparison.OrdinalIgnoreCase) &&
            !name.Equals("BuildinCatalog.json", StringComparison.OrdinalIgnoreCase)) return false;
        return packages.Any(package => BelongsTo(relative.Replace('\\', '/'), package));
    }

    internal static string Describe(string root, string package, Action checkStop)
    {
        var status = ManifestStatus(Program.Within(root, package), checkStop);
        return $"YooAsset 资源包 {package}（{status}）。可以扫描资源，暂不支持回写包内 Bundle。";
    }

    static string ManifestStatus(string directory, Action checkStop)
    {
        var name = Path.GetFileName(directory);
        try
        {
            var version = File.ReadAllText(Path.Combine(directory, name + ".version")).Trim();
            if (version.Length == 0 || version.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
                return "版本文件无有效版本号";
            var manifest = Path.Combine(directory, name + "_" + version);
            if (!File.Exists(manifest + ".bytes") || !File.Exists(manifest + ".hash"))
                return $"版本 {version}，缺少清单文件或校验文件";

            var hash = File.ReadAllText(manifest + ".hash").Trim();
            using var input = File.OpenRead(manifest + ".bytes");
            if (input.Length == 0) return $"版本 {version}，清单为空";
            var matches = false;
            // YooAsset stores the CRC32 bytes in little-endian hex order.
            if (hash.Length == 8 && uint.TryParse(hash, NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out var crc))
                matches = ResourceCrc32.Compute(input, checkStop) == BinaryPrimitives.ReverseEndianness(crc);
            else if (hash.Length == 32 && hash.All(Uri.IsHexDigit))
                matches = Convert.ToHexString(MD5.HashData(input)).Equals(hash, StringComparison.OrdinalIgnoreCase);
            else
                return $"版本 {version}，清单校验值格式无法识别";
            return $"版本 {version}，清单校验{(matches ? "通过" : "不匹配")}";
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            return "清单读取失败：" + error.Message;
        }
    }

    internal static void EnsureWritable(string root, IEnumerable<string> files)
    {
        var bundles = files.Where(file => Path.GetExtension(file).ToLowerInvariant() is ".bundle" or ".ab" or ".unity3d").ToArray();
        if (bundles.Length == 0) return;
        var packages = Find(root);
        foreach (var file in bundles)
        {
            var relative = Path.GetRelativePath(root, Program.Within(root, file)).Replace('\\', '/');
            if (packages.Any(package => BelongsTo(relative, package)))
                throw new InvalidDataException($"暂不支持回写 YooAsset 资源包：{relative}。请取消选中来自该包的文本或图片，或取消涉及该包的字体替换。");
        }
    }
}

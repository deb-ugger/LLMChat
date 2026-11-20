using System.Buffers.Binary;
using System.Security.Cryptography;
using AssetsTools.NET.Extra;

namespace LLMChat.UnityOffline;

public static class AddressableCatalog
{
    public static uint BundleCrc(string path, Action? cancel = null) {
        var manager = new AssetsManager();
        try {
            var bundle = manager.LoadBundleFile(path, true); var stream = bundle.file.DataReader.BaseStream; stream.Position = 0;
            return ResourceCrc32.Compute(stream, cancel);
        } finally { manager.UnloadAll(); }
    }
    // Addressables BinaryStorageBuffer v2, SerializedData is five uints:
    // hashId, bundleNameId, crc, bundleSize, commonId. Match both the original
    // uncompressed bundle CRC and size, and check references before editing.
    public static void UpdateBinary(byte[] catalog, uint originalCrc, uint originalSize, uint crc, uint size, byte[] hash) {
        if (catalog.Length < 36 || BinaryPrimitives.ReadUInt32LittleEndian(catalog) != 0x0de38942 || BinaryPrimitives.ReadInt32LittleEndian(catalog.AsSpan(4)) != 2) throw new InvalidDataException("尚不支持此 Addressables Catalog 布局，未生成可安装补丁");
        var matches = new List<int>();
        for (var i = 8; i <= catalog.Length - 12; i++) {
            if (BinaryPrimitives.ReadUInt32LittleEndian(catalog.AsSpan(i)) != originalCrc || BinaryPrimitives.ReadUInt32LittleEndian(catalog.AsSpan(i + 4)) != originalSize) continue;
            var hashId = BinaryPrimitives.ReadUInt32LittleEndian(catalog.AsSpan(i - 8)); var nameId = BinaryPrimitives.ReadUInt32LittleEndian(catalog.AsSpan(i - 4)); var commonId = BinaryPrimitives.ReadUInt32LittleEndian(catalog.AsSpan(i + 8));
            if (hashId > catalog.Length - 16 || (nameId & 0x3fffffff) >= catalog.Length || commonId > catalog.Length - 4) continue;
            matches.Add(i);
        }
        if (matches.Count != 1) throw new InvalidDataException($"Catalog 中未唯一定位 Bundle 的 CRC/大小记录（{matches.Count} 项），未绕过游戏校验");
        var offset = matches[0]; var id = (int)BinaryPrimitives.ReadUInt32LittleEndian(catalog.AsSpan(offset - 8));
        hash.AsSpan(0, 16).CopyTo(catalog.AsSpan(id, 16));
        BinaryPrimitives.WriteUInt32LittleEndian(catalog.AsSpan(offset), crc); BinaryPrimitives.WriteUInt32LittleEndian(catalog.AsSpan(offset + 4), size);
    }
    public static void Update(Project project, string folder, List<PatchFile> manifest, Dictionary<string, string> originals, Action cancel) {
        var bundles = manifest.Where(f => f.File.Replace('\\', '/').Contains("/StreamingAssets/aa/", StringComparison.OrdinalIgnoreCase) && f.File.EndsWith(".bundle", StringComparison.OrdinalIgnoreCase)).ToArray();
        if (bundles.Length == 0) return;
        var catalogs = ScanInspection.Inspect(project.Root).Catalogs;
        if (catalogs.Length == 0) throw new InvalidDataException("修改了 Addressables Bundle，但没有找到 Catalog，不能验证加载索引");
        if (catalogs.Any(path => !path.EndsWith(".bin", StringComparison.OrdinalIgnoreCase))) throw new InvalidDataException("本次 Addressables 回写仅支持已验证的二进制 Catalog v2；JSON/Bundle Catalog 尚未更新，已停止生成");
        foreach (var relative in catalogs) {
            cancel(); var original = originals.GetValueOrDefault(relative) ?? Program.Within(project.Root, relative); var bytes = File.ReadAllBytes(original);
            foreach (var bundle in bundles) {
                cancel(); Program.Progress("更新资源索引与 CRC：" + Path.GetFileName(bundle.File), 0, null, folder);
                var source = originals.GetValueOrDefault(bundle.File) ?? Program.Within(project.Root, bundle.File); var destination = Program.Within(Path.Combine(folder, "patch"), bundle.File);
                using var bundleStream = File.OpenRead(destination);
                UpdateBinary(bytes, BundleCrc(source, cancel), checked((uint)new FileInfo(source).Length), BundleCrc(destination, cancel), checked((uint)new FileInfo(destination).Length), MD5.HashData(bundleStream));
            }
            Write(relative, bytes);
            var hashPath = Path.ChangeExtension(relative, ".hash");
            if (File.Exists(Program.Within(project.Root, hashPath))) Write(hashPath, System.Text.Encoding.ASCII.GetBytes(Convert.ToHexString(MD5.HashData(bytes)).ToLowerInvariant()));
            void Write(string path, byte[] data) {
                var source = originals.GetValueOrDefault(path) ?? Program.Within(project.Root, path);
                var backup = Program.Within(Path.Combine(folder, "original"), path); var destination = Program.Within(Path.Combine(folder, "patch"), path);
                Directory.CreateDirectory(Path.GetDirectoryName(backup)!); Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
                File.Copy(source, backup, true); File.WriteAllBytes(destination, data);
                if (!File.ReadAllBytes(destination).AsSpan().SequenceEqual(data)) throw new IOException("Catalog 写入校验失败");
                manifest.RemoveAll(item => item.File == path); manifest.Add(new(path, Program.Hash(source), Program.Hash(destination), 0));
            }
        }
        project.Warnings.RemoveAll(message => message.StartsWith("已同步 Addressables Catalog、CRC、", StringComparison.Ordinal));
        project.Warnings.Add($"已同步 Addressables Catalog、CRC、Bundle 缓存哈希及 Catalog.hash：{bundles.Length} 个 Bundle。");
    }
}

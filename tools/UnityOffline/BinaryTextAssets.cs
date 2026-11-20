using System.Buffers.Binary;
using System.Text;
using AssetsTools.NET;
using AssetsTools.NET.Extra;

namespace LLMChat.UnityOffline;

public sealed record BinaryTextAssetInfo(string File, string Container, string ObjectId, string Name, BinaryTextAssetSummary Structure);
public sealed record BinaryTextAssetSummary(string Format, int Length, int ParsedBytes,
    string? RootType = null, string[]? RootFields = null, int? Nodes = null, int? Arrays = null,
    int? Strings = null, string? Version = null, int? Bones = null, int? Slots = null, int? Objects = null, string[]? AssetTypes = null,
    SpineSkeletonSummary? Skeleton = null);

internal static class BinaryTextAssets
{
    static readonly UnicodeEncoding Utf16 = new(false, false, true);

    internal static BinaryTextAssetSummary? Read(string name, byte[] bytes, Action? checkStop = null)
    {
        if (name.EndsWith(".skel", StringComparison.OrdinalIgnoreCase) || name.EndsWith(".skel.bytes", StringComparison.OrdinalIgnoreCase))
            return SpineBinaryInspection.Read(bytes, checkStop);
        // A root node followed by the first Odin type definition.
        if (bytes.Length >= 11 && bytes[0] is 0x02 or 0x04 && bytes[1] == 0x2f &&
            BinaryPrimitives.ReadInt32LittleEndian(bytes.AsSpan(2)) == 0)
            return ReadOdin(bytes, checkStop);
        if (HasUnityFileHeader(bytes)) return ReadUnityFile(bytes, checkStop);
        return null;
    }

    static bool HasUnityFileHeader(ReadOnlySpan<byte> bytes)
    {
        const int headerSize = 48;
        if (bytes.Length < headerSize || bytes[16] > 1 ||
            BinaryPrimitives.ReadUInt32BigEndian(bytes[8..]) != 22 ||
            BinaryPrimitives.ReadInt64BigEndian(bytes[24..]) != bytes.Length) return false;
        var metadataSize = BinaryPrimitives.ReadUInt32BigEndian(bytes[20..]);
        var dataOffset = BinaryPrimitives.ReadInt64BigEndian(bytes[32..]);
        return metadataSize > 0 && dataOffset >= headerSize + (long)metadataSize && dataOffset <= bytes.Length;
    }

    static BinaryTextAssetSummary ReadUnityFile(byte[] bytes, Action? checkStop)
    {
        using var stream = new MemoryStream(bytes, writable: false);
        var manager = new AssetsManager();
        try
        {
            var asset = manager.LoadAssetsFile(stream, "embedded.assets", false);
            if (!asset.file.Metadata.TypeTreeEnabled)
                throw new InvalidDataException("嵌套 Unity 文件缺少对象类型树");
            var records = asset.file.Metadata.AssetInfos;
            var names = new HashSet<string>(StringComparer.Ordinal);
            var end = asset.file.Header.DataOffset;
            string[]? fields = null;
            foreach (var record in records)
            {
                checkStop?.Invoke();
                var start = record.GetAbsoluteByteOffset(asset.file);
                var limit = start + record.ByteSize;
                if (start < asset.file.Header.DataOffset || limit < start || limit > bytes.Length)
                    throw new InvalidDataException($"嵌套 Unity 对象 #{record.PathId} 越界");
                var value = manager.GetBaseField(asset, record);
                if (asset.file.Reader.Position != limit)
                    throw new InvalidDataException($"嵌套 Unity 对象 #{record.PathId} 读取长度不匹配");
                names.Add(((AssetClassID)record.TypeId).ToString());
                if (records.Count == 1) fields = value.Children.Select(child => child.FieldName).ToArray();
                end = Math.Max(end, limit);
            }
            return new("Unity serialized file", bytes.Length, checked((int)end), RootFields: fields,
                Version: asset.file.Metadata.UnityVersion, Objects: records.Count, AssetTypes: names.Order(StringComparer.Ordinal).ToArray());
        }
        finally { manager.UnloadAll(); }
    }

    // Odin stores names as tags, then primitive payloads and balanced nodes.
    // Inspect the format without resolving CLR types or constructing objects.
    static BinaryTextAssetSummary ReadOdin(byte[] bytes, Action? checkStop)
    {
        var reader = new FormatReader(bytes);
        var nesting = new Stack<byte>();
        var knownTypes = new HashSet<int>();
        var rootFields = new List<string>();
        string? rootType = null;
        var nodes = 0;
        var arrays = 0;
        var strings = 0;
        var entries = 0;
        while (reader.Remaining > 0)
        {
            if ((entries++ & 4095) == 0) checkStop?.Invoke();
            var tag = reader.Byte();
            var named = tag is 0x01 or 0x03 or 0x32 || tag is >= 0x09 and <= 0x2e && (tag & 1) != 0;
            if (named)
            {
                var field = reader.OdinString();
                if (nesting.Count == 1) rootFields.Add(DecodeOdin(field));
            }
            switch (tag)
            {
                case >= 0x01 and <= 0x04:
                    var typeTag = reader.Byte();
                    if (typeTag == 0x2f)
                    {
                        if (!knownTypes.Add(reader.Int32())) throw new InvalidDataException("Odin 类型编号重复");
                        var typeName = reader.OdinString();
                        if (nodes == 0) rootType = DecodeOdin(typeName);
                    }
                    else if (typeTag == 0x30)
                    {
                        if (!knownTypes.Contains(reader.Int32())) throw new InvalidDataException("Odin 类型引用不存在");
                    }
                    else if (typeTag != 0x2e) throw new InvalidDataException("Odin 节点类型头无效");
                    if (tag is 0x01 or 0x02) reader.Take(4);
                    nesting.Push(0x05);
                    nodes++;
                    break;
                case 0x06:
                    if (reader.Int64() < 0) throw new InvalidDataException("Odin 数组长度无效");
                    nesting.Push(0x07);
                    arrays++;
                    break;
                case 0x05 or 0x07:
                    if (!nesting.TryPop(out var expected) || expected != tag)
                        throw new InvalidDataException("Odin 节点或数组未正确闭合");
                    break;
                case 0x08:
                    var count = reader.Int32();
                    var width = reader.Int32();
                    if (count < 0 || width <= 0 || count > reader.Remaining / width)
                        throw new InvalidDataException("Odin 基元数组越界");
                    reader.Take(count * width);
                    arrays++;
                    break;
                case 0x27 or 0x28:
                    reader.OdinString();
                    strings++;
                    break;
                case 0x32 or 0x33:
                    reader.OdinString();
                    break;
                case 0x31:
                    if (reader.Remaining != 0) throw new InvalidDataException("Odin 结束标记后仍有数据");
                    break;
                default:
                    reader.Take(OdinPrimitiveWidth(tag));
                    break;
            }
        }

        if (nesting.Count != 0 || string.IsNullOrWhiteSpace(rootType))
            throw new InvalidDataException("Odin 根节点不完整");
        return new("Odin binary", bytes.Length, reader.Offset, RootType: rootType,
            RootFields: rootFields.Distinct(StringComparer.Ordinal).ToArray(), Nodes: nodes, Arrays: arrays, Strings: strings);
    }

    static int OdinPrimitiveWidth(byte tag) => tag switch
    {
        0x0f or 0x10 or 0x11 or 0x12 or 0x2b or 0x2c => 1,
        >= 0x13 and <= 0x16 or 0x25 or 0x26 => 2,
        >= 0x09 and <= 0x0c or >= 0x17 and <= 0x1a or 0x1f or 0x20 => 4,
        >= 0x1b and <= 0x1e or 0x21 or 0x22 => 8,
        0x0d or 0x0e or 0x23 or 0x24 or 0x29 or 0x2a => 16,
        0x2d or 0x2e => 0,
        _ => throw new InvalidDataException($"不支持的 Odin 二进制标记 0x{tag:X2}")
    };

    static string DecodeOdin(ReadOnlySpan<byte> encoded) =>
        (encoded[0] == 0 ? Encoding.Latin1 : Utf16).GetString(encoded[5..]);

    internal ref struct FormatReader(ReadOnlySpan<byte> data)
    {
        readonly ReadOnlySpan<byte> data = data;
        internal int Offset { get; private set; }
        internal int Remaining => data.Length - Offset;

        internal ReadOnlySpan<byte> Take(int length)
        {
            if ((uint)length > (uint)Remaining) throw new InvalidDataException($"二进制资源在偏移 {Offset} 越界");
            var part = data.Slice(Offset, length);
            Offset += length;
            return part;
        }

        internal byte Byte() => Take(1)[0];
        internal int Int32() => BinaryPrimitives.ReadInt32LittleEndian(Take(4));
        internal long Int64() => BinaryPrimitives.ReadInt64LittleEndian(Take(8));
        internal bool Bool() => Byte() switch { 0 => false, 1 => true, _ => throw new InvalidDataException("二进制布尔值无效") };

        internal ReadOnlySpan<byte> OdinString()
        {
            var start = Offset;
            var width = Byte() switch { 0 => 1, 1 => 2, _ => throw new InvalidDataException("Odin 字符串编码标记无效") };
            var length = Int32();
            if (length < 0 || length > Remaining / width) throw new InvalidDataException("Odin 字符串长度越界");
            Take(length * width);
            return data[start..Offset];
        }

        internal int VarUInt()
        {
            var value = VarBits();
            if (value > int.MaxValue) throw new InvalidDataException("Spine 非负整数越界");
            return (int)value;
        }

        internal uint VarBits()
        {
            uint value = 0;
            for (var shift = 0; shift <= 28; shift += 7)
            {
                var part = Byte();
                if (shift == 28 && part > 15) break;
                value |= (uint)(part & 0x7f) << shift;
                if ((part & 0x80) == 0) return value;
            }
            throw new InvalidDataException("Spine 可变长度整数越界");
        }

        internal ReadOnlySpan<byte> SpineString() => Take(Math.Max(0, VarUInt() - 1));
        internal int SpineCount()
        {
            var count = VarUInt();
            if (count > Remaining) throw new InvalidDataException("Spine 表项数量越界");
            return count;
        }
    }
}

using System.Buffers.Binary;
using System.Text;

namespace LLMChat.UnityOffline;

internal static class Il2CppMetadata
{
    static readonly UTF8Encoding Utf8 = new(false, true);

    internal static int ReadVersion(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length < 32 || BinaryPrimitives.ReadUInt32LittleEndian(bytes) != 0xFAB11BAF)
            throw new InvalidDataException("IL2CPP metadata 文件头无效或已加密");
        return BinaryPrimitives.ReadInt32LittleEndian(bytes[4..]);
    }

    internal static string[] ReadV39Literals(ReadOnlySpan<byte> bytes, Action checkStop)
    {
        // Section headers contain offset, byte length, and entry count in v39.
        // Each literal stores only its offset into the string data section.
        var tableOffset = BinaryPrimitives.ReadInt32LittleEndian(bytes[8..]);
        var tableLength = BinaryPrimitives.ReadInt32LittleEndian(bytes[12..]);
        var count = BinaryPrimitives.ReadInt32LittleEndian(bytes[16..]);
        var dataOffset = BinaryPrimitives.ReadInt32LittleEndian(bytes[20..]);
        var dataLength = BinaryPrimitives.ReadInt32LittleEndian(bytes[24..]);
        if (tableOffset < 32 || count < 0 || tableLength != (long)count * sizeof(int) ||
            dataOffset < (long)tableOffset + tableLength || dataLength < 0 ||
            (long)dataOffset + dataLength > bytes.Length)
            throw new InvalidDataException("IL2CPP v39 字符串表边界无效");

        var offsets = bytes.Slice(tableOffset, tableLength);
        var data = bytes.Slice(dataOffset, dataLength);
        var literals = new string[count];
        var offset = count > 0 ? BinaryPrimitives.ReadInt32LittleEndian(offsets) : 0;
        for (var index = 0; index < count; index++)
        {
            checkStop();
            var next = index + 1 < count ? BinaryPrimitives.ReadInt32LittleEndian(offsets[((index + 1) * sizeof(int))..]) : dataLength;
            if (offset < 0 || next < offset || next > dataLength)
                throw new InvalidDataException($"IL2CPP v39 字符串 #{index} 的数据范围无效");
            try { literals[index] = Utf8.GetString(data[offset..next]); }
            catch (DecoderFallbackException error) { throw new InvalidDataException($"IL2CPP v39 字符串 #{index} 的 UTF-8 编码无效", error); }
            offset = next;
        }
        return literals;
    }
}

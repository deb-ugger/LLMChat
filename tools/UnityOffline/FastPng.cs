using System.Buffers.Binary;
using System.IO.Compression;
using System.Text;

namespace LLMChat.UnityOffline;

// Lossless RGBA PNG using the native zlib implementation and horizontal filtering.
public static class FastPng
{
    static readonly uint[] CrcTable = CreateCrcTable();
    static uint[] CreateCrcTable()
    {
        var table = new uint[256];
        for (uint i = 0; i < table.Length; i++) {
            var value = i;
            for (var bit = 0; bit < 8; bit++) value = (value & 1) != 0 ? 0xedb88320u ^ (value >> 1) : value >> 1;
            table[i] = value;
        }
        return table;
    }
    static void Chunk(Stream output, string name, ReadOnlySpan<byte> data)
    {
        Span<byte> number = stackalloc byte[4];
        BinaryPrimitives.WriteInt32BigEndian(number, data.Length); output.Write(number);
        var type = Encoding.ASCII.GetBytes(name); output.Write(type); output.Write(data);
        var crc = uint.MaxValue;
        foreach (var value in type) crc = CrcTable[(crc ^ value) & 255] ^ (crc >> 8);
        foreach (var value in data) crc = CrcTable[(crc ^ value) & 255] ^ (crc >> 8);
        BinaryPrimitives.WriteUInt32BigEndian(number, ~crc); output.Write(number);
    }
    public static void Write(byte[] rgba, int width, int height, Stream output)
    {
        if (width <= 0 || height <= 0 || (long)width * height * 4 != rgba.LongLength) throw new ArgumentException("PNG 像素尺寸不匹配");
        output.Write(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 });
        Span<byte> header = stackalloc byte[13]; header.Clear();
        BinaryPrimitives.WriteInt32BigEndian(header, width); BinaryPrimitives.WriteInt32BigEndian(header[4..], height);
        header[8] = 8; header[9] = 6; Chunk(output, "IHDR", header);
        using var compressed = new MemoryStream();
        using (var zlib = new ZLibStream(compressed, CompressionLevel.Fastest, true)) {
            var stride = checked(width * 4); var row = new byte[stride + 1]; row[0] = 1;
            for (var y = 0; y < height; y++) {
                var offset = y * stride;
                for (var x = 0; x < stride; x++) row[x + 1] = unchecked((byte)(rgba[offset + x] - (x >= 4 ? rgba[offset + x - 4] : 0)));
                zlib.Write(row);
            }
        }
        var bytes = compressed.GetBuffer().AsSpan(0, checked((int)compressed.Length));
        while (!bytes.IsEmpty) { var count = Math.Min(bytes.Length, 65536); Chunk(output, "IDAT", bytes[..count]); bytes = bytes[count..]; }
        Chunk(output, "IEND", []);
    }
}

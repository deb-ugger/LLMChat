namespace LLMChat.UnityOffline;

internal static class ResourceCrc32
{
    static readonly uint[] Table = BuildTable();

    static uint[] BuildTable()
    {
        var table = new uint[256];
        for (var i = 0; i < table.Length; i++)
        {
            var crc = (uint)i;
            for (var bit = 0; bit < 8; bit++)
                crc = (crc & 1) != 0 ? 0xedb88320 ^ (crc >> 1) : crc >> 1;
            table[i] = crc;
        }
        return table;
    }

    internal static uint Compute(Stream stream, Action? checkStop = null)
    {
        var crc = uint.MaxValue;
        var buffer = new byte[65536];
        int count;
        while ((count = stream.Read(buffer)) > 0)
        {
            checkStop?.Invoke();
            for (var i = 0; i < count; i++) crc = Table[(crc ^ buffer[i]) & 255] ^ (crc >> 8);
        }
        return ~crc;
    }
}

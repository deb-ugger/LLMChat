using System.Buffers.Binary;
using System.Text;

namespace LLMChat.UnityOffline;

public static class FontCoverage
{
    public static List<int> Missing(byte[] bytes, string text)
    {
        ushort U16(int p) => BinaryPrimitives.ReadUInt16BigEndian(bytes.AsSpan(p, 2));
        uint U32(int p) => BinaryPrimitives.ReadUInt32BigEndian(bytes.AsSpan(p, 4));
        if (bytes.Length < 12 || U32(0) is not (0x00010000 or 0x4F54544F)) throw new Exception("请选择单个 TTF / OTF 字体，不支持字体集合");
        var cmap = -1;
        for (var i = 0; i < U16(4); i++)
            if (U32(12 + i * 16) == 0x636D6170) cmap = checked((int)U32(20 + i * 16));
        if (cmap < 0) throw new Exception("字体没有 Unicode cmap");
        var tables = new List<int>();
        for (var i = 0; i < U16(cmap + 2); i++)
        {
            var record = cmap + 4 + i * 8; var platform = U16(record); var encoding = U16(record + 2);
            if (platform == 0 || platform == 3 && encoding is 1 or 10) tables.Add(checked(cmap + (int)U32(record + 4)));
        }
        // Both supported cmap formats store ranges ordered by their inclusive end code.
        int FirstRangeEndingAtOrAfter(int code, int count, int ends, bool format12)
        {
            int low = 0, high = count;
            while (low < high) {
                int mid = low + (high - low) / 2;
                uint end = format12 ? U32(checked(ends + mid * 12)) : U16(ends + mid * 2);
                if (end < code) low = mid + 1;
                else high = mid;
            }
            return low;
        }
        bool Present(int code)
        {
            foreach (var t in tables)
            {
                var format = U16(t);
                if (format == 12)
                {
                    var groups = checked((int)U32(t + 12));
                    var i = FirstRangeEndingAtOrAfter(code, groups, t + 20, true);
                    if (i == groups) continue;
                    var p = checked(t + 16 + i * 12); var start = U32(p);
                    if (code >= start && U32(p + 8) + code - start != 0) return true;
                }
                else if (format == 4 && code <= 0xFFFF)
                {
                    var count = U16(t + 6) / 2;
                    var i = FirstRangeEndingAtOrAfter(code, count, t + 14, false);
                    if (i == count) continue;
                    var start = U16(t + 16 + count * 2 + i * 2);
                    if (code < start) continue;
                    var delta = U16(t + 16 + count * 4 + i * 2); var offsetPos = t + 16 + count * 6 + i * 2; var offset = U16(offsetPos);
                    var glyph = offset == 0 ? code : U16(offsetPos + offset + (code - start) * 2);
                    if (offset != 0 && glyph == 0) continue;
                    if ((glyph + delta & 0xFFFF) != 0) return true;
                }
            }
            return false;
        }
        return text.EnumerateRunes().Where(r => !Rune.IsControl(r) && !Rune.IsWhiteSpace(r) && Rune.GetUnicodeCategory(r) != System.Globalization.UnicodeCategory.Format).Select(r => r.Value).Distinct().Where(c => !Present(c)).ToList();
    }
}

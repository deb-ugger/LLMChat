using System.Buffers.Binary;
using System.Runtime.InteropServices;
using System.Text;

namespace LLMChat.UnityOffline;

public sealed record RasterGlyph(int Code, int Width, int Height, int BearingX, int BearingY, int Advance, byte[] Pixels)
{
    public int X { get; set; }
    public int Y { get; set; }
}
public sealed record RasterAtlas(int Width, int Height, int PointSize, int Ascent, int Descent, int Padding, RasterGlyph[] Glyphs, byte[] Pixels);

// Uses a private font handle, never installs fonts or lets GDI substitute missing glyphs.
public sealed class FontRasterizer : IDisposable
{
    nint resource, dc, font, previous;
    readonly byte[] bytes;
    readonly string family;
    [StructLayout(LayoutKind.Sequential)] struct Matrix { public int A, B, C, D; }
    [StructLayout(LayoutKind.Sequential)] struct Metrics { public uint Width, Height; public int X, Y; public short AdvanceX, AdvanceY; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct TextMetrics
    {
        public int Height, Ascent, Descent, InternalLeading, ExternalLeading, AverageWidth, MaxWidth, Weight, Overhang, AspectX, AspectY;
        public char First, Last, Default, Break;
        public byte Italic, Underlined, StruckOut, PitchAndFamily, CharacterSet;
    }
    [DllImport("gdi32.dll")] static extern nint AddFontMemResourceEx(byte[] data, uint size, nint reserved, out uint count);
    [DllImport("gdi32.dll")] static extern bool RemoveFontMemResourceEx(nint handle);
    [DllImport("gdi32.dll")] static extern nint CreateCompatibleDC(nint dc);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(nint dc);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(nint obj);
    [DllImport("gdi32.dll")] static extern nint SelectObject(nint dc, nint obj);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern nint CreateFontW(int height, int width, int angle, int orientation, int weight, uint italic, uint underline, uint strike, uint charset, uint output, uint clip, uint quality, uint pitch, string face);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern uint GetGlyphIndicesW(nint dc, string text, int count, [Out] ushort[] indices, uint flags);
    [DllImport("gdi32.dll")] static extern uint GetGlyphOutlineW(nint dc, uint glyph, uint format, out Metrics metrics, uint size, [Out] byte[]? buffer, ref Matrix matrix);
    [DllImport("gdi32.dll")] static extern uint GetFontData(nint dc, uint table, uint offset, [Out] byte[]? buffer, uint size);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern bool GetTextMetricsW(nint dc, out TextMetrics metrics);

    static byte[] Table(byte[] data, string tag)
    {
        var count = BinaryPrimitives.ReadUInt16BigEndian(data.AsSpan(4));
        for (var i = 0; i < count; i++) {
            var p = 12 + i * 16;
            if (Encoding.ASCII.GetString(data, p, 4) != tag) continue;
            var offset = checked((int)BinaryPrimitives.ReadUInt32BigEndian(data.AsSpan(p + 8)));
            var size = checked((int)BinaryPrimitives.ReadUInt32BigEndian(data.AsSpan(p + 12)));
            return data.AsSpan(offset, size).ToArray();
        }
        throw new Exception("字体缺少 " + tag + " 表");
    }
    public FontRasterizer(byte[] data)
    {
        if (!OperatingSystem.IsWindows()) throw new Exception("原生字库生成目前需要 Windows");
        bytes = data;
        var names = Table(data, "name");
        int U16(int p) => BinaryPrimitives.ReadUInt16BigEndian(names.AsSpan(p));
        var offset = U16(4); var candidates = new List<(int Rank, string Name)>();
        for (var i = 0; i < U16(2); i++) {
            var p = 6 + i * 12; var id = U16(p + 6);
            if (U16(p) is not (0 or 3) || id is not (1 or 4 or 16)) continue;
            var name = Encoding.BigEndianUnicode.GetString(names, offset + U16(p + 10), U16(p + 8));
            candidates.Add(((id == 1 ? 0 : id == 16 ? 2 : 4) + (U16(p + 4) == 0x409 ? 0 : 1), name));
        }
        family = candidates.OrderBy(c => c.Rank).FirstOrDefault().Name ?? throw new Exception("无法读取字体名称");
        try {
            resource = AddFontMemResourceEx(data, (uint)data.Length, 0, out _);
            if (resource == 0) throw new Exception("Windows 无法加载所选字体，请使用静态 TTF / OTF 字体");
            dc = CreateCompatibleDC(0);
            if (dc == 0) throw new Exception("无法创建字体绘制环境");
        } catch { Dispose(); throw; }
    }
    void Size(int pixels)
    {
        if (font != 0) { SelectObject(dc, previous); DeleteObject(font); font = 0; }
        font = CreateFontW(-pixels, 0, 0, 0, 400, 0, 0, 0, 1, 4, 0, 4, 0, family);
        if (font == 0) throw new Exception("无法创建字体字形");
        previous = SelectObject(dc, font);
        var cmap = Table(bytes, "cmap"); var actual = new byte[cmap.Length];
        if (GetFontData(dc, 0x70616D63, 0, actual, (uint)actual.Length) != actual.Length || !actual.SequenceEqual(cmap))
            throw new Exception("Windows 未选中指定字体，已阻止使用系统替代字体生成图集");
    }
    RasterGlyph Glyph(int code)
    {
        if (code > 0xFFFF) throw new Exception($"原生字库暂不支持非 BMP 字符 U+{code:X}，请从补充字符中移除或使用外部字库");
        var indices = new ushort[1];
        if (GetGlyphIndicesW(dc, char.ConvertFromUtf32(code), 1, indices, 1) == uint.MaxValue || indices[0] == ushort.MaxValue)
            throw new Exception($"所选字体无法绘制字符 U+{code:X4}");
        var matrix = new Matrix { A = 65536, D = 65536 };
        var size = GetGlyphOutlineW(dc, indices[0], 6 | 0x80, out var metrics, 0, null, ref matrix);
        if (size == uint.MaxValue) throw new Exception($"无法读取字形 U+{code:X4}");
        if (size == 0) return new(code, 0, 0, metrics.X, metrics.Y, metrics.AdvanceX, []);
        var buffer = new byte[size];
        if (size > 0 && GetGlyphOutlineW(dc, indices[0], 6 | 0x80, out metrics, size, buffer, ref matrix) == uint.MaxValue) throw new Exception("字形绘制失败");
        var width = checked((int)metrics.Width); var height = checked((int)metrics.Height); var stride = (width + 3) & ~3;
        if ((long)stride * height > buffer.Length) throw new Exception($"字形位图长度不匹配：U+{code:X4}，{width}×{height}，{buffer.Length} 字节");
        var pixels = new byte[checked(width * height)];
        for (var y = 0; y < height; y++) for (var x = 0; x < width; x++) pixels[y * width + x] = (byte)Math.Min(255, buffer[y * stride + x] * 255 / 64);
        return new(code, width, height, metrics.X, metrics.Y, metrics.AdvanceX, pixels);
    }
    public RasterAtlas Generate(string characters, bool sdf, Action? stop = null, Action<int, int>? progress = null)
    {
        var codes = characters.EnumerateRunes().Select(r => r.Value).Where(c => !Rune.IsControl(new Rune(c))).Distinct().Order().ToArray();
        foreach (var size in new[] { 64, 48, 36, 28, 20, 16 }) {
            stop?.Invoke(); Size(size);
            var glyphs = new List<RasterGlyph>();
            foreach (var code in codes) { stop?.Invoke(); glyphs.Add(Glyph(code)); if (glyphs.Count % 16 == 0 || glyphs.Count == codes.Length) progress?.Invoke(glyphs.Count, codes.Length); }
            var padding = sdf ? 8 : 2;
            foreach (var side in new[] { 256, 512, 1024, 2048, 4096 }) {
                var x = 1; var y = 1; var row = 0; var fits = true;
                foreach (var glyph in glyphs.OrderByDescending(g => g.Height).ThenBy(g => g.Code)) {
                    var w = glyph.Width + padding * 2 + 1; var h = glyph.Height + padding * 2 + 1;
                    if (x + w >= side) { x = 1; y += row; row = 0; }
                    if (y + h >= side) { fits = false; break; }
                    glyph.X = x + padding; glyph.Y = y + padding; x += w; row = Math.Max(row, h);
                }
                if (!fits) continue;
                var atlas = new byte[side * side];
                foreach (var glyph in glyphs) {
                    stop?.Invoke();
                    if (glyph.Width == 0 || glyph.Height == 0) continue;
                    if (sdf) {
                        var w = glyph.Width + 2 * padding; var h = glyph.Height + 2 * padding;
                        var coverage = new byte[w * h];
                        for (var iy = 0; iy < glyph.Height; iy++) Array.Copy(glyph.Pixels, iy * glyph.Width, coverage, (iy + padding) * w + padding, glyph.Width);
                        var distance = DistanceField(coverage, w, h, padding);
                        for (var iy = 0; iy < h; iy++) Array.Copy(distance, iy * w, atlas, (glyph.Y - padding + iy) * side + glyph.X - padding, w);
                    } else for (var iy = 0; iy < glyph.Height; iy++) Array.Copy(glyph.Pixels, iy * glyph.Width, atlas, (glyph.Y + iy) * side + glyph.X, glyph.Width);
                }
                if (!GetTextMetricsW(dc, out var metrics)) throw new Exception("无法读取字体行高度");
                return new(side, side, size, metrics.Ascent, metrics.Descent, padding, glyphs.ToArray(), atlas);
            }
        }
        throw new Exception("字符无法放入 4096 像素图集，请减少补充字符或拆分字库");
    }
    public static byte[] DistanceField(byte[] coverage, int width, int height, int spread)
    {
        // Two-pass chamfer distance transform, positive inside and negative outside.
        float[] Distance(bool inside) {
            var d = coverage.Select(c => (c >= 128) == inside ? 0f : 100000f).ToArray();
            void Pass(int begin, int end, int delta) {
                var neighbors = new[] { (-delta, 0, 1f), (0, -delta, 1f), (-delta, -delta, 1.4142136f), (delta, -delta, 1.4142136f) };
                for (var i = begin; i != end; i += delta) {
                    var x = i % width; var y = i / width;
                    foreach (var (dx, dy, cost) in neighbors) {
                        var nx = x + dx; var ny = y + dy;
                        if (nx >= 0 && nx < width && ny >= 0 && ny < height) d[i] = Math.Min(d[i], d[ny * width + nx] + cost);
                    }
                }
            }
            Pass(0, d.Length, 1); Pass(d.Length - 1, -1, -1); return d;
        }
        var toInside = Distance(true); var toOutside = Distance(false); var output = new byte[coverage.Length];
        for (var i = 0; i < output.Length; i++) {
            var signed = coverage[i] >= 128 ? toOutside[i] - .5f : .5f - toInside[i];
            if (coverage[i] > 0 && coverage[i] < 255) signed = coverage[i] / 255f - .5f;
            output[i] = (byte)Math.Clamp((int)Math.Round(127.5 + signed * 127.5 / (spread + 1)), 0, 255);
        }
        return output;
    }
    public void Dispose()
    {
        if (font != 0) { SelectObject(dc, previous); DeleteObject(font); font = 0; }
        if (dc != 0) { DeleteDC(dc); dc = 0; }
        if (resource != 0) { RemoveFontMemResourceEx(resource); resource = 0; }
    }
}

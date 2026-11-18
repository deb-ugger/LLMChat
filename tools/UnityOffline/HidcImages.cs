using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using AssetsTools.NET;
using AssetsTools.NET.Extra;
using AssetsTools.NET.Texture;
using StbImageSharp;

namespace LLMChat.UnityOffline;

// HIDC is a sequence of BC1/BC4 frames, not UTF-8 and not one image per TextAsset.
public static class HidcImages
{
    public static bool IsChunk(byte[] data) => data.Length >= 4 && data.AsSpan(0, 4).SequenceEqual("HIDC"u8);
    public sealed record Header(int Version, int Encoding, int Width, int Height, int First, int Count, int Offset) {
        public int Size => checked(((Width + 3) / 4) * ((Height + 3) / 4) * 8);
    }
    public static Header ReadHeader(byte[] bytes) {
        using var input = new BinaryReader(new MemoryStream(bytes, false));
        if (input.ReadUInt32() != 0x43444948) throw new InvalidDataException("不是 HIDC 图片块");
        var version = input.ReadInt32(); if (version is not (2 or 3)) throw new InvalidDataException("尚不支持的 HIDC 版本：" + version);
        var encoding = version == 3 ? input.ReadByte() : 0;
        var h = new Header(version, encoding, input.ReadInt32(), input.ReadInt32(), input.ReadInt32(), input.ReadInt32(), (int)input.BaseStream.Position);
        if (encoding is not (0 or 1) || h.Width <= 0 || h.Height <= 0 || (long)h.Width * h.Height > 64 * 1024 * 1024 || h.First < 0 || h.Count is < 1 or > 1024) throw new InvalidDataException("HIDC 图片头无效或超过尺寸限制");
        _ = h.Size; return h;
    }
    static int Var(BinaryReader input) {
        uint value = 0;
        for (var shift = 0; shift < 35; shift += 7) { var b = input.ReadByte(); if (shift == 28 && (b & 0xf8) != 0) throw new InvalidDataException("HIDC 整数超出范围"); value |= (uint)(b & 127) << shift; if ((b & 128) == 0) return checked((int)value); }
        throw new InvalidDataException("HIDC 整数无效");
    }
    static void Var(BinaryWriter output, int value) { var n = checked((uint)value); while (n >= 128) { output.Write((byte)(n | 128)); n >>= 7; } output.Write((byte)n); }
    static byte[] Exact(BinaryReader reader, int size) { var data = reader.ReadBytes(size); if (data.Length != size) throw new EndOfStreamException("HIDC 图片块不完整"); return data; }
    public static IEnumerable<(int Index, byte[] Data)> Decode(byte[] bytes, Action? cancel = null) {
        var h = ReadHeader(bytes); using var reader = new BinaryReader(new MemoryStream(bytes, false)); reader.BaseStream.Position = h.Offset;
        var prior = new List<byte[]>();
        for (var i = 0; i < h.Count; i++) {
            cancel?.Invoke(); var kind = reader.ReadByte(); byte[] frame;
            if (kind == 0 && i == 0) frame = Exact(reader, h.Size);
            else if (kind is 1 or 2) {
                var distance = Var(reader); if (distance < 1 || distance > i) throw new InvalidDataException("HIDC 帧引用越界");
                frame = prior[i - distance];
                if (kind == 1) {
                    frame = (byte[])frame.Clone(); var runs = Var(reader); if (runs < 1 || runs > h.Size / 8) throw new InvalidDataException("HIDC 差分段数无效");
                    var end = 0;
                    for (var r = 0; r < runs; r++) {
                        var start = checked(end + Var(reader)); var count = Var(reader);
                        if (count < 1 || start > h.Size / 8 - count) throw new InvalidDataException("HIDC 差分范围越界");
                        Exact(reader, checked(count * 8)).CopyTo(frame, start * 8); end = start + count;
                    }
                }
            } else throw new InvalidDataException("HIDC 帧类型无效：" + kind);
            prior.Add(frame); yield return (h.First + i, frame);
        }
        if (reader.BaseStream.Position != bytes.Length) throw new InvalidDataException("HIDC 图片块存在未解析的尾部数据");
    }
    public static byte[] Pixels(Header h, byte[] raw) {
        var texture = new TextureFile { m_Width = h.Width, m_Height = h.Height, m_TextureFormat = h.Encoding == 0 ? 10 : 45 };
        var rgba = texture.DecodeTextureRaw(raw, false) ?? throw new InvalidDataException("HIDC 纹理解码失败");
        TextureOperations.FlipBGRA32Vertically(rgba, h.Width, h.Height); return rgba;
    }
    static string Digest(byte[] data) => Convert.ToHexString(SHA256.HashData(data)).ToLowerInvariant();
    public static void Scan(Project project, AssetsManager manager, AssetsFileInstance instance, string file, string container) {
        var chunks = new Dictionary<string, (long Id, byte[] Data)>();
        foreach (var info in instance.file.Metadata.AssetInfos.Where(i => i.TypeId == 49)) {
            var field = manager.GetBaseField(instance, info); var bytes = field["m_Script"].AsByteArray;
            if (IsChunk(bytes)) chunks.Add(field["m_Name"].AsString, (info.PathId, bytes));
        }
        if (chunks.Count == 0) return;
        var used = new HashSet<long>();
        foreach (var info in instance.file.Metadata.AssetInfos.Where(i => i.TypeId == 114)) {
            var manifest = manager.GetBaseField(instance, info);
            if (manifest["frames"].IsDummy || manifest["chunks"].IsDummy || manifest["sequenceId"].IsDummy) continue;
            var sequence = manifest["sequenceId"].AsString; var frames = manifest["frames"]["Array"].Children; var metadata = manifest["chunks"]["Array"].Children;
            for (var c = 0; c < metadata.Count; c++) {
                project.CheckCancellation?.Invoke();
                if (!chunks.TryGetValue(sequence + "_Chunk" + c.ToString("00"), out var chunk)) throw new InvalidDataException("HIDC manifest 缺少图片块：" + sequence + "/" + c);
                var h = ReadHeader(chunk.Data); var meta = metadata[c];
                if (h.First != meta["firstFrameIndex"].AsInt || h.Count != meta["frameCount"].AsInt || h.Width != manifest["width"].AsInt || h.Height != manifest["height"].AsInt || h.First > frames.Count - h.Count) throw new InvalidDataException("HIDC manifest 与图片头不匹配：" + sequence);
                var hash = Digest(chunk.Data); var payload = "images/hidc/" + hash + ".bin"; var path = Program.Within(project.Folder, payload);
                Directory.CreateDirectory(Path.GetDirectoryName(path)!); if (!File.Exists(path)) File.WriteAllBytes(path, chunk.Data);
                for (var f = h.First; f < h.First + h.Count; f++) {
                    if (frames[f]["chunkIndex"].AsInt != c) throw new InvalidDataException("HIDC 帧索引不匹配");
                    var id = Digest(Encoding.UTF8.GetBytes(file + "\n" + container + "\n" + chunk.Id + ":" + f));
                    project.Images.Add(new ImageResource { Id = id, Kind = "hidc", File = file, Container = container, ObjectId = chunk.Id.ToString(), Name = frames[f]["frameKey"].AsString,
                        Width = h.Width, Height = h.Height, HidcFrame = f, HidcPayload = payload, SourceFile = "images/source/" + id + ".png", SourceHash = Digest(Encoding.UTF8.GetBytes(hash + ":" + f)) });
                }
                used.Add(chunk.Id);
                project.ReportScanDetail?.Invoke($"已索引 HIDC 图片：{sequence} · {h.First + h.Count}/{frames.Count}，查看或识别时解码");
            }
        }
        if (used.Count != chunks.Count) throw new InvalidDataException("HIDC 图片块缺少匹配的序列 manifest，未将二进制内容作为文本提取");
    }
    public static void EnsureSource(Project project, ImageResource image, Action? cancel = null) {
        if (image.Kind != "hidc") return;
        var path = Program.Within(project.Folder, image.SourceFile); if (File.Exists(path)) return;
        var payload = Program.Within(project.Folder, image.HidcPayload); var bytes = File.ReadAllBytes(payload);
        if (Digest(Encoding.UTF8.GetBytes(Digest(bytes) + ":" + image.HidcFrame)) != image.SourceHash) throw new InvalidDataException("HIDC 原始图片块缓存已改变，请重新扫描：" + image.Name);
        var h = ReadHeader(bytes); byte[]? raw = null;
        foreach (var frame in Decode(bytes, cancel)) { if (frame.Index != image.HidcFrame) continue; raw = frame.Data; break; }
        if (raw == null) throw new InvalidDataException("HIDC 帧索引不存在：" + image.Name);
        var rgba = Pixels(h, raw); Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try { using (var output = File.Create(temporary)) FastPng.Write(rgba, h.Width, h.Height, output); File.Move(temporary, path, true); }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }
    // Changed frames are rebuilt as sparse references; every untouched frame keeps
    // its original compressed blocks, including frames referencing an edited frame.
    public static void Apply(Project project, ImageResource[] images, AssetTypeValueField field) {
        var original = field["m_Script"].AsByteArray; var h = ReadHeader(original);
        var chunkHash = Digest(original);
        var replacement = images.ToDictionary(i => i.HidcFrame ?? throw new InvalidDataException("缺少 HIDC 帧索引")); var frames = Decode(original, project.CheckCancellation).Select(f => f.Data).ToArray();
        foreach (var item in replacement) {
            if (Digest(Encoding.UTF8.GetBytes(chunkHash + ":" + item.Key)) != item.Value.SourceHash) throw new InvalidDataException("HIDC 原始图片块与扫描版本不一致：" + item.Value.Name);
            var index = item.Key - h.First; if (index < 0 || index >= frames.Length) throw new InvalidDataException("HIDC 译图帧越界");
            frames[index] = EncodeFrame(project, item.Value, h, frames[index]);
        }
        using var output = new MemoryStream(); using var writer = new BinaryWriter(output);
        writer.Write(original, 0, h.Offset);
        for (var i = 0; i < frames.Length; i++) {
            project.CheckCancellation?.Invoke();
            if (i == 0) { writer.Write((byte)0); writer.Write(frames[i]); continue; }
            var runs = new List<(int Start, int Count)>(); var n = 0;
            while (n < h.Size / 8) {
                if (frames[i].AsSpan(n * 8, 8).SequenceEqual(frames[i - 1].AsSpan(n * 8, 8))) { n++; continue; }
                var start = n++; while (n < h.Size / 8 && !frames[i].AsSpan(n * 8, 8).SequenceEqual(frames[i - 1].AsSpan(n * 8, 8))) n++;
                runs.Add((start, n - start));
            }
            writer.Write((byte)(runs.Count == 0 ? 2 : 1)); Var(writer, 1);
            if (runs.Count == 0) continue;
            Var(writer, runs.Count); var end = 0;
            foreach (var run in runs) { Var(writer, run.Start - end); Var(writer, run.Count); writer.Write(frames[i], run.Start * 8, run.Count * 8); end = run.Start + run.Count; }
        }
        var encoded = output.ToArray(); field["m_Script"].AsByteArray = encoded;
        foreach (var image in images) image.HidcExpected = encoded;
    }
    static byte[] EncodeFrame(Project project, ImageResource image, Header h, byte[] original) {
        var pixels = ImageResult.FromMemory(File.ReadAllBytes(Program.Within(project.Folder, image.RenderedFile)), ColorComponents.RedGreenBlueAlpha);
        if (pixels.Width != h.Width || pixels.Height != h.Height) throw new InvalidDataException("HIDC 译图尺寸改变：" + image.Name);
        var before = Pixels(h, original); var result = (byte[])original.Clone();
        TextureOperations.FlipBGRA32Vertically(before, h.Width, h.Height); TextureOperations.FlipBGRA32Vertically(pixels.Data, h.Width, h.Height);
        var block = new byte[64];
        for (var y = 0; y < h.Height; y += 4) { project.CheckCancellation?.Invoke(); for (var x = 0; x < h.Width; x += 4) {
            var same = true;
            for (var by = 0; by < 4; by++) for (var bx = 0; bx < 4; bx++) {
                var source = (Math.Min(y + by, h.Height - 1) * h.Width + Math.Min(x + bx, h.Width - 1)) * 4;
                pixels.Data.AsSpan(source, 4).CopyTo(block.AsSpan((by * 4 + bx) * 4));
                same &= pixels.Data.AsSpan(source, 4).SequenceEqual(before.AsSpan(source, 4));
            }
            if (!same) EncodeBlock(block, result.AsSpan(((y / 4) * ((h.Width + 3) / 4) + x / 4) * 8, 8), h.Encoding);
        }}
        return result;
    }
    static void EncodeBlock(byte[] pixels, Span<byte> output, int encoding) {
        if (encoding == 1) {
            var lo = 255; var hi = 0; for (var i = 0; i < 16; i++) { lo = Math.Min(lo, pixels[i * 4]); hi = Math.Max(hi, pixels[i * 4]); }
            output[0] = (byte)hi; output[1] = (byte)lo; var palette = new int[8]; palette[0] = hi; palette[1] = lo;
            for (var i = 1; i <= 6; i++) palette[i + 1] = ((7 - i) * hi + i * lo) / 7;
            ulong indices = 0; for (var p = 0; p < 16; p++) { var best = 0; for (var i = 1; i < 8; i++) if (Math.Abs(pixels[p * 4] - palette[i]) < Math.Abs(pixels[p * 4] - palette[best])) best = i; indices |= (ulong)best << (p * 3); }
            for (var i = 0; i < 6; i++) output[i + 2] = (byte)(indices >> (8 * i)); return;
        }
        var min = new int[] { 255, 255, 255 }; var max = new int[3];
        for (var p = 0; p < 16; p++) for (var c = 0; c < 3; c++) { min[c] = Math.Min(min[c], pixels[p * 4 + c]); max[c] = Math.Max(max[c], pixels[p * 4 + c]); }
        ushort Pack(int[] c) => (ushort)(((c[0] * 31 / 255) << 11) | ((c[1] * 63 / 255) << 5) | (c[2] * 31 / 255));
        var c0 = Pack(max); var c1 = Pack(min); if (c0 <= c1) { if (c0 < 65535) c0++; else c1--; }
        BinaryPrimitives.WriteUInt16LittleEndian(output, c0); BinaryPrimitives.WriteUInt16LittleEndian(output[2..], c1);
        int[] Unpack(ushort c) => [(c >> 11) * 255 / 31, ((c >> 5) & 63) * 255 / 63, (c & 31) * 255 / 31];
        var colors = new[] { Unpack(c0), Unpack(c1), new int[3], new int[3] };
        for (var c = 0; c < 3; c++) { colors[2][c] = (2 * colors[0][c] + colors[1][c]) / 3; colors[3][c] = (colors[0][c] + 2 * colors[1][c]) / 3; }
        uint indices32 = 0;
        for (var p = 0; p < 16; p++) { var best = 0; var distance = int.MaxValue; for (var i = 0; i < 4; i++) { var d = 0; for (var c = 0; c < 3; c++) { var v = pixels[p * 4 + c] - colors[i][c]; d += v * v; } if (d < distance) { distance = d; best = i; } } indices32 |= (uint)best << (p * 2); }
        BinaryPrimitives.WriteUInt32LittleEndian(output[4..], indices32);
    }
    public static void Verify(Project project, ImageResource[] images, AssetTypeValueField field) {
        var actual = field["m_Script"].AsByteArray; var expected = images[0].HidcExpected ?? throw new InvalidDataException("缺少 HIDC 写回校验数据");
        if (!actual.AsSpan().SequenceEqual(expected)) throw new InvalidDataException("HIDC 译图重读校验失败：" + images[0].File);
        foreach (var image in images) image.HidcExpected = null;
    }
}

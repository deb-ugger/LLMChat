using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using AssetsTools.NET;
using AssetsTools.NET.Extra;
using AssetsTools.NET.Texture;
using StbImageSharp;
using StbImageWriteSharp;

namespace LLMChat.UnityOffline;

public sealed class ImageRegion
{
    public string Text { get; set; } = "";
    public string Translation { get; set; } = "";
    public double Confidence { get; set; }
    public double X0 { get; set; } public double Y0 { get; set; }
    public double X1 { get; set; } public double Y1 { get; set; }
    public bool Selected { get; set; } = true;
    public string Error { get; set; } = "";
}
public sealed class ImageResource
{
    public string Id { get; set; } = "";
    public string File { get; set; } = "";
    public string Container { get; set; } = "";
    public string ObjectId { get; set; } = "0";
    public string Kind { get; set; } = "texture";
    public string Name { get; set; } = "";
    public int Width { get; set; } public int Height { get; set; }
    public string SourceFile { get; set; } = "";
    public string SourceHash { get; set; } = "";
    public string RenderedFile { get; set; } = "";
    public string RenderedHash { get; set; } = "";
    public string DependencyFile { get; set; } = "";
    public string DependencyHash { get; set; } = "";
    public bool Selected { get; set; } = true;
    public bool OcrCompleted { get; set; }
    public bool Completed { get; set; }
    public string Error { get; set; } = "";
    public List<ImageRegion> Regions { get; set; } = [];
}

public static class ImageResources
{
    static string Id(string file, string container, string id) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(file + "\n" + container + "\n" + id))).ToLowerInvariant();
    static void Png(byte[] rgba, int width, int height, string path) {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        using var output = File.Create(path);
        new ImageWriter().WritePng(rgba, width, height, StbImageWriteSharp.ColorComponents.RedGreenBlueAlpha, output);
    }
    static void Dimensions(int width, int height) {
        if (width <= 0 || height <= 0 || (long)width * height > 64 * 1024 * 1024) throw new Exception("图片尺寸无效或超过 6400 万像素，未解码");
    }
    public static HashSet<long> FontTextures(AssetsManager manager, AssetsFileInstance instance) {
        var result = new HashSet<long>();
        foreach (var info in instance.file.Metadata.AssetInfos.Where(i => i.TypeId == 114)) {
            AssetTypeValueField field;
            try { field = manager.GetBaseField(instance, info); } catch { continue; }
            if (BitmapFontGenerator.FontKind(field) == null) continue;
            foreach (var reference in FontPreparation.References(field).Where(r => r.FileId == 0)) {
                if (!long.TryParse(reference.PathId, out var id)) continue;
                var target = instance.file.GetAssetInfo(id); if (target == null) continue;
                if (target.TypeId == 28) result.Add(id);
                if (target.TypeId != 21) continue;
                var material = manager.GetBaseField(instance, target);
                var textures = material["m_SavedProperties"]["m_TexEnvs"]["Array"];
                if (textures.IsDummy) continue;
                foreach (var entry in textures.Children.Where(e => e["first"].AsString == "_MainTex")) {
                    var pointer = entry["second"]["m_Texture"];
                    if (!pointer.IsDummy && pointer["m_FileID"].AsInt == 0) result.Add(pointer["m_PathID"].AsLong);
                }
            }
        }
        return result;
    }
    public static void ScanTexture(Project project, AssetsFileInstance instance, AssetTypeValueField field, string file, string container, long objectId, bool fontAtlas) {
        var image = new ImageResource { Id = Id(file, container, objectId.ToString()), File = file, Container = container, ObjectId = objectId.ToString(), Name = field["m_Name"].IsDummy ? objectId.ToString() : field["m_Name"].AsString };
        project.Images.Add(image);
        try {
            if (fontAtlas || Regex.IsMatch(image.Name, @"(?:font|sdf|lightmap|normalmap|_nrm(?:_|$))", RegexOptions.IgnoreCase)) throw new Exception("字库图集、法线或光照纹理不参与图片文字翻译");
            var texture = TextureFile.ReadTextureFile(field);
            image.Width = texture.m_Width; image.Height = texture.m_Height; Dimensions(image.Width, image.Height);
            if (texture.m_TextureDimension != 2 || texture.m_ImageCount != 1) throw new Exception("仅支持单张二维纹理，不处理数组或立方体纹理");
            if (texture.m_StreamData.size > 0 && !string.IsNullOrEmpty(texture.m_StreamData.path) && instance.parentBundle == null) {
                var dependency = Program.Within(project.Root, Path.GetRelativePath(project.Root, Path.GetFullPath(Path.Combine(Path.GetDirectoryName(instance.path)!, texture.m_StreamData.path))));
                image.DependencyFile = Path.GetRelativePath(project.Root, dependency); image.DependencyHash = Program.Hash(dependency);
            }
            var encoded = texture.FillPictureData(instance) ?? throw new Exception("未找到纹理的外部 resS 数据");
            var rgba = texture.DecodeTextureRaw(encoded, false) ?? throw new Exception("当前纹理压缩格式不能解码");
            TextureOperations.FlipBGRA32Vertically(rgba, image.Width, image.Height);
            image.SourceFile = "images/source/" + image.Id + ".png";
            Png(rgba, image.Width, image.Height, Program.Within(project.Folder, image.SourceFile));
            image.SourceHash = Program.Hash(Program.Within(project.Folder, image.SourceFile));
        } catch (Exception error) { image.Error = error.Message; image.Selected = false; image.SourceFile = ""; }
    }
    public static void ScanFile(Project project, string path, string relative) {
        var image = new ImageResource { Id = Id(relative, "", "0"), File = relative, Name = Path.GetFileName(path), Kind = "file" };
        project.Images.Add(image);
        try {
            using var input = File.OpenRead(path);
            var info = ImageInfo.FromStream(input) ?? throw new Exception("无法读取图片尺寸"); Dimensions(info.Width, info.Height); input.Position = 0;
            var pixels = ImageResult.FromStream(input, StbImageSharp.ColorComponents.RedGreenBlueAlpha);
            image.Width = pixels.Width; image.Height = pixels.Height; Dimensions(image.Width, image.Height);
            image.SourceFile = "images/source/" + image.Id + ".png";
            Png(pixels.Data, pixels.Width, pixels.Height, Program.Within(project.Folder, image.SourceFile));
            image.SourceHash = Program.Hash(Program.Within(project.Folder, image.SourceFile));
        } catch (Exception error) { image.Error = error.Message; image.Selected = false; image.SourceFile = ""; }
    }
    public static object SaveRendered(Request request) {
        var project = request.Project ?? throw new Exception("缺少图片工程");
        var image = project.Images.SingleOrDefault(i => i.Id == request.ImageId) ?? throw new Exception("图片不属于当前工程");
        if (!Regex.IsMatch(image.Id, "^[a-f0-9]{64}$")) throw new Exception("无效图片标识");
        if (!File.Exists(Path.Combine(project.Folder, "unity-project.json"))) throw new Exception("图片工程尚未保存");
        if (request.ImageData.Length == 0) {
            var state = Program.Within(project.Folder, "images/state/" + image.Id + ".json");
            Directory.CreateDirectory(Path.GetDirectoryName(state)!); Program.WriteJson(state, image);
            return new { path = image.RenderedFile, hash = image.RenderedHash };
        }
        if (image.SourceFile.Length == 0 || Program.Hash(Program.Within(project.Folder, image.SourceFile)) != image.SourceHash) throw new Exception("原图缓存发生变化，请重新扫描");
        var png = Convert.FromBase64String(request.ImageData); Dimensions(image.Width, image.Height);
        if (png.Length < 24 || !png.AsSpan(0, 8).SequenceEqual(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 })) throw new Exception("请使用 PNG 格式的译图");
        if (System.Buffers.Binary.BinaryPrimitives.ReadUInt32BigEndian(png.AsSpan(16, 4)) != image.Width || System.Buffers.Binary.BinaryPrimitives.ReadUInt32BigEndian(png.AsSpan(20, 4)) != image.Height) throw new Exception("译图尺寸必须与原图一致");
        var pixels = ImageResult.FromMemory(png, StbImageSharp.ColorComponents.RedGreenBlueAlpha);
        if (pixels.Width != image.Width || pixels.Height != image.Height) throw new Exception("译图尺寸必须与原图一致");
        var relative = "images/rendered/" + image.Id + ".png"; var path = Program.Within(project.Folder, relative);
        Png(pixels.Data, pixels.Width, pixels.Height, path);
        return new { path = relative, hash = Program.Hash(path) };
    }
    public static ImageResource[] Ready(Project project) {
        var selected = project.Images.Where(i => i.Selected).ToArray();
        if (!project.ImagesSkipped && selected.Any(i => !i.Completed)) throw new Exception("请完成步骤 2.2 或明确跳过未完成的图片");
        var ready = selected.Where(i => i.Completed && i.RenderedFile.Length > 0).ToArray();
        foreach (var image in ready) {
            if (Program.Hash(Program.Within(project.Folder, image.RenderedFile)) != image.RenderedHash) throw new Exception("译图缓存已变化，请重新生成译图：" + image.Name);
            if (image.DependencyFile.Length > 0 && Program.Hash(Program.Within(project.Root, image.DependencyFile)) != image.DependencyHash) throw new Exception("原图的 resS 数据已变化，请重新扫描：" + image.Name);
        }
        return ready;
    }
    public static void ApplyTexture(Project project, ImageResource image, AssetTypeValueField field) {
        var texture = TextureFile.ReadTextureFile(field);
        var rgba = TextureFile.EncodeManagedImage(Program.Within(project.Folder, image.RenderedFile), TextureFormat.RGBA32, out var width, out var height);
        if (width != texture.m_Width || height != texture.m_Height) throw new Exception("译图与游戏纹理尺寸不一致：" + image.Name);
        texture.m_TextureFormat = (int)TextureFormat.RGBA32; texture.m_MipCount = 1; texture.m_MipMap = false;
        texture.m_StreamingMipmaps = false; texture.m_StreamingMipmapsPriority = 0;
        texture.m_CompleteImageSize = rgba.Length;
        texture.m_StreamData = new TextureFile.StreamingInfo { path = "", offset = 0, size = 0 };
        texture.SetPictureData(rgba, width, height);
        texture.WriteTo(field);
    }
    public static void ApplyFile(Project project, ImageResource image, string destination) {
        var png = File.ReadAllBytes(Program.Within(project.Folder, image.RenderedFile));
        if (Path.GetExtension(image.File).Equals(".png", StringComparison.OrdinalIgnoreCase)) { File.WriteAllBytes(destination, png); return; }
        var decoded = ImageResult.FromMemory(png, StbImageSharp.ColorComponents.RedGreenBlueAlpha);
        using var output = File.Create(destination);
        new ImageWriter().WriteJpg(decoded.Data, decoded.Width, decoded.Height, StbImageWriteSharp.ColorComponents.RedGreenBlueAlpha, output, 95);
    }
    public static void VerifyTexture(Project project, ImageResource image, AssetTypeValueField field) {
        var texture = TextureFile.ReadTextureFile(field);
        var raw = texture.DecodeTextureRaw(texture.pictureData, false);
        var expected = ImageResult.FromMemory(File.ReadAllBytes(Program.Within(project.Folder, image.RenderedFile)), StbImageSharp.ColorComponents.RedGreenBlueAlpha);
        TextureOperations.FlipBGRA32Vertically(expected.Data, expected.Width, expected.Height);
        if (texture.m_Width != image.Width || texture.m_Height != image.Height || raw == null || !raw.SequenceEqual(expected.Data)) throw new Exception("译图重读像素校验失败：" + image.Name);
    }
    public static void Reset(Project project) {
        foreach (var image in project.Images) {
            if (Regex.IsMatch(image.Id, "^[a-f0-9]{64}$")) {
                foreach (var relative in new[] { "images/rendered/" + image.Id + ".png", "images/state/" + image.Id + ".json" }) { var path = Program.Within(project.Folder, relative); if (File.Exists(path)) File.Delete(path); }
            }
            image.RenderedFile = ""; image.RenderedHash = ""; image.OcrCompleted = false; image.Completed = false; image.Regions.Clear();
            if (image.SourceFile.Length > 0) image.Error = "";
        }
        project.ImagesSkipped = false;
    }
    public static void LoadStates(Project project, DateTime projectTime) {
        for (var index = 0; index < project.Images.Count; index++) {
            var image = project.Images[index];
            if (!Regex.IsMatch(image.Id, "^[a-f0-9]{64}$")) continue;
            var path = Program.Within(project.Folder, "images/state/" + image.Id + ".json");
            if (!File.Exists(path) || File.GetLastWriteTimeUtc(path) <= projectTime) continue;
            var saved = System.Text.Json.JsonSerializer.Deserialize<ImageResource>(File.ReadAllText(path), Program.Json) ?? throw new Exception("图片进度文件为空：" + image.Name);
            if (saved.Id != image.Id || saved.File != image.File || saved.Container != image.Container || saved.ObjectId != image.ObjectId || saved.SourceHash != image.SourceHash)
                throw new Exception("图片检查点与原图不一致，请重新扫描：" + image.Name);
            project.Images[index] = saved;
        }
    }
    public static void CommitStates(Project project) {
        foreach (var image in project.Images) if (Regex.IsMatch(image.Id, "^[a-f0-9]{64}$")) {
            var path = Program.Within(project.Folder, "images/state/" + image.Id + ".json"); if (File.Exists(path)) File.Delete(path);
        }
    }
    public static int Reuse(Project previous, Project scanned) {
        var prior = previous.Images.Where(i => i.SourceFile.Length > 0).ToDictionary(i => (i.File, i.Container, i.ObjectId, i.SourceHash));
        var count = 0;
        foreach (var image in scanned.Images.Where(i => i.SourceFile.Length > 0)) {
            if (!prior.TryGetValue((image.File, image.Container, image.ObjectId, image.SourceHash), out var saved)) continue;
            image.Selected = saved.Selected; image.OcrCompleted = saved.OcrCompleted; image.Completed = saved.Completed; image.Error = saved.Error;
            image.Regions = saved.Regions;
            if (saved.RenderedFile.Length > 0) {
                var source = Program.Within(previous.Folder, saved.RenderedFile);
                if (File.Exists(source) && Program.Hash(source) == saved.RenderedHash) {
                    image.RenderedFile = "images/rendered/" + image.Id + ".png";
                    var target = Program.Within(scanned.Folder, image.RenderedFile); Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                    File.Copy(source, target, true); image.RenderedHash = saved.RenderedHash;
                } else {
                    image.Completed = false;
                    image.Error = "旧译图缺失或校验失败，已保留识别和翻译结果，可重新生成译图";
                }
            }
            if (image.OcrCompleted || image.Regions.Count > 0 || image.Completed) count++;
        }
        return count;
    }
}

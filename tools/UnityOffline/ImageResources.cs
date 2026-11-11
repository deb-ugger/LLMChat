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
    public bool ManualSelected { get; set; }
    public string ReviewReason { get; set; } = "";
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
    public string RenderedKind {get;set;} = "";
    public string DependencyFile { get; set; } = "";
    public string DependencyHash { get; set; } = "";
    public bool Selected { get; set; } = true;
    public bool OcrCompleted { get; set; }
    public bool Completed { get; set; }
    public string Error { get; set; } = "";
    public List<ImageRegion> Regions { get; set; } = [];
}

public sealed record ImageCacheCleanup(int Removed,List<string> Errors);

public static class ImageResources
{
    public sealed class TextureScanCache
    {
        public sealed class Index
        {
            public string Root { get; set; } = "";
            public Dictionary<string, string> Hashes { get; set; } = [];
            public List<ImageResource> Images { get; set; } = [];
        }
        readonly string folder;
        readonly Index index;
        readonly Dictionary<string, ImageResource> images;
        readonly Dictionary<string, bool> files = new(StringComparer.OrdinalIgnoreCase);
        public int Hits { get; private set; }
        public TextureScanCache(string root, string previousFolder)
        {
            folder = Path.GetFullPath(previousFolder);
            var projects = Path.GetFullPath(Path.Combine(GameWorkspace.WorkRoot(root), "projects")) + Path.DirectorySeparatorChar;
            if (!folder.StartsWith(projects, StringComparison.OrdinalIgnoreCase)) throw new Exception("原图复用目录不属于游戏工程");
            using var input = File.OpenRead(Path.Combine(folder, "unity-project.json"));
            index = System.Text.Json.JsonSerializer.Deserialize<Index>(input, Program.Json) ?? throw new Exception("原图缓存索引无效");
            if (!Path.GetFullPath(index.Root).Equals(Path.GetFullPath(root), StringComparison.OrdinalIgnoreCase)) throw new Exception("原图缓存属于其他游戏");
            images = index.Images.Where(image => image.SourceFile.Length > 0).ToDictionary(image => image.Id);
        }
        public bool Copy(Project project, ImageResource image)
        {
            if (!images.TryGetValue(image.Id, out var saved) || saved.Width != image.Width || saved.Height != image.Height || saved.DependencyHash != image.DependencyHash) return false;
            if (!files.TryGetValue(image.File, out var unchanged)) {
                unchanged = index.Hashes.TryGetValue(image.File, out var hash) && Program.Hash(Program.Within(project.Root, image.File)) == hash;
                files[image.File] = unchanged;
            }
            if (!unchanged) return false;
            var source = Program.Within(folder, saved.SourceFile);
            if (!File.Exists(source) || Program.Hash(source) != saved.SourceHash) return false;
            var relative = "images/source/" + image.Id + ".png";
            var target = Program.Within(project.Folder, relative);
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            File.Copy(source, target, true);
            image.SourceFile = relative; image.SourceHash = saved.SourceHash;
            Hits++;
            return true;
        }
    }
    public static object Preview(Request request) {
        Program.CheckStop(request, "");
        var project = request.Project ?? Program.Load(Path.Combine(request.Path, "unity-project.json"));
        if(request.Thumbnail&&string.IsNullOrEmpty(request.ImageId)){
            if(project.Images.Count>8)throw new Exception("单次缩略图请求不能超过 8 张");
            return new { images=project.Images.Select(item=>{
                try{return (object)new {id=item.Id,preview=Preview(new Request {Project=new Project {Folder=project.Folder,Images=[item]},ImageId=item.Id,Thumbnail=true,StopFile=request.StopFile})};}
                catch(Exception error){return new {id=item.Id,error=error.Message};}
            }).ToArray()};
        }
        var image = project.Images.SingleOrDefault(i => i.Id == request.ImageId) ?? throw new Exception("图片不属于当前工程");
        if (image.SourceFile.Length == 0) throw new Exception("没有可读取的原图");
        var source=Program.Within(project.Folder,image.SourceFile);
        var info=new FileInfo(source);
        var cacheKey=Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes("thumb-v1|"+image.Id+"|"+image.SourceHash+"|"+info.Length+"|"+info.LastWriteTimeUtc.Ticks)));
        var cache=Program.Within(project.Folder,Path.Combine("preview-cache",cacheKey+".png"));var opaqueCache=cache+".opaque.png";
        if(request.Thumbnail&&File.Exists(cache))return new {data=Convert.ToBase64String(File.ReadAllBytes(cache)),opaque=File.Exists(opaqueCache)?Convert.ToBase64String(File.ReadAllBytes(opaqueCache)):"",fullyTransparent=File.Exists(opaqueCache)};
        var bytes = File.ReadAllBytes(source);
        var pixels = ImageResult.FromMemory(bytes, StbImageSharp.ColorComponents.RedGreenBlueAlpha);
        Program.CheckStop(request, "");
        var fullyTransparent = true;
        for (var i = 3; i < pixels.Data.Length; i += 4) if (pixels.Data[i] != 0) { fullyTransparent = false; break; }
        var rgba = pixels.Data; var width = pixels.Width; var height = pixels.Height;
        if (request.Thumbnail && Math.Max(width, height) > 256) {
            var scale = 256d / Math.Max(width, height); var w = Math.Max(1, (int)Math.Round(width * scale)); var h = Math.Max(1, (int)Math.Round(height * scale));
            var resized = new byte[w * h * 4];
            for (var y = 0; y < h; y++) { Program.CheckStop(request, ""); for (var x = 0; x < w; x++) Array.Copy(rgba, ((y * height / h) * width + x * width / w) * 4, resized, (y * w + x) * 4, 4); }
            rgba = resized; width = w; height = h;
            using var thumbnail = new MemoryStream(); new ImageWriter().WritePng(rgba, width, height, StbImageWriteSharp.ColorComponents.RedGreenBlueAlpha, thumbnail); bytes = thumbnail.ToArray();
        }
        var opaque = "";
        if (fullyTransparent) {
            for (var i = 3; i < rgba.Length; i += 4) rgba[i] = 255;
            using var output = new MemoryStream();
            new ImageWriter().WritePng(rgba, width, height, StbImageWriteSharp.ColorComponents.RedGreenBlueAlpha, output);
            var opaqueBytes=output.ToArray();opaque = Convert.ToBase64String(opaqueBytes);
            if(request.Thumbnail){Directory.CreateDirectory(Path.GetDirectoryName(cache)!);File.WriteAllBytes(opaqueCache,opaqueBytes);}
        }
        if(request.Thumbnail){Directory.CreateDirectory(Path.GetDirectoryName(cache)!);File.WriteAllBytes(cache,bytes);}
        return new { data = Convert.ToBase64String(bytes), opaque, fullyTransparent };
    }
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
    public static void ScanTexture(Project project, AssetsFileInstance instance, AssetTypeValueField field, string file, string container, long objectId, bool fontAtlas, Dictionary<string, string> dependencyHashes, TextureScanCache? cache) {
        var image = new ImageResource { Id = Id(file, container, objectId.ToString()), File = file, Container = container, ObjectId = objectId.ToString(), Name = field["m_Name"].IsDummy ? objectId.ToString() : field["m_Name"].AsString };
        if (fontAtlas || Regex.IsMatch(image.Name, @"(?:font|sdf|lightmap|normalmap|_nrm(?:_|$))", RegexOptions.IgnoreCase)) return;
        project.Images.Add(image);
        try {
            var texture = TextureFile.ReadTextureFile(field);
            image.Width = texture.m_Width; image.Height = texture.m_Height; Dimensions(image.Width, image.Height);
            if (texture.m_TextureDimension != 2 || texture.m_ImageCount != 1) { project.Images.Remove(image); return; }
            if (texture.m_StreamData.size > 0 && !string.IsNullOrEmpty(texture.m_StreamData.path) && instance.parentBundle == null) {
                var dependency = Program.Within(project.Root, Path.GetRelativePath(project.Root, Path.GetFullPath(Path.Combine(Path.GetDirectoryName(instance.path)!, texture.m_StreamData.path))));
                image.DependencyFile = Path.GetRelativePath(project.Root, dependency);
                // Hundreds of textures can share a multi-gigabyte resS file.
                // Keep only its digest, scoped to this resource scan, never the file bytes.
                if (!dependencyHashes.TryGetValue(dependency, out var hash)) dependencyHashes[dependency] = hash = Program.Hash(dependency);
                image.DependencyHash = hash;
            }
            if (instance.parentBundle == null && cache?.Copy(project, image) == true) return;
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
        if(request.CleanImageCache)return CleanupCache(project);
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
        var revision=Convert.ToHexString(SHA256.HashData(png)).ToLowerInvariant();
        var relative = "images/rendered/" + image.Id + "-" + revision + ".png"; var path = Program.Within(project.Folder, relative);
        Png(pixels.Data, pixels.Width, pixels.Height, path);
        var cleanup=CleanupDraft(project,image,relative,request.SavedRenderedFile);
        return new { path = relative, hash = Program.Hash(path),cacheErrors=cleanup.Errors };
    }
    public static ImageCacheCleanup CleanupCache(Project project)=>SweepRendered(project,project.Images.Select(image=>image.RenderedFile).Where(path=>path.Length>0),null);
    static ImageCacheCleanup CleanupDraft(Project project,ImageResource image,string path,string? savedRenderedFile){
        // The UI owns the unsaved draft baseline; background saves must not replace it.
        if(savedRenderedFile==null)return new(0,[]);
        var keep=new List<string>{path};if(savedRenderedFile.Length>0)keep.Add(savedRenderedFile);
        return SweepRendered(project,keep,image.Id);
    }
    static ImageCacheCleanup SweepRendered(Project project,IEnumerable<string> keep,string? imageId){
        int removed=0;var errors=new List<string>();
        try {
            if(!File.Exists(Program.Within(project.Folder,"unity-project.json")))throw new Exception("图片工程尚未保存");
            var images=Program.Within(project.Folder,"images");var folder=Program.Within(project.Folder,"images/rendered");
            if(!Directory.Exists(folder))return new(0,errors);
            if((File.GetAttributes(images)&FileAttributes.ReparsePoint)!=0||(File.GetAttributes(folder)&FileAttributes.ReparsePoint)!=0)throw new Exception("不清理目录联接或符号链接中的缓存");
            var retained=keep.Select(path=>Program.Within(project.Folder,path)).ToHashSet(StringComparer.OrdinalIgnoreCase);
            foreach(var file in Directory.EnumerateFiles(folder,"*.png",SearchOption.TopDirectoryOnly)){
                var name=Path.GetFileName(file);
                if(!Regex.IsMatch(name,"^[a-f0-9]{64}(-[a-f0-9]{64})?\\.png$")||retained.Contains(Path.GetFullPath(file)))continue;
                if(imageId!=null&&name!=imageId+".png"&&!name.StartsWith(imageId+"-",StringComparison.Ordinal))continue;
                try{if((File.GetAttributes(file)&FileAttributes.ReparsePoint)!=0)continue;File.Delete(file);removed++;}
                catch(Exception error){errors.Add(name+"："+error.Message);}
            }
        }catch(Exception error){errors.Add(error.Message);}
        return new(removed,errors);
    }
    public static ImageResource[] Ready(Project project) {
        var selected = project.Images.Where(i => i.Selected).ToArray();
        if (!project.ImagesSkipped && selected.Any(i => !i.Completed && i.Error.Length == 0 && !i.Regions.Any(r => r.Error.Length > 0))) throw new Exception("请完成步骤 2.2 或明确跳过未完成的图片");
        var ready = selected.Where(i => i.Completed && i.Error.Length == 0 && !i.Regions.Any(r => r.Error.Length > 0) && i.RenderedFile.Length > 0).ToArray();
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
                    File.Copy(source, target, true); image.RenderedHash = saved.RenderedHash;image.RenderedKind=saved.RenderedKind;
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

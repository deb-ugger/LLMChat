using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using StbImageSharp;

namespace LLMChat.UnityOffline;

internal static class UnityMosaic
{
    internal sealed record Candidate(string Source, string Hash, bool Included);

    static string Store(string root)
    {
        var folder = Path.Combine(GameWorkspace.Ensure(root), "mosaic");
        if (Directory.Exists(folder) && (File.GetAttributes(folder) & FileAttributes.ReparsePoint) != 0)
            throw new IOException("去码目录不能使用目录联接或符号链接");
        return folder;
    }

    static Dictionary<string, Candidate> ReadIndex(string folder)
    {
        var index = Path.Combine(folder, "index.json");
        if (!File.Exists(index)) return [];
        using var input = File.OpenRead(index);
        return JsonSerializer.Deserialize<Dictionary<string, Candidate>>(input, Program.Json)
            ?? throw new InvalidDataException("去码图片索引无效");
    }

    static void EditIndex(string folder, Action<Dictionary<string, Candidate>> change)
    {
        Directory.CreateDirectory(folder);
        var key = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(Path.GetFullPath(folder).ToUpperInvariant())));
        using var mutex = new Mutex(false, "LLMChat-Unity-Mosaic-" + key);
        try { if (!mutex.WaitOne(TimeSpan.FromSeconds(5))) throw new IOException("另一个任务正在更新去码图片"); }
        catch (AbandonedMutexException) { }
        try {
            var index = ReadIndex(folder);
            change(index);
            Program.WriteJson(Path.Combine(folder, "index.json"), index);
        } finally { mutex.ReleaseMutex(); }
    }

    static bool HashId(string value) => Regex.IsMatch(value, "^[0-9a-fA-F]{64}$", RegexOptions.CultureInvariant);

    static string CandidatePath(string folder, string id, string hash)
    {
        if (!HashId(id) || !HashId(hash)) throw new InvalidDataException("去码图片标识无效");
        return Program.Within(folder, id + "-" + hash + ".png");
    }

    static Project ProjectFor(Request request)
    {
        if (!GameWorkspace.IsProjectsRoot(request.Root, Path.GetDirectoryName(Path.GetFullPath(request.Path))!))
            throw new InvalidDataException("去码图片工程不属于当前游戏");
        var project = Program.Load(Path.Combine(request.Path, "unity-project.json"));
        if (!Path.GetFullPath(project.Root).Equals(Path.GetFullPath(request.Root), StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("去码图片工程不属于当前游戏");
        return project;
    }

    static ImageResource Find(Project project, string id) => project.Images.SingleOrDefault(image =>
        image.Id == id && image.SourceFile.Length > 0 && image.Width > 0 && image.Height > 0)
        ?? throw new InvalidDataException("找不到当前工程的原图");

    static Candidate Match(Dictionary<string, Candidate> index, ImageResource image) =>
        index.TryGetValue(image.Id, out var item) && item.Source == image.SourceHash
            ? item : throw new InvalidDataException("原图已变化或没有已确认的去码图：" + image.Name);

    static byte[] ReadCandidate(string folder, ImageResource image, Candidate item)
    {
        var path = CandidatePath(folder, image.Id, item.Hash);
        if (!File.Exists(path)) throw new IOException("已确认的去码图缺失：" + image.Name);
        var bytes = File.ReadAllBytes(path);
        if (Convert.ToHexString(SHA256.HashData(bytes)) != item.Hash)
            throw new InvalidDataException("去码图校验失败：" + image.Name);
        return bytes;
    }

    static ImageResult Decode(byte[] bytes, ImageResource image)
    {
        using var input = new MemoryStream(bytes, writable: false);
        var info = ImageInfo.FromStream(input) ?? throw new InvalidDataException("无法读取去码图片");
        if (info.Width != image.Width || info.Height != image.Height)
            throw new InvalidDataException("去码图、译图和原图的尺寸必须一致：" + image.Name);
        return ImageResult.FromMemory(bytes, ColorComponents.RedGreenBlueAlpha);
    }

    internal static object Status(Request request)
    {
        var folder = GameWorkspace.WorkRoot(request.Root);
        if (!File.Exists(Path.Combine(folder, "workspace.json"))) return new { candidates = new Dictionary<string, Candidate>() };
        return new { candidates = ReadIndex(Store(request.Root)) };
    }

    internal static object Preview(Request request)
    {
        var image = Find(ProjectFor(request), request.ImageId);
        var folder = Store(request.Root);
        return new { data = Convert.ToBase64String(ReadCandidate(folder, image, Match(ReadIndex(folder), image))) };
    }

    internal static object Save(Request request)
    {
        var image = Find(ProjectFor(request), request.ImageId);
        if (image.SourceHash != request.ImageSourceHash) throw new InvalidDataException("原图已变化，请重新确认");
        var bytes = Convert.FromBase64String(request.ImageData);
        if (bytes.Length < 24 || !bytes.AsSpan(0, 8).SequenceEqual(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 }))
            throw new InvalidDataException("去码候选必须是 PNG");
        Decode(bytes, image);
        var folder = Store(request.Root);
        var hash = Convert.ToHexString(SHA256.HashData(bytes));
        EditIndex(folder, index => {
            var path = CandidatePath(folder, image.Id, hash);
            var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try { File.WriteAllBytes(temporary, bytes); File.Move(temporary, path, true); }
            finally { if (File.Exists(temporary)) File.Delete(temporary); }
            index[image.Id] = new(image.SourceHash, hash,
                index.TryGetValue(image.Id, out var previous) && previous.Source == image.SourceHash && previous.Included);
        });
        return Status(request);
    }

    internal static object Select(Request request)
    {
        var project = ProjectFor(request);
        var folder = Store(request.Root);
        var ids = request.SelectedIds ?? throw new InvalidDataException("缺少去码图片选择");
        var images = project.Images.ToDictionary(image => image.Id);
        EditIndex(folder, index => {
            foreach (var id in ids.Distinct()) {
                if (!images.TryGetValue(id, out var image)) throw new InvalidDataException("图片不属于当前工程");
                var item = Match(index, image);
                index[id] = item with { Included = request.IncludeMosaic };
            }
        });
        return Status(request);
    }

    internal static void ClearProcessingResults(string root)
    {
        if (!Directory.Exists(Path.Combine(GameWorkspace.WorkRoot(root), "mosaic"))) return;
        var folder = Store(root);
        EditIndex(folder, index => {
            foreach (var path in Directory.EnumerateFiles(folder, "*.png")) {
                if (Regex.IsMatch(Path.GetFileName(path), "^[a-f0-9]{64}-[0-9A-F]{64}\\.png$", RegexOptions.CultureInvariant))
                    File.Delete(path);
            }
            index.Clear();
        });
    }

    internal static Dictionary<string, Candidate> Included(Project project)
    {
        var root = GameWorkspace.WorkRoot(project.Root);
        if (!Directory.Exists(Path.Combine(root, "mosaic"))) return [];
        var index = ReadIndex(Store(project.Root));
        return project.Images.Where(image => image.SourceFile.Length > 0 && index.TryGetValue(image.Id, out var item) &&
                item.Included && item.Source == image.SourceHash)
            .ToDictionary(image => image.Id, image => index[image.Id]);
    }

    internal static ImageResource[] Prepare(Project project, ImageResource[] translations,
        Dictionary<string, Candidate> candidates, Action checkStop)
    {
        if (candidates.Count == 0) return translations;
        var folder = Store(project.Root);
        var images = translations.ToDictionary(image => image.Id);
        foreach (var image in project.Images) {
            if (!candidates.TryGetValue(image.Id, out var candidate)) continue;
            checkStop();
            var bytes = ReadCandidate(folder, image, candidate);
            var relative = "images/mosaic-export/" + image.Id + ".png";
            var output = Program.Within(project.Folder, relative);
            Directory.CreateDirectory(Path.GetDirectoryName(output)!);
            string hash;
            if (images.TryGetValue(image.Id, out var translated)) {
                HidcImages.EnsureSource(project, image);
                var sourcePath = Program.Within(project.Folder, image.SourceFile);
                if (image.Kind != "hidc" && Program.Hash(sourcePath) != image.SourceHash)
                    throw new InvalidDataException("原图缓存已变化，请重新扫描：" + image.Name);
                var source = Decode(File.ReadAllBytes(sourcePath), image).Data;
                var text = Decode(File.ReadAllBytes(Program.Within(project.Folder, translated.RenderedFile)), image).Data;
                var result = Decode(bytes, image).Data;
                for (var offset = 0; offset < result.Length; offset += 4) {
                    if (source[offset + 3] == 0 && text[offset + 3] == 0) continue;
                    var changes = text.AsSpan(offset, 4);
                    if (!changes.SequenceEqual(source.AsSpan(offset, 4))) changes.CopyTo(result.AsSpan(offset, 4));
                }
                hash = ImageResources.Png(result, image.Width, image.Height, output);
            } else {
                File.WriteAllBytes(output, bytes);
                hash = candidate.Hash;
            }
            images[image.Id] = image.ForMosaicExport(relative, hash);
        }
        return images.Values.ToArray();
    }
}

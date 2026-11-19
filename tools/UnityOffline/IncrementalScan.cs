using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json;

namespace LLMChat.UnityOffline;

public sealed record ScanMetrics(int Parsed, int Reused, double TotalMs, double PrepareMs, double CheckMs,
    double OpenMs, double ParseMs, double DecodeMs, double ReuseMs, double SaveMs, double RestoreMs = 0, double OtherMs = 0)
{
    internal const string FileName = "scan-performance.json";
}

internal enum ScanPhase { Prepare, Check, Open, Parse, Decode, Reuse, Save, Other }

internal sealed class ScanClock
{
    readonly double[] elapsed = new double[8];
    ScanPhase phase = ScanPhase.Prepare;
    long changed = Stopwatch.GetTimestamp();
    public int Parsed { get; set; }
    public int Reused { get; set; }

    internal void Set(ScanPhase next)
    {
        var now = Stopwatch.GetTimestamp();
        elapsed[(int)phase] += Stopwatch.GetElapsedTime(changed, now).TotalMilliseconds;
        changed = now;
        phase = next;
    }

    internal Scope Measure(ScanPhase next)
    {
        var previous = phase;
        Set(next);
        return new Scope(this, previous);
    }

    internal readonly struct Scope(ScanClock? clock, ScanPhase previous) : IDisposable
    {
        public void Dispose() => clock?.Set(previous);
    }

    internal ScanMetrics Snapshot(ScanMetrics? prior = null)
    {
        Set(phase);
        return new(Parsed + (prior?.Parsed ?? 0), Reused + (prior?.Reused ?? 0), elapsed.Sum() + (prior?.TotalMs ?? 0),
            elapsed[0] + (prior?.PrepareMs ?? 0), elapsed[1] + (prior?.CheckMs ?? 0),
            elapsed[2] + (prior?.OpenMs ?? 0), elapsed[3] + (prior?.ParseMs ?? 0),
            elapsed[4] + (prior?.DecodeMs ?? 0), elapsed[5] + (prior?.ReuseMs ?? 0),
            elapsed[6] + (prior?.SaveMs ?? 0), OtherMs: elapsed[7] + (prior?.OtherMs ?? 0));
    }
}

internal sealed class IncrementalScan(Project project, string[] paths, Dictionary<string, string> originals, ScanClock clock, string reuseFolder)
{
    const int Revision = 1;
    internal sealed record Source(string Hash, string[] DependencyNames, string Dependencies, bool Asset);
    internal sealed record Index(int Revision, int ScanRevision, int SafetyRevision, string TextMode, string Model,
        string AssetContext, bool Complete, Dictionary<string, Source> Sources);

    readonly string file = Path.Combine(project.Folder, "scan-index.json");
    readonly Dictionary<string, string> digests = new(StringComparer.OrdinalIgnoreCase);
    readonly ILookup<string, string> byName = paths.ToLookup(path => Path.GetFileName(path), StringComparer.OrdinalIgnoreCase);
    readonly Lazy<string> model = new(() => project.TextMode == "smart" && File.Exists(Path.Combine(AppContext.BaseDirectory, "wtp-model.onnx"))
        ? Program.Hash(Path.Combine(AppContext.BaseDirectory, "wtp-model.onnx")) : "");
    string assetContext = "";
    Index? previous;
    ILookup<string, Entry>? entries;
    ILookup<string, FontInfo>? fonts;
    ILookup<string, ImageResource>? images;
    Dictionary<string, ResourceResult>? resources;
    Project? old;
    internal Dictionary<string, Source> Sources { get; private set; } = new(StringComparer.OrdinalIgnoreCase);

    static Index? Read(string path)
    {
        if (!File.Exists(path)) return null;
        using var input = File.OpenRead(path);
        return JsonSerializer.Deserialize<Index>(input, Program.Json);
    }

    internal void Prepare(bool resume, int next)
    {
        using var time = clock.Measure(ScanPhase.Check);
        var types = paths.Where(path => string.Equals(Path.GetFileName(Path.GetDirectoryName(path)), "Managed", StringComparison.OrdinalIgnoreCase) &&
            Path.GetExtension(path).Equals(".dll", StringComparison.OrdinalIgnoreCase));
        var context = types.Select(path => (Path.GetRelativePath(project.Root, path), Digest(path))).ToList();
        var release = Path.Combine(project.Root, "release-manifest.json");
        var classData = Path.Combine(AppContext.BaseDirectory, "classdata.tpk");
        if (File.Exists(release)) context.Add(("release-manifest.json", Digest(release)));
        if (File.Exists(classData)) context.Add(("classdata.tpk", Digest(classData)));
        context.AddRange(project.DefinitionHashes.Select(pair => ("type:" + pair.Key, pair.Value)));
        assetContext = Signature(context);

        if (resume && Read(file) is { } partial)
        {
            if (!Compatible(partial) || partial.AssetContext != assetContext)
                throw new InvalidDataException("资源解析环境发生变化，请重新扫描");
            var completed = paths.Take(next).Select(path => Path.GetRelativePath(project.Root, path)).ToHashSet(StringComparer.OrdinalIgnoreCase);
            foreach (var (relative, source) in partial.Sources)
            {
                if (!completed.Contains(relative)) continue;
                var path = Program.Within(project.Root, relative);
                if (!Matches(source, relative, originals.GetValueOrDefault(relative) ?? path))
                    throw new InvalidDataException("已扫描文件或依赖发生变化，请重新扫描：" + relative);
                Sources.Add(relative, source);
            }
        }

        if (reuseFolder.Length == 0) return;
        var reuse = Read(Path.Combine(reuseFolder, "scan-index.json"));
        if (reuse == null || !reuse.Complete || !Compatible(reuse)) return;
        using var restore = clock.Measure(ScanPhase.Reuse);
        old = Program.Load(Path.Combine(reuseFolder, "unity-project.json"));
        if (!Path.GetFullPath(old.Root).Equals(project.Root, StringComparison.OrdinalIgnoreCase)) return;
        previous = reuse;
        entries = old.Entries.ToLookup(e => e.File, StringComparer.OrdinalIgnoreCase);
        fonts = old.Fonts.ToLookup(f => f.File, StringComparer.OrdinalIgnoreCase);
        images = old.Images.ToLookup(i => i.File, StringComparer.OrdinalIgnoreCase);
        resources = old.Resources.ToDictionary(r => r.File, StringComparer.OrdinalIgnoreCase);
        project.NextEntryId = Math.Max(project.NextEntryId, old.NextEntryId);
    }

    bool Compatible(Index index) => index.Revision == Revision && index.ScanRevision == Program.CurrentScanRevision &&
        index.SafetyRevision == GameText.SafetyRevision && index.TextMode == project.TextMode && index.Model == model.Value;

    static string Signature(IEnumerable<(string Path, string Hash)> files) =>
        Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(files.OrderBy(pair => pair.Path, StringComparer.OrdinalIgnoreCase)
            .ThenBy(pair => pair.Path, StringComparer.Ordinal).Select(pair => new[] { pair.Path, pair.Hash }))));

    string Digest(string path)
    {
        if (!digests.TryGetValue(path, out var hash)) digests[path] = hash = Program.Hash(path);
        return hash;
    }

    internal string Hash(string path)
    {
        using var time = clock.Measure(ScanPhase.Check);
        return Digest(path);
    }

    static string DependencyName(string path) => Path.GetFileName(path.Replace('\\', '/'));

    string Dependencies(string relative, string[] names) => Signature(names.SelectMany(name => byName[name])
        .Distinct(StringComparer.OrdinalIgnoreCase).Where(path => !Path.GetRelativePath(project.Root, path).Equals(relative, StringComparison.OrdinalIgnoreCase))
        .Select(path => (Path.GetRelativePath(project.Root, path), File.Exists(path) ? Digest(path) : "")));

    bool Matches(Source source, string relative, string path) =>
        File.Exists(path) && Digest(path) == source.Hash && Dependencies(relative, source.DependencyNames) == source.Dependencies;

    internal void Remember(string relative, string hash, bool asset, IEnumerable<string> externals)
    {
        using var time = clock.Measure(ScanPhase.Check);
        var names = externals.Select(DependencyName).Where(name => name.Length > 0)
            .Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        Sources[relative] = new(hash, names, Dependencies(relative, names), asset);
    }

    internal bool TryReuse(string relative, string path, string hash, Action checkStop)
    {
        if (previous == null || !previous.Sources.TryGetValue(relative, out var source) ||
            source.Hash != hash || source.Asset && previous.AssetContext != assetContext ||
            !resources!.TryGetValue(relative, out var result)) return false;
        using (clock.Measure(ScanPhase.Check))
            if (!Matches(source, relative, path)) return false;
        using var time = clock.Measure(ScanPhase.Reuse);
        var found = images![relative].ToArray();
        var copies = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var image in found)
        {
            checkStop();
            if (image.SourceFile.Length == 0) return false;
            var cached = image.Kind == "hidc" ? image.HidcPayload : image.SourceFile;
            if (cached.Length == 0) return false;
            var location = Program.Within(old!.Folder, cached);
            var expected = image.Kind == "hidc" ? Path.GetFileNameWithoutExtension(cached) : image.SourceHash;
            if (!File.Exists(location) || !Digest(location).Equals(expected, StringComparison.OrdinalIgnoreCase)) return false;
            copies[cached] = location;
        }
        foreach (var (name, location) in copies)
        {
            checkStop();
            var output = Program.Within(project.Folder, name);
            Directory.CreateDirectory(Path.GetDirectoryName(output)!);
            File.Copy(location, output, true);
        }
        foreach (var entry in entries![relative])
        {
            if (entry.ParentId is { } parent && old!.SegmentSources.TryGetValue(parent, out var text)) project.SegmentSources[parent] = text;
            project.Entries.Add(entry with { Translation = "", TranslationTarget = null, LayoutDraft = null, LayoutDraftTarget = null, ScreeningDraft = null, Error = "", Selected = true });
        }
        project.Fonts.AddRange(fonts![relative]);
        project.Images.AddRange(found.Select(image => new ImageResource {
            Id = image.Id, File = image.File, Container = image.Container, ObjectId = image.ObjectId, Kind = image.Kind,
            HidcFrame = image.HidcFrame, HidcPayload = image.HidcPayload, Name = image.Name, Width = image.Width, Height = image.Height,
            SourceFile = image.SourceFile, SourceHash = image.SourceHash, DependencyFile = image.DependencyFile, DependencyHash = image.DependencyHash
        }));
        if (old!.Hashes.ContainsKey(relative)) project.Hashes[relative] = hash;
        project.Resources.Add(result);
        Sources[relative] = source;
        return true;
    }

    internal void Save(bool complete = false)
    {
        Program.WriteJson(file, new Index(Revision, Program.CurrentScanRevision, GameText.SafetyRevision,
            project.TextMode, model.Value, assetContext, complete, Sources));
    }
}

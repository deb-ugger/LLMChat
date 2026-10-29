using System.Text;
using System.Text.RegularExpressions;
using Microsoft.ML.OnnxRuntime;
using Microsoft.ML.OnnxRuntime.Tensors;

namespace LLMChat.UnityOffline;

/// <summary>Only classifies existing line boundaries inside one original field.</summary>
public sealed class SmartTextSegments(string modelPath, Action checkStop, Action<string>? report = null) : IDisposable
{
    InferenceSession? session;
    public int InferenceRuns { get; private set; }
    readonly Dictionary<string, (int Start, int Length)[]> cache = [];
    static readonly int[] Primes = [31, 43, 59, 61, 73, 97, 103, 113];
    static readonly Regex ListStart = new(@"^\s*(?:[0-9０-９]{1,3}[.．、)）]|[①-⑳・•●■□◆◇*]|[-–—]\s)");
    static bool Cjk(char c) => c is >= '\u3000' and <= '\u9fff' or >= '\uac00' and <= '\ud7af' or >= '\uff00' and <= '\uffef';

    Dictionary<int, double> Predict(string text, HashSet<int> boundaries, string context)
    {
        if (session == null) {
            if (!File.Exists(modelPath)) throw new Exception("缺少扫描分段模型，请准备 WtP 模型资源后重试");
            report?.Invoke("加载分段模型：" + context);
            using var options = new SessionOptions { IntraOpNumThreads = 1, InterOpNumThreads = 1 };
            session = new InferenceSession(modelPath, options);
        }
        var runes = text.EnumerateRunes().ToArray();
        var needed = new Dictionary<int, int>(); var offset = 0;
        for (var i = 0; i < runes.Length; i++) { offset += runes[i].Utf16SequenceLength; if (boundaries.Contains(offset)) needed[i] = offset; }
        var sums = new Dictionary<int, double>(); var counts = new Dictionary<int, int>();
        for (var start = 0; start < runes.Length;) {
            checkStop();
            var end = Math.Min(start + 512, runes.Length); var length = end - start;
            var points = needed.Keys.Where(i => i >= start && i < end).ToArray();
            if (points.Length == 0) {
                if (end == runes.Length) break;
                start = Math.Min(start + 256, runes.Length - 512); continue;
            }
            var ids = new DenseTensor<long>(new[] { 1, length, 8 });
            var mask = new DenseTensor<float>(new[] { 1, length });
            for (var i = 0; i < length; i++) {
                mask[0, i] = 1;
                for (var j = 0; j < 8; j++) ids[0, i, j] = ((long)runes[start + i].Value + 1) * Primes[j] % 8192;
            }
            InferenceRuns++;
            report?.Invoke($"智能分段：{context} · 模型窗口 {start + 1}–{end} / {runes.Length} 字符");
            using var output = session.Run(new[] { NamedOnnxValue.CreateFromTensor("hashed_ids", ids), NamedOnnxValue.CreateFromTensor("attention_mask", mask) });
            var logits = output.Single(x => x.Name == "logits").AsTensor<float>();
            if (logits.Dimensions[1] != length || logits.Dimensions[2] != 127) throw new Exception("扫描分段模型输出格式不匹配");
            foreach (var point in points) { sums[point] = sums.GetValueOrDefault(point) + logits[0, point - start, 0]; counts[point] = counts.GetValueOrDefault(point) + 1; }
            if (end == runes.Length) break;
            start = Math.Min(start + 256, runes.Length - 512);
        }
        var result = new Dictionary<int, double>();
        foreach (var (index, boundary) in needed) result[boundary] = 1 / (1 + Math.Exp(-sums[index] / counts[index]));
        return result;
    }

    public (int Start, int Length)[] Split(string text, string context = "")
    {
        checkStop();
        if (!text.Contains('\n') && !text.Contains('\r')) return [(0, text.Length)];
        if (cache.TryGetValue(text, out var cached)) return cached;
        var lines = Regex.Matches(text, @"[^\r\n]*(?:\r\n|\r|\n|$)").Where(m => m.Length > 0).ToArray();
        report?.Invoke($"智能分段：{context} · 原文 {lines.Length} 行");
        var flat = new StringBuilder(); var candidates = new List<(int Original, int Flat, bool Forced)>();
        string previous = "";
        for (var i = 0; i < lines.Length; i++) {
            var body = lines[i].Value.Trim();
            if (i > 0) candidates.Add((lines[i].Index, flat.Length, body.Length == 0 || previous.Length == 0 || ListStart.IsMatch(body)));
            if (body.Length > 0) {
                if (flat.Length > 0 && !(Cjk(flat[^1]) && Cjk(body[0]))) flat.Append(' ');
                flat.Append(body);
            }
            previous = body;
        }
        var safeCandidates = new List<(int Original, int Flat, bool Forced)>();
        var tags = new Stack<string>();
        var tokens = TranslationIntegrity.Tokens.Matches(text).ToArray(); var tokenIndex = 0;
        foreach (var candidate in candidates) {
            while (tokenIndex < tokens.Length && tokens[tokenIndex].Index < candidate.Original) {
                var token = tokens[tokenIndex++].Value;
                var tag = Regex.Match(token, @"^<(/?)([A-Za-z][\w-]*)");
                if (!tag.Success) continue;
                var name = tag.Groups[2].Value.ToLowerInvariant();
                if (tag.Groups[1].Length > 0) { if (tags.TryPeek(out var top) && top == name) tags.Pop(); }
                else if (!token.EndsWith("/>") && name is not ("br" or "sprite" or "img" or "space")) tags.Push(name);
            }
            if (tags.Count == 0) safeCandidates.Add(candidate);
        }
        var boundaries = safeCandidates.Where(c => !c.Forced && c.Flat > 0).Select(c => c.Flat).ToHashSet();
        var scores = boundaries.Count == 0 ? new Dictionary<int, double>() : Predict(flat.ToString(), boundaries, context);
        var cuts = new List<int> { 0 };
        foreach (var candidate in safeCandidates) if (candidate.Forced || scores.GetValueOrDefault(candidate.Flat) >= .01) cuts.Add(candidate.Original);
        cuts.Add(text.Length);
        var spans = new List<(int Start, int Length)>();
        for (var i = 0; i < cuts.Count - 1; i++) {
            var start = cuts[i]; var end = cuts[i + 1];
            while (start < end && char.IsWhiteSpace(text[start])) start++;
            while (end > start && char.IsWhiteSpace(text[end - 1])) end--;
            if (end > start) spans.Add((start, end - start));
        }
        // One block keeps the original field intact, including surrounding whitespace.
        var result = spans.Count <= 1 ? new[] { (0, text.Length) } : spans.ToArray();
        cache[text] = result; return result;
    }

    public static string Rebuild(string original, IEnumerable<Entry> selected)
    {
        var edits = selected.OrderBy(e => e.SourceStart).ToArray(); var previousEnd = 0;
        foreach (var entry in edits) {
            var start = entry.SourceStart ?? throw new Exception("智能分段缺少原文位置，请重新扫描");
            if (start < previousEnd || start < 0 || start > original.Length - entry.Source.Length || original.Substring(start, entry.Source.Length) != entry.Source)
                throw new Exception("智能分段的原文位置发生变化，未写入，请重新扫描");
            previousEnd = start + entry.Source.Length;
        }
        var text = new StringBuilder(original);
        foreach (var entry in edits.Reverse()) text.Remove(entry.SourceStart!.Value, entry.Source.Length).Insert(entry.SourceStart.Value, entry.Translation);
        return text.ToString();
    }

    public void Dispose() { session?.Dispose(); session = null; cache.Clear(); }
}

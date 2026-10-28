using System.Text;
using System.Text.RegularExpressions;
using System.Xml;

namespace LLMChat.UnityOffline;

public sealed record DocumentText(string Locator, string Text, Action<string> Set, string Locale = "", string Field = "text");

public static class TextDocuments
{
    public static string Read(string path) => new UTF8Encoding(false, true).GetString(File.ReadAllBytes(path));
    public static string Locale(string path)
    {
        foreach (var part in path.Split('/').Reverse()) {
            var name = part.Replace("~1", "/").Replace("~0", "~").Replace('_', '-').ToLowerInvariant();
            var named = name switch { "english" => "en", "japanese" or "日本語" => "ja", "chinese" or "简体中文" or "繁體中文" => "zh", "french" => "fr", "german" => "de", "spanish" => "es", "korean" => "ko", _ => "" };
            if (named.Length > 0) return named;
            if (Regex.IsMatch(name, @"^(?:en|ja|jp|zh|fr|de|es|it|pt|ko|ru)(?:-[a-z]{2,8})?$") ) return name.StartsWith("jp") ? "ja" + name[2..] : name;
        }
        return "";
    }

    public static string Process(string text, string name, string mode, Action<DocumentText> visit)
    {
        if (mode is not ("lines" or "paragraphs" or "smart")) throw new Exception("无效文本分段方式");
        if (text.StartsWith('\uFEFF')) return "\uFEFF" + Process(text[1..], name, mode, visit);
        var extension = Path.GetExtension(name).ToLowerInvariant();
        if (extension is ".csv" or ".tsv") return Csv(text, extension == ".tsv" ? '\t' : ',', visit);
        if (extension == ".xml") return Xml(text, visit);
        if (mode == "lines" || text.TrimStart().StartsWith('{') || text.TrimStart().StartsWith('['))
            return Program.TextDocument(text, (loc, value, set) => visit(new(loc, value, set, Locale(loc), Locale(loc).Length > 0 ? "text" : loc.StartsWith("line/") ? "text" : loc.Split('/').Last())));
        if (text.Contains('\0')) throw new Exception("文件包含二进制数据，不能按文本提取");
        if (mode == "smart") { var result = text; visit(new("document", text, next => result = next)); return result; }
        var lines = Regex.Split(text, "(\r\n|\n|\r)");
        for (var index = 0; index < lines.Length; index += 2) {
            if (string.IsNullOrWhiteSpace(lines[index])) continue;
            var start = index; var end = index;
            while (end + 2 < lines.Length && !string.IsNullOrWhiteSpace(lines[end + 2])) end += 2;
            var value = string.Concat(lines[start..(end + 1)]);
            if (value.Length > 16000) throw new Exception("段落超过 16000 字符，请选择按行提取；未忽略或截断正文");
            visit(new("paragraph/" + start / 2, value, translated => {
                lines[start] = translated;
                for (var i = start + 1; i <= end; i++) lines[i] = "";
            }));
            index = end;
        }
        return string.Concat(lines);
    }

    sealed record Cell(int Start, int End, string Value, bool Quoted);
    static string Csv(string text, char separator, Action<DocumentText> visit)
    {
        var records = new List<List<Cell>>(); var row = new List<Cell>(); var index = 0;
        while (index < text.Length) {
            var start = index; var quoted = text[index] == '"'; var value = new StringBuilder();
            if (quoted) {
                index++; var closed = false;
                while (index < text.Length) {
                    if (text[index] == '"') {
                        if (index + 1 < text.Length && text[index + 1] == '"') { value.Append('"'); index += 2; continue; }
                        index++; closed = true; break;
                    }
                    value.Append(text[index++]);
                }
                if (!closed || index < text.Length && text[index] != separator && text[index] is not ('\r' or '\n')) throw new Exception("CSV 引号或分隔符无效");
            } else {
                while (index < text.Length && text[index] != separator && text[index] is not ('\r' or '\n')) {
                    if (text[index] == '"') throw new Exception("CSV 未转义的引号");
                    value.Append(text[index++]);
                }
            }
            row.Add(new(start, index, value.ToString(), quoted));
            if (index == text.Length) { records.Add(row); break; }
            if (text[index] == separator) { index++; if (index == text.Length) { row.Add(new(index, index, "", false)); records.Add(row); } continue; }
            if (text[index++] == '\r' && index < text.Length && text[index] == '\n') index++;
            records.Add(row); row = [];
        }
        if (records.Count < 2) return text;
        var header = records[0]; var changes = new List<(Cell Cell, string Value)>();
        for (var column = 0; column < header.Count; column++) {
            var field = header[column].Value.Trim(); var locale = Locale(field);
            if (GameText.IsTechnicalField(field) || locale.Length == 0 && !Regex.IsMatch(field, @"^(?:text|message|dialogue|description|caption|title|displayName|content|body|choice|prompt|source|translation|name|sentence|value)$", RegexOptions.IgnoreCase)) continue;
            for (var record = 1; record < records.Count; record++) {
                if (records[record].Count != header.Count) throw new Exception($"CSV 第 {record + 1} 条记录列数与表头不一致");
                var cell = records[record][column];
                visit(new($"record/{record}/column/{column}", cell.Value, next => { if (next != cell.Value) changes.Add((cell, next)); }, locale, locale.Length > 0 ? "text" : field));
            }
        }
        var result = new StringBuilder(text);
        foreach (var change in changes.OrderByDescending(c => c.Cell.Start)) {
            var quoted = change.Cell.Quoted || change.Value.Contains(separator) || change.Value.IndexOfAny(['"', '\r', '\n']) >= 0;
            var replacement = quoted ? "\"" + change.Value.Replace("\"", "\"\"") + "\"" : change.Value;
            result.Remove(change.Cell.Start, change.Cell.End - change.Cell.Start).Insert(change.Cell.Start, replacement);
        }
        return result.ToString();
    }

    static string Xml(string text, Action<DocumentText> visit)
    {
        var document = new XmlDocument { PreserveWhitespace = true, XmlResolver = null };
        using var reader = XmlReader.Create(new StringReader(text), new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null });
        document.Load(reader); var changed = false;
        if (document.FirstChild is XmlDeclaration declaration && declaration.Encoding.Length > 0 && !declaration.Encoding.Equals("utf-8", StringComparison.OrdinalIgnoreCase) && !declaration.Encoding.Equals("utf8", StringComparison.OrdinalIgnoreCase)) throw new Exception("XML 仅支持 UTF-8 编码声明，未改写该文件");
        void Walk(XmlNode node, string path, string locale)
        {
            if (node is XmlElement element) {
                if (GameText.IsTechnicalField(element.LocalName)) return;
                locale = element.GetAttribute("lang", "http://www.w3.org/XML/1998/namespace") is { Length: > 0 } language ? language : element.GetAttribute("lang") is { Length: > 0 } plainLanguage ? plainLanguage : Locale(element.LocalName) is { Length: > 0 } named ? named : locale;
                foreach (XmlAttribute attribute in element.Attributes) {
                    if (GameText.IsTechnicalField(attribute.LocalName) || !Regex.IsMatch(attribute.LocalName, "^(?:text|value|label|description|title)$", RegexOptions.IgnoreCase)) continue;
                    visit(new(path + "/@" + attribute.Name, attribute.Value, next => { changed |= next != attribute.Value; attribute.Value = next; }, locale));
                }
            }
            for (var i = 0; i < node.ChildNodes.Count; i++) {
                var child = node.ChildNodes[i]!; var location = path + "/" + child.Name + "/" + i;
                if (child is XmlText or XmlCDataSection && !string.IsNullOrWhiteSpace(child.Value))
                    visit(new(location, child.Value!, next => { changed |= next != child.Value; child.Value = next; }, locale));
                else if (child is XmlElement) Walk(child, location, locale);
            }
        }
        Walk(document, "xml", ""); return changed ? document.OuterXml : text;
    }
}

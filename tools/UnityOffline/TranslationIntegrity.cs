using System.Text.RegularExpressions;

namespace LLMChat.UnityOffline;

public static class TranslationIntegrity
{
    public static readonly Regex Tokens = new(@"\{[^{}\r\n]+\}|%(?:\d+\$)?[-+0 #]*\d*(?:\.\d+)?[sdifouxXeEgGc%]|</?[^>\r\n]+>|\\[nrt]", RegexOptions.Compiled);
    public static string Validate(string source, string translation)
    {
        if (string.IsNullOrWhiteSpace(translation)) return "译文为空";
        var original = Tokens.Matches(source).Select(m => m.Value).ToArray();
        var translated = Tokens.Matches(translation).Select(m => m.Value).ToArray();
        if (!original.Order().SequenceEqual(translated.Order())) return "占位符、转义或富文本标签发生变化";
        bool Ordered(string value) => value.StartsWith('<') || value.StartsWith('\\') || value.StartsWith('%') && !Regex.IsMatch(value, @"^%\d+\$");
        if (!original.Where(Ordered).SequenceEqual(translated.Where(Ordered))) return "富文本标签嵌套、转义或非定位格式参数的顺序发生变化";
        return "";
    }
    public static string Visible(string text) => Tokens.Replace(text, "");
}

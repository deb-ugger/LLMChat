using System.Text.RegularExpressions;

namespace LLMChat.UnityOffline;

public static class TranslationIntegrity
{
    static readonly Regex Markup = new(@"\{[^{}\r\n]+\}|%%|(?<![0-9０-９])%(?:\d+\$)?[-+0 #]*\d*(?:\.\d+)?[sdifouxXeEgGc]|</?[A-Za-z][A-Za-z0-9-]*(?:[ \t=][^>\r\n]*)?/?>|<#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?>|\\[nrt]", RegexOptions.Compiled);
    static readonly Regex Glyphs = new(@"[\u0400-\u052f]{2,}[\u19d0-\u19df\u27c0-\u27ef][\u0400-\u05ff\u19d0-\u19df\u27c0-\u27ef]*|([\u0400-\u052f])\1+(?=[\s!?！？…。、]*[♡♥])", RegexOptions.Compiled);
    public static readonly Regex Tokens = new(Markup + "|" + Glyphs, RegexOptions.Compiled);
    public static string Validate(string source, string translation)
    {
        if (string.IsNullOrWhiteSpace(translation)) return "译文为空";
        if (!Glyphs.Matches(source).Select(m => m.Value).SequenceEqual(Glyphs.Matches(translation).Select(m => m.Value))) return "游戏特殊字形符号发生变化，请重试此条";
        var original = Tokens.Matches(source).Select(m => m.Value).ToArray();
        var translated = Tokens.Matches(translation).Select(m => m.Value).ToArray();
        if (!original.Order().SequenceEqual(translated.Order())) return "占位符、转义或富文本标签发生变化";
        bool Ordered(string value) => value.StartsWith('<') || value.StartsWith('\\') || value.StartsWith('%') && !Regex.IsMatch(value, @"^%\d+\$");
        if (!original.Where(Ordered).SequenceEqual(translated.Where(Ordered))) return "富文本标签嵌套、转义或非定位格式参数的顺序发生变化";
        return "";
    }
    public static string Visible(string text) => Markup.Replace(text, "");
}

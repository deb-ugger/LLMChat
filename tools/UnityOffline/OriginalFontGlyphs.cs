namespace LLMChat.UnityOffline;

public static class OriginalFontGlyphs
{
    public static HashSet<int> Codes(Project project)
    {
        var codes = new HashSet<int>();
        using var types = new GameTypes(project.Root, project.TypeDirectory);
        foreach (var group in project.Fonts.Where(font => font.Kind.StartsWith("TMP") || font.Kind.StartsWith("NGUI")).GroupBy(font => font.File)) {
            Program.VisitResource(Program.Within(project.Root, group.Key), (manager, instance, container) => {
                if (!group.Any(font => font.Container == container)) return;
                Program.PrepareTypes(manager, instance);
                foreach (var font in group.Where(font => font.Container == container)) {
                    var field = manager.GetBaseField(instance, instance.file.GetAssetInfo(long.Parse(font.ObjectId)));
                    codes.UnionWith(BitmapFontGenerator.ExistingCodes(field, font.Kind.StartsWith("TMP")));
                }
            }, types, group.Key);
        }
        return codes;
    }
}

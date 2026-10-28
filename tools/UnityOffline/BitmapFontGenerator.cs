using AssetsTools.NET;
using AssetsTools.NET.Extra;
using System.Security.Cryptography;
using System.Text;

namespace LLMChat.UnityOffline;

// Reuses existing object IDs and shader references. Every changed object is reopened
// by the exporter before a patch is marked complete.
public static class BitmapFontGenerator
{
    public const int Revision = 1;
    public static string? FontKind(AssetTypeValueField field)
    {
        if (!field["m_CharacterTable"].IsDummy || !field["m_glyphInfoList"].IsDummy) return "TMP";
        return !field["mFont"].IsDummy && !field["mFont"]["mSaved"].IsDummy ? "NGUI" : null;
    }
    public static void Number(AssetTypeValueField field, double value)
    {
        if (field.IsDummy) throw new Exception("字库缺少必需字段");
        switch (field.TemplateField.ValueType) {
            case AssetValueType.Int32: field.AsInt = checked((int)value); break;
            case AssetValueType.UInt32: field.AsUInt = checked((uint)value); break;
            case AssetValueType.Int64: field.AsLong = checked((long)value); break;
            case AssetValueType.UInt64: field.AsULong = checked((ulong)value); break;
            case AssetValueType.Float: field.AsFloat = (float)value; break;
            case AssetValueType.Double: field.AsDouble = value; break;
            case AssetValueType.Bool: field.AsBool = value != 0; break;
            default: throw new Exception("字库数值字段布局不支持：" + field.FieldName);
        }
    }
    static void Optional(AssetTypeValueField root, string name, double value) { if (!root.IsDummy && !root[name].IsDummy) Number(root[name], value); }
    static AssetTypeValueField Array(AssetTypeValueField root, string name) {
        if (root.IsDummy || root[name].IsDummy) throw new Exception("字库字段布局不支持：" + name);
        var array = root[name]["Array"];
        if (array.IsDummy || !array.TemplateField.IsArray) throw new Exception("字库字段布局不支持：" + name);
        return array;
    }
    static AssetTypeValueField Sample(AssetTypeValueField array) => array.Children.FirstOrDefault()?.Clone() ?? throw new Exception("字库表为空，无法确认序列化布局");
    static void NullPointer(AssetTypeValueField field) { if (!field.IsDummy) { Number(field["m_FileID"], 0); Number(field["m_PathID"], 0); } }
    static IEnumerable<int> ExistingCodes(AssetTypeValueField field, bool tmp)
    {
        var table = tmp ? Array(field, "m_CharacterTable") : Array(field["mFont"], "mSaved");
        return table.Children.Select(row => tmp ? checked((int)row["m_Unicode"].AsUInt) : row["index"].AsInt).Where(c => c is >= 32 and <= 0xFFFF && !char.IsSurrogate((char)c));
    }
    public static void WriteTmp(AssetTypeValueField field, RasterAtlas atlas)
    {
        var glyphs = Array(field, "m_GlyphTable"); var characters = Array(field, "m_CharacterTable");
        var glyphSample = Sample(glyphs); var charSample = Sample(characters);
        glyphs.Children.Clear(); characters.Children.Clear();
        uint index = 1;
        foreach (var glyph in atlas.Glyphs) {
            var g = glyphSample.Clone(); Number(g["m_Index"], index);
            var metrics = g["m_Metrics"];
            foreach (var (key, value) in new[] { ("m_Width", glyph.Width), ("m_Height", glyph.Height), ("m_HorizontalBearingX", glyph.BearingX), ("m_HorizontalBearingY", glyph.BearingY), ("m_HorizontalAdvance", glyph.Advance) }) Number(metrics[key], value);
            var rect = g["m_GlyphRect"];
            foreach (var (key, value) in new[] { ("m_X", glyph.X), ("m_Y", atlas.Height - glyph.Y - glyph.Height), ("m_Width", glyph.Width), ("m_Height", glyph.Height) }) Number(rect[key], value);
            Number(g["m_Scale"], 1); Number(g["m_AtlasIndex"], 0); glyphs.Children.Add(g);
            var c = charSample.Clone(); Number(c["m_ElementType"], 1); Number(c["m_Unicode"], glyph.Code); Number(c["m_GlyphIndex"], index++); Number(c["m_Scale"], 1); characters.Children.Add(c);
        }
        var face = field["m_FaceInfo"];
        foreach (var (key, value) in new[] { ("m_PointSize", atlas.PointSize), ("m_Scale", 1), ("m_LineHeight", atlas.Ascent + atlas.Descent), ("m_AscentLine", atlas.Ascent), ("m_DescentLine", -atlas.Descent), ("m_Baseline", 0) }) Number(face[key], value);
        Optional(face, "m_CapLine", atlas.Glyphs.FirstOrDefault(g => g.Code == 'H')?.BearingY ?? atlas.Ascent);
        Optional(face, "m_MeanLine", atlas.Glyphs.FirstOrDefault(g => g.Code == 'x')?.BearingY ?? atlas.Ascent / 2);
        Optional(face, "m_UnderlineOffset", -atlas.Descent / 2.0); Optional(face, "m_UnderlineThickness", Math.Max(1, atlas.PointSize / 16.0));
        Optional(face, "m_StrikethroughOffset", atlas.Ascent / 3.0); Optional(face, "m_StrikethroughThickness", Math.Max(1, atlas.PointSize / 16.0));
        Optional(face, "m_TabWidth", (atlas.Glyphs.FirstOrDefault(g => g.Code == 32)?.Advance ?? atlas.PointSize / 2) * 4);
        Number(field["m_AtlasWidth"], atlas.Width); Number(field["m_AtlasHeight"], atlas.Height); Number(field["m_AtlasPadding"], atlas.Padding);
        Number(field["m_AtlasPopulationMode"], 0); Optional(field, "m_AtlasTextureIndex", 0); Optional(field, "m_IsMultiAtlasTexturesEnabled", 0);
        NullPointer(field["m_SourceFontFile"]);
        foreach (var name in new[] { "m_UsedGlyphRects", "m_FreeGlyphRects", "m_glyphInfoList", "m_KerningTable" }) {
            if (!field[name].IsDummy && !field[name]["Array"].IsDummy) field[name]["Array"].Children.Clear();
        }
        var feature = field["m_FontFeatureTable"];
        if (!feature.IsDummy) foreach (var child in feature.Children) if (!child["Array"].IsDummy) child["Array"].Children.Clear();
    }
    public static void WriteNgui(AssetTypeValueField field, RasterAtlas atlas)
    {
        var bm = field["mFont"]; var glyphs = Array(bm, "mSaved"); var sample = Sample(glyphs); glyphs.Children.Clear();
        foreach (var glyph in atlas.Glyphs) {
            var g = sample.Clone();
            foreach (var (key, value) in new[] { ("index", glyph.Code), ("x", glyph.X), ("y", glyph.Y), ("width", glyph.Width), ("height", glyph.Height), ("offsetX", glyph.BearingX), ("offsetY", atlas.Ascent - glyph.BearingY), ("advance", glyph.Advance), ("channel", 15) }) Number(g[key], value);
            if (!g["kerning"].IsDummy && !g["kerning"]["Array"].IsDummy) g["kerning"]["Array"].Children.Clear(); glyphs.Children.Add(g);
        }
        Number(bm["mSize"], atlas.PointSize); Number(bm["mBase"], atlas.Ascent); Number(bm["mWidth"], atlas.Width); Number(bm["mHeight"], atlas.Height);
        Optional(field, "mType", 1);
        if (!field["mUVRect"].IsDummy) foreach (var (key, value) in new[] { ("x", 0), ("y", 0), ("width", 1), ("height", 1) }) Number(field["mUVRect"][key], value);
        if (!field["mSymbols"].IsDummy && field["mSymbols"]["Array"].Children.Count != 0) throw new Exception("NGUI 字库含图标符号，不能覆盖其共享图集");
    }
    public static void WriteTexture(AssetTypeValueField texture, RasterAtlas atlas, bool sdf)
    {
        Number(texture["m_Width"], atlas.Width); Number(texture["m_Height"], atlas.Height);
        Number(texture["m_TextureFormat"], sdf ? 1 : 4); // Alpha8 or RGBA32, both supported by Unity's font shaders.
        Optional(texture, "m_MipCount", 1); Optional(texture, "m_MipMap", 0); Optional(texture, "m_IsReadable", 1);
        Optional(texture, "m_StreamingMipmaps", 0); Optional(texture, "m_ImageCount", 1); Optional(texture, "m_TextureDimension", 2);
        Optional(texture, "m_ColorSpace", 0); Optional(texture, "m_CompleteImageSize", atlas.Width * atlas.Height * (sdf ? 1 : 4));
        var stream = texture["m_StreamData"];
        if (!stream.IsDummy) { Number(stream["offset"], 0); Number(stream["size"], 0); stream["path"].AsString = ""; }
        var pixels = new byte[atlas.Width * atlas.Height * (sdf ? 1 : 4)];
        for (var y = 0; y < atlas.Height; y++) for (var x = 0; x < atlas.Width; x++) {
            var source = atlas.Pixels[y * atlas.Width + x]; var offset = ((atlas.Height - 1 - y) * atlas.Width + x) * (sdf ? 1 : 4);
            if (sdf) pixels[offset] = source;
            else { pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 255; pixels[offset + 3] = source; }
        }
        if (texture["image data"].IsDummy) throw new Exception("Texture2D 缺少内嵌像素字段");
        texture["image data"].AsByteArray = pixels;
        var settings = texture["m_TextureSettings"]; Optional(settings, "m_FilterMode", 1); Optional(settings, "m_WrapMode", 1);
        Optional(settings, "m_WrapU", 1); Optional(settings, "m_WrapV", 1);
    }
    static void FloatProperty(AssetTypeValueField material, string name, float value)
    {
        var values = Array(material["m_SavedProperties"], "m_Floats");
        var item = values.Children.FirstOrDefault(c => c["first"].AsString == name);
        if (item == null) { item = Sample(values); item["first"].AsString = name; values.Children.Add(item); }
        item["second"].AsFloat = value;
    }
    static AssetTypeValueField MainTexture(AssetTypeValueField material)
    {
        var item = Array(material["m_SavedProperties"], "m_TexEnvs").Children.FirstOrDefault(c => c["first"].AsString == "_MainTex");
        if (item == null) throw new Exception("字体材质缺少 _MainTex");
        var value = item["second"];
        if (!value["m_Scale"].IsDummy) { Number(value["m_Scale"]["x"], 1); Number(value["m_Scale"]["y"], 1); }
        if (!value["m_Offset"].IsDummy) { Number(value["m_Offset"]["x"], 0); Number(value["m_Offset"]["y"], 0); }
        return value["m_Texture"];
    }
    public static Dictionary<long, AssetTypeValueField> Generate(AssetsManager manager, AssetsFileInstance instance, FontInfo[] fonts, Request request, string characters)
    {
        var changed = new Dictionary<long, AssetTypeValueField>(); var textureOwners = new HashSet<long>();
        AssetTypeValueField Read(long id, int type = 0) {
            if (changed.TryGetValue(id, out var field)) return field;
            var info = instance.file.GetAssetInfo(id) ?? throw new Exception("字库引用对象不存在：" + id);
            if (type != 0 && info.TypeId != type) throw new Exception("字库引用类型不匹配：" + id);
            return manager.GetBaseField(instance, info);
        }
        long Pointer(AssetTypeValueField pointer) {
            if (pointer.IsDummy || pointer["m_FileID"].IsDummy || pointer["m_FileID"].AsInt != 0) throw new Exception("字库引用跨资源文件，当前原生生成尚不支持：" + instance.name);
            var id = pointer["m_PathID"].AsLong;
            if (id == 0) throw new Exception("字库缺少图集或材质引用"); return id;
        }
        using var rasterizer = new FontRasterizer(File.ReadAllBytes(request.FontPath));
        foreach (var target in fonts) {
            Program.CheckStop(request, "");
            var id = long.Parse(target.ObjectId); var field = Read(id); var tmp = target.Kind.StartsWith("TMP", StringComparison.Ordinal);
            var name = field["m_Name"].IsDummy ? target.Name : field["m_Name"].AsString;
            if (FontKind(field) == null) throw new Exception("该对象是字体引用组件，不是字库资源，请重新扫描：" + name);
            Program.Progress("生成字库图集：" + name);
            AssetTypeValueField materialPointer; long textureId;
            if (tmp) {
                if (field["m_GlyphTable"].IsDummy || field["m_FaceInfo"].IsDummy) throw new Exception("旧版 TMP 字库布局暂不支持：" + name);
                var textures = Array(field, "m_AtlasTextures");
                if (textures.Children.Count != 1) throw new Exception("TMP 多图集字库暂不支持：" + name);
                textureId = Pointer(textures.Children[0]); materialPointer = field["material"].IsDummy ? field["m_Material"] : field["material"];
            } else {
                if (!field["mAtlas"].IsDummy && field["mAtlas"]["m_PathID"].AsLong != 0) throw new Exception("NGUI 字库使用共享 UIAtlas，暂不覆盖共享图片：" + name);
                if (!field["mReplacement"].IsDummy && field["mReplacement"]["m_PathID"].AsLong != 0 || !field["mDynamicFont"].IsDummy && field["mDynamicFont"]["m_PathID"].AsLong != 0) throw new Exception("NGUI 引用或动态字库应处理其源字体：" + name);
                materialPointer = field["mMat"]; textureId = 0;
            }
            var materialId = Pointer(materialPointer); var material = Read(materialId, 21);
            var main = Pointer(MainTexture(material));
            if (tmp && main != textureId) throw new Exception("TMP 字库与材质图集引用不一致：" + name);
            textureId = main;
            if (!textureOwners.Add(textureId)) throw new Exception("多个字库共享同一纹理，不能独立覆盖：" + name);
            var texture = Read(textureId, 28);
            // Keep shader selection, and only use an SDF atlas for an existing SDF material.
            var sdf = tmp && Array(material["m_SavedProperties"], "m_Floats").Children.Any(c => c["first"].AsString == "_GradientScale");
            var allCharacters = characters + string.Concat(ExistingCodes(field, tmp).Select(char.ConvertFromUtf32));
            var atlas = rasterizer.Generate(allCharacters, sdf, () => Program.CheckStop(request, ""), (done, total) => Program.Progress("生成字形：" + name, done, total));
            if (tmp) WriteTmp(field, atlas); else WriteNgui(field, atlas);
            if (tmp) Optional(field, "m_AtlasRenderMode", sdf ? 0x1049 : 0x1019);
            WriteTexture(texture, atlas, sdf);
            if (tmp) {
                // Text components can use material presets rather than the font's default material.
                foreach (var info in instance.file.Metadata.AssetInfos.Where(info => info.TypeId == 21)) {
                    var preset = info.PathId == materialId ? material : Read(info.PathId, 21);
                    var tex = Array(preset["m_SavedProperties"], "m_TexEnvs").Children.FirstOrDefault(c => c["first"].AsString == "_MainTex")?["second"]["m_Texture"];
                    if (tex == null || tex["m_FileID"].AsInt != 0 || tex["m_PathID"].AsLong != textureId) continue;
                    var presetSdf = Array(preset["m_SavedProperties"], "m_Floats").Children.Any(c => c["first"].AsString == "_GradientScale");
                    if (presetSdf != sdf) throw new Exception("同一字库纹理被不同渲染类型的材质使用：" + name);
                    MainTexture(preset); FloatProperty(preset, "_TextureWidth", atlas.Width); FloatProperty(preset, "_TextureHeight", atlas.Height);
                    if (sdf) FloatProperty(preset, "_GradientScale", atlas.Padding + 1);
                    changed[info.PathId] = preset;
                }
            }
            changed[id] = field; changed[materialId] = material; changed[textureId] = texture;
        }
        return changed;
    }
    public static string Digest(AssetTypeValueField field, bool bigEndian) => Convert.ToHexString(SHA256.HashData(field.WriteToByteArray(bigEndian)));
}

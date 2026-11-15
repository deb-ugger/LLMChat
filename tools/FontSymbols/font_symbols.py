"""Import missing Unicode symbol outlines without substituting code points."""
import json
import sys
import math
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.t2CharStringPen import T2CharStringPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.pens.qu2cuPen import Qu2CuPen
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.boundsPen import BoundsPen


def progress(detail):
    print("LLMCHAT_FONT_PROGRESS " + json.dumps({"detail": detail}, ensure_ascii=True), file=sys.stderr, flush=True)


def supplement(request):
    progress("正在读取字体字符映射")
    font = TTFont(request.get("baseFont") or request["source"], recalcTimestamp=False, recalcBBoxes=False)
    existing_mappings = request.get("baseMappings") or []
    original_cmap = dict(font.getBestCmap())
    missing = [code for code in request["codepoints"] if code not in original_cmap]
    donors = []
    for path in request["donors"]:
        donor = TTFont(path, recalcTimestamp=False)
        if "fvar" in donor:
            from fontTools.varLib.instancer import instantiateVariableFont
            donor = instantiateVariableFont(donor, {axis.axisTag: axis.defaultValue for axis in donor["fvar"].axes}, inplace=True)
        donors.append((Path(path).name, donor, donor.getBestCmap()))
    available = [(code, next(((name, donor, cmap[code]) for name, donor, cmap in donors if code in cmap), None)) for code in missing]
    additions = [item for item in available if item[1] is not None]
    if not additions:
        import shutil
        shutil.copyfile(request.get("baseFont") or request["source"], request["output"])
        return {"mappings": existing_mappings, "missing": missing}
    if len(font.getGlyphOrder()) + len(additions) > 65535:
        progress(f"正在整理原字体的 {len(font.getGlyphOrder())} 个字形，保留原始字符与排版功能")
        # Preserve every encoded character and its shaping closure while releasing
        # unused glyph slots in maximal-size CJK fonts.
        options = subset.Options()
        options.layout_features = ["*"]
        options.glyph_names = True
        worker = subset.Subsetter(options=options)
        selectors = {selector for table in font["cmap"].tables if table.format == 14 for selector in table.uvsDict}
        worker.populate(unicodes=set(original_cmap) | selectors)
        worker.subset(font)
        progress(f"字体整理完成，现有 {len(font.getGlyphOrder())} 个字形")
    if len(font.getGlyphOrder()) + len(additions) > 65535:
        raise ValueError("字体字形数量已达上限，无法安全补入新字形，请选择其他主字体")
    mappings = list(existing_mappings)
    for code, (source_name, donor, donor_glyph) in additions:
        progress(f"正在补入 U+{code:04X} 的真实字形，来源 {source_name}")
        glyph_set = donor.getGlyphSet()
        recording = DecomposingRecordingPen(glyph_set)
        glyph_set[donor_glyph].draw(recording)
        scale = font["head"].unitsPerEm / donor["head"].unitsPerEm
        bounds_pen = BoundsPen(None)
        recording.replay(TransformPen(bounds_pen, (scale, 0, 0, scale, 0, 0)))
        bounds = tuple(rounding(value) for rounding, value in zip((math.floor, math.floor, math.ceil, math.ceil), bounds_pen.bounds or (0, 0, 0, 0)))
        width, lsb = donor["hmtx"][donor_glyph]
        width, lsb = round(width * scale), round(lsb * scale)
        if "CFF " in font:
            cff = font["CFF "].cff
            top = cff.topDictIndex[0]
            cid = hasattr(top, "FDArray")
            private = top.FDArray[0].Private if cid else top.Private
            nominal = getattr(private, "nominalWidthX", 0)
            default = getattr(private, "defaultWidthX", 0)
            pen = T2CharStringPen(None if width == default else width - nominal, None)
            recording.replay(Qu2CuPen(TransformPen(pen, (scale, 0, 0, scale, 0, 0)), max_err=1, all_cubic=True))
            if cid:
                used = set(top.charset)
                glyph_name = next(f"cid{index:05d}" for index in range(1, 65536) if f"cid{index:05d}" not in used)
            else:
                glyph_name = f"symbol{code:X}"
            charstring = pen.getCharString(private=private, globalSubrs=cff.GlobalSubrs)
            strings = top.CharStrings
            strings.charStrings[glyph_name] = len(strings.charStringsIndex)
            strings.charStringsIndex.append(charstring)
            top.charset.append(glyph_name)
            if cid:
                top.FDSelect.gidArray.append(0)
                top.CIDCount = max(getattr(top, "CIDCount", 0), int(glyph_name[3:]) + 1)
        elif "glyf" in font:
            glyph_name = f"symbol{code:X}"
            pen = TTGlyphPen(None)
            recording.replay(TransformPen(Cu2QuPen(pen, max_err=1, reverse_direction=False), (scale, 0, 0, scale, 0, 0)))
            font["glyf"][glyph_name] = pen.glyph()
            added_glyph = font["glyf"][glyph_name]
            added_glyph.recalcBounds(font["glyf"])
            font["maxp"].maxPoints = max(font["maxp"].maxPoints, len(added_glyph.coordinates))
            font["maxp"].maxContours = max(font["maxp"].maxContours, added_glyph.numberOfContours)
        else:
            raise ValueError("主字体不是支持的 TTF 或 CFF OTF 轮廓格式")
        # CFF's charset update can already be reflected in getGlyphOrder().
        order = font.getGlyphOrder()
        if glyph_name not in order:
            font.setGlyphOrder(order + [glyph_name])
        font["hmtx"][glyph_name] = (width, lsb)
        # Existing outlines are unchanged. Update only the new outline's extents
        # instead of redrawing tens of thousands of glyphs during every save.
        head = font["head"]
        head.xMin, head.yMin = min(head.xMin, bounds[0]), min(head.yMin, bounds[1])
        head.xMax, head.yMax = max(head.xMax, bounds[2]), max(head.yMax, bounds[3])
        metrics = font["hhea"]
        metrics.advanceWidthMax = max(metrics.advanceWidthMax, width)
        metrics.minLeftSideBearing = min(metrics.minLeftSideBearing, lsb)
        metrics.minRightSideBearing = min(metrics.minRightSideBearing, width - lsb - (bounds[2] - bounds[0]))
        metrics.xMaxExtent = max(metrics.xMaxExtent, lsb + bounds[2] - bounds[0])
        if "CFF " in font:
            top.FontBBox = [head.xMin, head.yMin, head.xMax, head.yMax]
        if code > 0xFFFF and not any(table.isUnicode() and table.format == 12 for table in font["cmap"].tables):
            from fontTools.ttLib.tables._c_m_a_p import CmapSubtable
            table = CmapSubtable.newSubtable(12)
            table.platformID, table.platEncID, table.language = 3, 10, 0
            table.cmap = dict(font.getBestCmap())
            font["cmap"].tables.append(table)
        for table in font["cmap"].tables:
            if table.isUnicode() and table.format in (4, 12) and (table.format == 12 or code <= 0xFFFF):
                table.cmap[code] = glyph_name
        if "vmtx" in font:
            font["vmtx"][glyph_name] = (font["head"].unitsPerEm, 0)
        mappings.append({"codepoint": code, "font": source_name, "glyph": donor_glyph})
    # Rename derivative fonts, preserving copyright and licensing records.
    names = {1: "LLMChat Symbol Supplement", 3: "LLMChat-Symbol-Supplement", 4: "LLMChat Symbol Supplement", 6: "LLMChat-Symbol-Supplement", 16: "LLMChat Symbol Supplement"}
    for record in font["name"].names:
        if record.nameID in names:
            record.string = names[record.nameID].encode(record.getEncoding())
    if "CFF " in font:
        font["CFF "].cff.fontNames = ["LLMChat-Symbol-Supplement"]
        top.FullName = top.FamilyName = "LLMChat Symbol Supplement"
    progress("正在写入补字后的字体文件")
    font.save(request["output"])
    font.close()
    with TTFont(request["output"], checkChecksums=2) as checked:
        progress("正在校验补字后的字符映射")
        cmap = checked.getBestCmap()
        if not set(original_cmap).issubset(cmap) or any(item["codepoint"] not in cmap for item in mappings):
            raise ValueError("补字后的 Unicode 映射校验失败")
    for _, donor, _ in donors:
        donor.close()
    return {"mappings": mappings, "missing": [code for code, donor in available if donor is None]}


if __name__ == "__main__":
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    try:
        result = supplement(json.load(sys.stdin))
        print(json.dumps(result, ensure_ascii=True))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)

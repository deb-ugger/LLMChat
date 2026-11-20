using System.Numerics;
using System.Text;
using System.Text.RegularExpressions;
using FormatReader = LLMChat.UnityOffline.BinaryTextAssets.FormatReader;

namespace LLMChat.UnityOffline;

public sealed record SpineSkeletonSummary(int IkConstraints, int TransformConstraints, int PathConstraints, int PhysicsConstraints,
    int Skins, int Attachments, int Events, int Animations, int Timelines);

internal static class SpineBinaryInspection
{
    static readonly UTF8Encoding Utf8 = new(false, true);
    static readonly Regex Version = new(@"^4\.2\.[0-9]+$", RegexOptions.CultureInvariant);

    internal static BinaryTextAssetSummary Read(byte[] bytes, Action? checkStop)
    {
        var decoder = new Decoder(bytes, checkStop);
        return decoder.Inspect();
    }

    // Walk the serialized tables without building a renderable skeleton.
    ref struct Decoder(ReadOnlySpan<byte> bytes, Action? checkStop)
    {
        FormatReader reader = new(bytes);
        readonly int length = bytes.Length;
        bool nonessential;
        int strings, bones, slots, ik, transform, path, physics, skins, attachments, timelines;
        bool[] audioEvents = [];

        internal BinaryTextAssetSummary Inspect()
        {
            reader.Take(8);
            var version = Utf8.GetString(reader.SpineString());
            if (!Version.IsMatch(version)) throw new InvalidDataException($"不支持的 Spine 骨骼版本 {version}");
            reader.Take(20);
            nonessential = reader.Bool();
            if (nonessential)
            {
                reader.Take(4);
                reader.SpineString();
                reader.SpineString();
            }

            strings = reader.SpineCount();
            for (var i = 0; i < strings; i++) reader.SpineString();
            bones = reader.SpineCount();
            for (var i = 0; i < bones; i++)
            {
                reader.SpineString();
                if (i > 0) Index(i, "父骨骼");
                reader.Take(32);
                reader.VarUInt();
                reader.Bool();
                if (nonessential)
                {
                    reader.Take(4);
                    reader.SpineString();
                    reader.Bool();
                }
            }
            slots = reader.SpineCount();
            for (var i = 0; i < slots; i++)
            {
                reader.SpineString();
                Index(bones, "插槽骨骼");
                reader.Take(8);
                StringReference();
                reader.VarUInt();
                if (nonessential) reader.Bool();
            }

            ReadConstraints();
            var defaultSlots = reader.SpineCount();
            if (defaultSlots > 0)
            {
                skins = 1;
                ReadSkinSlots(defaultSlots);
            }
            var namedSkins = reader.SpineCount();
            for (var i = 0; i < namedSkins; i++)
            {
                checkStop?.Invoke();
                reader.SpineString();
                if (nonessential) reader.Take(4);
                IndexList(bones, "皮肤骨骼");
                IndexList(ik, "皮肤 IK");
                IndexList(transform, "皮肤变换约束");
                IndexList(path, "皮肤路径约束");
                IndexList(physics, "皮肤物理约束");
                ReadSkinSlots(reader.SpineCount());
            }
            skins += namedSkins;

            audioEvents = new bool[reader.SpineCount()];
            for (var i = 0; i < audioEvents.Length; i++)
            {
                reader.SpineString();
                reader.VarBits();
                reader.Take(4);
                reader.SpineString();
                audioEvents[i] = SkipOptionalString();
                if (audioEvents[i]) reader.Take(8);
            }

            var animations = reader.SpineCount();
            for (var i = 0; i < animations; i++)
            {
                checkStop?.Invoke();
                reader.SpineString();
                ReadAnimation();
            }
            if (reader.Remaining != 0)
                throw new InvalidDataException($"Spine 动画表后还有 {reader.Remaining} 字节");
            return new("Spine binary", length, reader.Offset, Strings: strings, Version: version, Bones: bones, Slots: slots,
                Skeleton: new(ik, transform, path, physics, skins, attachments, audioEvents.Length, animations, timelines));
        }

        void ReadConstraints()
        {
            ik = reader.SpineCount();
            for (var i = 0; i < ik; i++)
            {
                ConstraintPrefix();
                IndexList(bones, "IK 骨骼");
                Index(bones, "IK 目标");
                var flags = reader.Byte();
                if ((flags & 0x60) == 0x60) reader.Take(4);
                if ((flags & 0x80) != 0) reader.Take(4);
            }
            transform = reader.SpineCount();
            for (var i = 0; i < transform; i++)
            {
                ConstraintPrefix();
                IndexList(bones, "变换约束骨骼");
                Index(bones, "变换约束目标");
                SkipFlaggedFloats(reader.Byte(), 0xf8);
                SkipFlaggedFloats(reader.Byte(), 0x7f);
            }
            path = reader.SpineCount();
            for (var i = 0; i < path; i++)
            {
                ConstraintPrefix();
                reader.Bool();
                IndexList(bones, "路径约束骨骼");
                Index(slots, "路径约束目标");
                var flags = reader.Byte();
                reader.Take((flags & 0x80) != 0 ? 24 : 20);
            }
            physics = reader.SpineCount();
            for (var i = 0; i < physics; i++)
            {
                ConstraintPrefix();
                Index(bones, "物理约束骨骼");
                // The first mask controls optional floats, interspersed with
                // five required floats and a single-byte simulation step.
                var flags = reader.Byte();
                reader.Take(21 + 4 * BitOperations.PopCount((uint)(flags & 0xfe)));
                SkipFlaggedFloats(reader.Byte(), 0x80);
            }
        }

        void ConstraintPrefix()
        {
            reader.SpineString();
            reader.VarUInt();
        }

        void SkipFlaggedFloats(byte flags, int mask) =>
            reader.Take(4 * BitOperations.PopCount((uint)(flags & mask)));

        void ReadSkinSlots(int groups)
        {
            for (var i = 0; i < groups; i++)
            {
                Index(slots, "皮肤插槽");
                for (int j = 0, count = reader.SpineCount(); j < count; j++)
                {
                    StringReference();
                    ReadAttachment();
                    attachments++;
                }
            }
        }

        void ReadAttachment()
        {
            var flags = reader.Byte();
            if ((flags & 8) != 0) StringReference();
            var kind = flags & 7;
            if (kind is 0 or 2 or 3)
            {
                if ((flags & 16) != 0) StringReference();
                if ((flags & 32) != 0) reader.Take(4);
                if ((flags & 64) != 0)
                    for (var i = 0; i < 4; i++) reader.VarUInt(); // Sequence description.
            }
            switch (kind)
            {
                case 0: // Region
                    reader.Take((flags & 128) != 0 ? 28 : 24);
                    break;
                case 1: // Bounding box
                    SkipVertices((flags & 16) != 0);
                    if (nonessential) reader.Take(4);
                    break;
                case 2: // Mesh
                    var hull = reader.VarUInt();
                    var coordinates = SkipVertices((flags & 128) != 0);
                    reader.Take(checked(coordinates * 4));
                    if (hull > coordinates - 2) throw new InvalidDataException("Spine 网格轮廓长度越界");
                    SkipVarints(checked((coordinates - hull - 2) * 3));
                    if (nonessential)
                    {
                        SkipVarints(reader.SpineCount());
                        reader.Take(8);
                    }
                    break;
                case 3: // Linked mesh
                    reader.VarUInt(); // Parent skin may be defined later.
                    StringReference();
                    if (nonessential) reader.Take(8);
                    break;
                case 4: // Path
                    reader.Take(checked((SkipVertices((flags & 64) != 0) / 6) * 4));
                    if (nonessential) reader.Take(4);
                    break;
                case 5: // Point
                    reader.Take(nonessential ? 16 : 12);
                    break;
                case 6: // Clipping
                    Index(slots, "裁剪结束插槽");
                    SkipVertices((flags & 16) != 0);
                    if (nonessential) reader.Take(4);
                    break;
                default:
                    throw new InvalidDataException($"不支持的 Spine 附件类型 {kind}");
            }
        }

        int SkipVertices(bool weighted)
        {
            var vertices = reader.SpineCount();
            if (weighted)
            {
                for (var i = 0; i < vertices; i++)
                    for (int j = 0, count = reader.SpineCount(); j < count; j++)
                    {
                        Index(bones, "网格权重骨骼");
                        reader.Take(12);
                    }
            }
            else reader.Take(checked(vertices * 8));
            return checked(vertices * 2);
        }

        enum Group { Slot, Bone, Path, Physics }

        void ReadAnimation()
        {
            reader.VarUInt(); // Exported timeline capacity; count the tables below.
            ReadGroupedTimelines(Group.Slot, slots);
            ReadGroupedTimelines(Group.Bone, bones);
            ReadIkTimelines();
            for (int i = 0, n = reader.SpineCount(); i < n; i++)
            {
                Index(transform, "动画变换约束");
                ReadCurves(reader.SpineCount(), 6, 4);
                timelines++;
            }
            ReadGroupedTimelines(Group.Path, path);
            ReadGroupedTimelines(Group.Physics, physics);
            ReadAttachmentTimelines();
            ReadDrawOrder();
            ReadEventTimeline();
        }

        void ReadGroupedTimelines(Group group, int targets)
        {
            for (int i = 0, n = reader.SpineCount(); i < n; i++)
            {
                Index(group == Group.Physics ? checked(targets + 1) : targets, "时间轴目标");
                for (int j = 0, count = reader.SpineCount(); j < count; j++)
                {
                    var kind = reader.Byte();
                    var frames = reader.SpineCount();
                    timelines++;
                    if (group == Group.Slot && kind == 0)
                    {
                        for (var frame = 0; frame < frames; frame++)
                        {
                            reader.Take(4);
                            StringReference();
                        }
                    }
                    else if (group == Group.Bone && kind == 10)
                        reader.Take(checked(frames * 5));
                    else if (group == Group.Physics && kind == 8)
                        reader.Take(checked(frames * 4));
                    else
                    {
                        var channels = (group, kind) switch
                        {
                            (Group.Slot, 1) => 4,
                            (Group.Slot, 2) => 3,
                            (Group.Slot, 3) => 7,
                            (Group.Slot, 4) => 6,
                            (Group.Slot, 5) => 1,
                            (Group.Bone, 1 or 4 or 7) => 2,
                            (Group.Bone, <= 9) => 1,
                            (Group.Path, 0 or 1) => 1,
                            (Group.Path, 2) => 3,
                            (Group.Physics, 0 or 1 or 2 or 4 or 5 or 6 or 7) => 1,
                            _ => throw new InvalidDataException($"不支持的 Spine {group} 时间轴类型 {kind}")
                        };
                        ReadCurves(frames, channels, group == Group.Slot ? 1 : 4);
                    }
                }
            }
        }

        void ReadCurves(int frames, int channels, int bytesPerChannel)
        {
            var frameSize = 4 + channels * bytesPerChannel;
            reader.VarUInt(); // Bézier allocation count.
            if (frames == 0) throw new InvalidDataException("Spine 曲线时间轴缺少关键帧");
            for (var frame = 0; frame < frames; frame++)
            {
                reader.Take(frameSize);
                if (frame != 0) SkipCurve(channels);
            }
        }

        void SkipCurve(int channels)
        {
            var kind = reader.Byte();
            if (kind == 2) reader.Take(16 * channels);
            else if (kind > 2) throw new InvalidDataException($"不支持的 Spine 插值类型 {kind}");
        }

        void ReadIkTimelines()
        {
            for (int i = 0, n = reader.SpineCount(); i < n; i++)
            {
                Index(ik, "动画 IK");
                var frames = reader.SpineCount();
                reader.VarUInt();
                if (frames == 0) throw new InvalidDataException("Spine IK 时间轴缺少关键帧");
                for (var frame = 0; frame < frames; frame++)
                {
                    var flags = reader.Byte();
                    reader.Take(4);
                    if ((flags & 3) == 3) reader.Take(4);
                    if ((flags & 4) != 0) reader.Take(4);
                    if (frame != 0 && (flags & 0xc0) == 0x80) reader.Take(32);
                }
                timelines++;
            }
        }

        void ReadAttachmentTimelines()
        {
            for (int i = 0, n = reader.SpineCount(); i < n; i++)
            {
                Index(skins, "动画皮肤");
                for (int j = 0, groups = reader.SpineCount(); j < groups; j++)
                {
                    Index(slots, "动画附件插槽");
                    for (int k = 0, count = reader.SpineCount(); k < count; k++)
                    {
                        StringReference();
                        var kind = reader.Byte();
                        var frames = reader.SpineCount();
                        if (kind == 1) reader.Take(checked(frames * 12));
                        else if (kind == 0) ReadDeform(frames);
                        else throw new InvalidDataException($"不支持的 Spine 附件时间轴类型 {kind}");
                        timelines++;
                    }
                }
            }
        }

        void ReadDeform(int frames)
        {
            reader.VarUInt();
            if (frames == 0) throw new InvalidDataException("Spine 变形时间轴缺少关键帧");
            reader.Take(4);
            for (var frame = 0; frame < frames; frame++)
            {
                var values = reader.SpineCount();
                if (values > 0)
                {
                    reader.VarUInt();
                    reader.Take(checked(values * 4));
                }
                if (frame + 1 < frames)
                {
                    reader.Take(4);
                    SkipCurve(1);
                }
            }
        }

        void ReadDrawOrder()
        {
            var frames = reader.SpineCount();
            if (frames > 0) timelines++;
            for (var i = 0; i < frames; i++)
            {
                reader.Take(4);
                var changes = reader.SpineCount();
                if (changes > slots) throw new InvalidDataException("Spine 绘制顺序插槽数量越界");
                for (var j = 0; j < changes; j++)
                {
                    Index(slots, "绘制顺序插槽");
                    reader.VarBits();
                }
            }
        }

        void ReadEventTimeline()
        {
            var frames = reader.SpineCount();
            if (frames > 0) timelines++;
            for (var i = 0; i < frames; i++)
            {
                reader.Take(4);
                var audio = audioEvents[Index(audioEvents.Length, "动画事件")];
                reader.VarBits();
                reader.Take(4);
                reader.SpineString();
                if (audio) reader.Take(8);
            }
        }

        bool SkipOptionalString()
        {
            var length = reader.VarUInt();
            reader.Take(Math.Max(0, length - 1));
            return length != 0;
        }

        void StringReference()
        {
            if (reader.VarUInt() > strings) throw new InvalidDataException("Spine 字符串引用越界");
        }

        int Index(int length, string label)
        {
            var index = reader.VarUInt();
            if (index >= length) throw new InvalidDataException($"Spine {label}引用越界，偏移 {reader.Offset}");
            return index;
        }

        void IndexList(int length, string label)
        {
            for (int i = 0, count = reader.SpineCount(); i < count; i++) Index(length, label);
        }

        void SkipVarints(int count)
        {
            if (count > reader.Remaining) throw new InvalidDataException("Spine 网格索引表越界");
            for (var i = 0; i < count; i++) reader.VarUInt();
        }
    }
}

#pragma once
#include <stdexcept>
#include <string>

#ifdef _WIN32
#include <cstring>
#include <limits>
#include <vector>
#include <windows.h>
#include <wincodec.h>
#include <wrl/client.h>

#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "windowscodecs.lib")
#endif

namespace rpgimagecompose {
#ifdef _WIN32
using Microsoft::WRL::ComPtr;

inline void check(HRESULT value, const char* message) {
    if (FAILED(value)) throw std::runtime_error(message);
}

struct Pixels {
    UINT width = 0;
    UINT height = 0;
    std::vector<BYTE> bytes;
};

class PngCodec {
    struct Apartment {
        HRESULT status = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
        Apartment() {
            if (status != RPC_E_CHANGED_MODE) check(status, "无法初始化 PNG 合成线程");
        }
        ~Apartment() { if (SUCCEEDED(status)) CoUninitialize(); }
    } apartment_;
    ComPtr<IWICImagingFactory> factory_;

public:
    PngCodec() {
        check(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER,
              IID_PPV_ARGS(factory_.GetAddressOf())), "无法初始化 PNG 编解码器");
    }

    PngCodec(const PngCodec&) = delete;
    PngCodec& operator=(const PngCodec&) = delete;

    Pixels read(const std::string& png) const {
        if (png.empty() || png.size() > (std::numeric_limits<DWORD>::max)())
            throw std::runtime_error("合成图层的 PNG 数据大小无效");
        ComPtr<IWICStream> stream;
        check(factory_->CreateStream(&stream), "无法创建 PNG 输入流");
        // The decoder and stream are both released before the caller's buffer goes out of scope.
        check(stream->InitializeFromMemory(reinterpret_cast<BYTE*>(const_cast<char*>(png.data())),
              static_cast<DWORD>(png.size())), "无法读取 PNG 数据");
        ComPtr<IWICBitmapDecoder> decoder;
        check(factory_->CreateDecoder(GUID_ContainerFormatPng, nullptr, &decoder), "无法创建 PNG 解码器");
        check(decoder->Initialize(stream.Get(), WICDecodeMetadataCacheOnDemand), "合成图层不是有效 PNG");
        ComPtr<IWICBitmapFrameDecode> frame;
        check(decoder->GetFrame(0, &frame), "无法读取合成图层");
        Pixels result;
        check(frame->GetSize(&result.width, &result.height), "无法读取合成图层尺寸");
        const auto size = static_cast<unsigned long long>(result.width) * result.height;
        if (!size || size > (std::numeric_limits<UINT>::max)() / 4)
            throw std::runtime_error("合成图层尺寸超出可处理范围");
        result.bytes.resize(static_cast<size_t>(size) * 4);
        ComPtr<IWICFormatConverter> converter;
        check(factory_->CreateFormatConverter(&converter), "无法创建 PNG 像素转换器");
        check(converter->Initialize(frame.Get(), GUID_WICPixelFormat32bppBGRA, WICBitmapDitherTypeNone,
              nullptr, 0, WICBitmapPaletteTypeCustom), "无法读取合成图层的颜色和透明度");
        check(converter->CopyPixels(nullptr, result.width * 4, static_cast<UINT>(result.bytes.size()),
              result.bytes.data()), "无法读取合成图层的像素");
        return result;
    }

    std::string write(Pixels& image) const {
        ComPtr<IStream> stream;
        check(CreateStreamOnHGlobal(nullptr, TRUE, &stream), "无法创建 PNG 输出流");
        ComPtr<IWICBitmapEncoder> encoder;
        check(factory_->CreateEncoder(GUID_ContainerFormatPng, nullptr, &encoder), "无法创建 PNG 编码器");
        check(encoder->Initialize(stream.Get(), WICBitmapEncoderNoCache), "无法初始化 PNG 输出");
        ComPtr<IWICBitmapFrameEncode> frame;
        check(encoder->CreateNewFrame(&frame, nullptr), "无法创建 PNG 输出图层");
        check(frame->Initialize(nullptr), "无法初始化 PNG 输出图层");
        check(frame->SetSize(image.width, image.height), "无法设置合成图尺寸");
        auto format = GUID_WICPixelFormat32bppBGRA;
        check(frame->SetPixelFormat(&format), "无法设置合成图像素格式");
        if (!IsEqualGUID(format, GUID_WICPixelFormat32bppBGRA)) throw std::runtime_error("PNG 编码器不支持透明图层");
        check(frame->WritePixels(image.height, image.width * 4, static_cast<UINT>(image.bytes.size()),
              image.bytes.data()), "无法写入合成图像素");
        check(frame->Commit(), "无法保存合成图层");
        check(encoder->Commit(), "无法保存合成 PNG");
        STATSTG stat{};
        check(stream->Stat(&stat, STATFLAG_NONAME), "无法读取合成图大小");
        const auto length = stat.cbSize.QuadPart;
        if (!length || length > (std::numeric_limits<ULONG>::max)()) throw std::runtime_error("合成图大小无效");
        std::string png(static_cast<size_t>(length), '\0');
        check(stream->Seek(LARGE_INTEGER{}, STREAM_SEEK_SET, nullptr), "无法定位合成图");
        ULONG count = 0;
        check(stream->Read(png.data(), static_cast<ULONG>(length), &count), "无法读取合成图数据");
        if (count != length) throw std::runtime_error("合成图数据不完整");
        return png;
    }
};
#endif

inline std::string combine(const std::string& original, const std::string& mosaic, const std::string& translation) {
    if (mosaic == translation || mosaic == original) return translation;
    if (translation == original) return mosaic;
#ifdef _WIN32
    const PngCodec codec;
    const auto source = codec.read(original);
    const auto text = codec.read(translation);
    auto base = codec.read(mosaic);
    if (source.width != text.width || source.height != text.height ||
        source.width != base.width || source.height != base.height)
        throw std::runtime_error("去码图、译图和原图的尺寸必须一致");
    // The translation is a full image. Only its changes from the shared original go on top of the mosaic repair.
    for (size_t offset = 0; offset < base.bytes.size(); offset += 4) {
        if (!source.bytes[offset + 3] && !text.bytes[offset + 3]) continue;
        if (std::memcmp(source.bytes.data() + offset, text.bytes.data() + offset, 4) != 0)
            std::memcpy(base.bytes.data() + offset, text.bytes.data() + offset, 4);
    }
    return codec.write(base);
#else
    throw std::runtime_error("自动合成去码图和译图需要 Windows");
#endif
}
}

#include "FileRoutes.h"
#include "HttpRouter.h"
#include "TextRoutes.h"
#include "RuntimeAssets.h"
#include "StoragePaths.h"
#include "Utf8Path.h"

#include <cstdint>
#include <exception>
#include <filesystem>
#include <string>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <shellapi.h>
#include <shlobj.h>
#include <objbase.h>
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "shell32.lib")
#endif

namespace http_router
{
using json = nlohmann::json;
namespace fs = std::filesystem;

namespace
{
#ifdef _WIN32
bool selectFileInExplorer(const fs::path& path)
{
    const std::wstring fullPath = fs::absolute(path).make_preferred().wstring();
    const HRESULT initialized = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    if (FAILED(initialized) && initialized != RPC_E_CHANGED_MODE) return false;

    PIDLIST_ABSOLUTE file = nullptr;
    HRESULT result = SHParseDisplayName(fullPath.c_str(), nullptr, &file, 0, nullptr);
    if (SUCCEEDED(result)) result = SHOpenFolderAndSelectItems(file, 0, nullptr, 0);
    CoTaskMemFree(file);
    if (SUCCEEDED(initialized)) CoUninitialize();
    return SUCCEEDED(result);
}
#endif
}

void registerRuntimeAssetRoute(httplib::Server& svr)
{
    svr.Get(R"(/api/runtime-assets/(.+))", withCors([](const httplib::Request& req, httplib::Response& res) {
        const auto file = runtime_assets::resolve(storage::base / "resources" / "web-assets", req.matches[1].str());
        if (file.empty())
        {
            res.status = 404;
            res.set_content(errorJson("软件资源文件不存在，请重新构建并更新软件").dump(), "application/json");
            return;
        }
        res.set_header("Cache-Control", "no-store");
        res.set_file_content(utf8path::pathUtf8(file), runtime_assets::contentType(file));
    }));
}

void registerFileOpenRoutes(httplib::Server& svr)
{
    svr.Post("/api/reveal-path", withCors([](const httplib::Request& req, httplib::Response& res) {
        try
        {
            const json body = json::parse(req.body);
            if (!body.contains("path") || !body["path"].is_string())
            {
                res.status = 400;
                res.set_content(errorJson("缺少 path").dump(), "application/json");
                return;
            }
            // JSON paths are UTF-8. fs::path(std::string) on Windows uses ACP/GBK and
            // breaks 中文/日文/(括号) folders — falsely returning "路径不存在".
            const fs::path target = utf8path::pathFromUtf8(body["path"].get<std::string>());
#ifdef _WIN32
            const std::wstring wideTarget = target.wstring();
            const DWORD attrs = GetFileAttributesW(wideTarget.c_str());
            if (attrs == INVALID_FILE_ATTRIBUTES)
            {
                res.status = 404;
                res.set_content(errorJson("路径不存在").dump(), "application/json");
                return;
            }
            const bool directory = (attrs & FILE_ATTRIBUTE_DIRECTORY) != 0;
            const bool opened = directory
                ? reinterpret_cast<intptr_t>(ShellExecuteW(nullptr, nullptr, wideTarget.c_str(), nullptr, nullptr, SW_SHOWNORMAL)) > 32
                : selectFileInExplorer(target);
            if (!opened)
            {
                res.status = 500;
                res.set_content(errorJson(directory ? "无法打开文件夹" : "无法在文件夹中定位文件").dump(), "application/json");
                return;
            }
#else
            std::error_code ec;
            if (!fs::exists(target, ec))
            {
                res.status = 404;
                res.set_content(errorJson("路径不存在").dump(), "application/json");
                return;
            }
            const fs::path openPath = fs::is_directory(target, ec) ? target : target.parent_path();
            (void)openPath;
            res.status = 501;
            res.set_content(errorJson("当前平台不支持打开文件夹").dump(), "application/json");
            return;
#endif
            res.set_content(json{{"ok", true}}.dump(), "application/json");
        }
        catch (const std::exception& ex)
        {
            res.status = 400;
            res.set_content(errorJson(ex.what()).dump(), "application/json");
        }
    }));

    svr.Post("/api/open-path", withCors([](const httplib::Request& req, httplib::Response& res) {
        try
        {
            const json body = json::parse(req.body);
            if (!body.contains("path") || !body["path"].is_string())
            {
                res.status = 400;
                res.set_content(errorJson("缺少 path").dump(), "application/json");
                return;
            }
            const std::string pathUtf8 = body["path"].get<std::string>();
            // http(s) links (e.g. GitHub README) — do not treat as filesystem paths.
            if (pathUtf8.rfind("http://", 0) == 0 || pathUtf8.rfind("https://", 0) == 0)
            {
#ifdef _WIN32
                const std::wstring wideUrl = utf8path::toWide(pathUtf8);
                const HINSTANCE hi = ShellExecuteW(
                    nullptr,
                    L"open",
                    wideUrl.c_str(),
                    nullptr,
                    nullptr,
                    SW_SHOWNORMAL);
                if (reinterpret_cast<intptr_t>(hi) <= 32)
                {
                    res.status = 500;
                    res.set_content(errorJson("无法打开链接").dump(), "application/json");
                    return;
                }
                res.set_content(json{{"ok", true}}.dump(), "application/json");
#else
                res.status = 501;
                res.set_content(errorJson("当前平台不支持打开链接").dump(), "application/json");
#endif
                return;
            }
            // Same UTF-8 rule as /api/reveal-path: never construct fs::path from ACP string.
            const fs::path target = utf8path::pathFromUtf8(pathUtf8);
#ifdef _WIN32
            const std::wstring wideTarget = target.wstring();
            const DWORD attrs = GetFileAttributesW(wideTarget.c_str());
            if (attrs == INVALID_FILE_ATTRIBUTES)
            {
                res.status = 404;
                res.set_content(
                    errorJson("文件不存在（可能尚未安装翻译插件或未保存配置）").dump(),
                    "application/json");
                return;
            }
            const HINSTANCE hi = ShellExecuteW(
                nullptr,
                L"open",
                wideTarget.c_str(),
                nullptr,
                nullptr,
                SW_SHOWNORMAL);
            if (reinterpret_cast<intptr_t>(hi) <= 32)
            {
                res.status = 500;
                res.set_content(errorJson("无法打开文件").dump(), "application/json");
                return;
            }
            res.set_content(json{{"ok", true}}.dump(), "application/json");
#else
            (void)target;
            res.status = 501;
            res.set_content(errorJson("当前平台不支持打开文件").dump(), "application/json");
#endif
        }
        catch (const std::exception& ex)
        {
            res.status = 400;
            res.set_content(errorJson(ex.what()).dump(), "application/json");
        }
    }));
}

void registerExportFileRoute(httplib::Server& svr)
{
    svr.Post("/api/export-file", withCors([](const httplib::Request& req, httplib::Response& res) {
        try
        {
            const json body = json::parse(req.body);
            if (!body.contains("path") || !body.contains("content"))
            {
                res.status = 400;
                res.set_content(errorJson("缺少 path / content").dump(), "application/json");
                return;
            }
            const fs::path outPath = utf8path::pathFromUtf8(body["path"].get<std::string>());
            if (!outPath.is_absolute())
            {
                res.status = 400;
                res.set_content(errorJson("导出路径必须是绝对路径").dump(), "application/json");
                return;
            }
            if (outPath.has_parent_path())
            {
                fs::create_directories(outPath.parent_path());
            }
            writeFileUtf8(outPath, body["content"].get<std::string>());
            res.set_content(json{
                {"ok", true},
                {"path", utf8path::pathUtf8(outPath)},
            }.dump(), "application/json");
        }
        catch (const std::exception& ex)
        {
            res.status = 400;
            res.set_content(errorJson(ex.what()).dump(), "application/json");
        }
    }));
}

}

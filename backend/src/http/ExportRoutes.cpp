#include "ExportRoutes.h"
#include "HttpRouter.h"
#include "GameImageExportPackage.h"
#include "GameImageExportConfirmation.h"
#include "GameImageExportTransaction.h"

#ifdef _WIN32
#include "GameImageExportIO.h"

#include <chrono>
#include <condition_variable>
#include <deque>
#include <iterator>
#include <memory>
#include <mutex>
#include <thread>

namespace http_router {
namespace {

namespace export_game = gameimageexport;
namespace transaction = export_game::transaction;
using namespace gameimageexport::io;
using export_game::Error;

void send(httplib::Response& response, int status, const Json& value) {
    response.status = status;
    response.set_content(value.dump(), "application/json");
}

Json failure(const Error& error) {
    Json value{{"code", error.code}, {"message", error.what()}};
    if (!error.detail.empty()) value["detail"] = error.detail;
    return value;
}

int httpStatus(const std::string& code) {
    if (code == "PACKAGE_NOT_FOUND" || code == "OPERATION_NOT_FOUND" || code == "RECEIPT_NOT_FOUND") return 404;
    if (code == "BUSY" || code == "OPERATION_LIMIT") return 429;
    if (code == "PERMISSION_DENIED") return 403;
    if (code == "ALREADY_APPLIED" || code == "OPERATION_CONFLICT" || code == "TARGET_CHANGED" ||
        code == "RECOVERY_REQUIRED" || code == "PACKAGE_IN_USE" || code == "BACKUP_MISSING" ||
        code == "BACKUP_CORRUPT" || code == "CANCEL_TOO_LATE" || code == "OUTPUT_EXISTS" ||
        code == "LEGACY_PATCH_ACTIVE" || code == "BASELINE_MISMATCH") return 409;
    if (code.starts_with("INVALID_") || code == "UNSUPPORTED_SCHEMA" || code == "UNSUPPORTED_COMPOSE_RULE" ||
        code == "UNSUPPORTED_ENGINE" || code == "WOLF_ARCHIVE_ENTRY_UNSUPPORTED" ||
        code == "CONFIRMATION_REQUIRED" || code == "INPUT_STALE" || code == "FINGERPRINT_MISMATCH" ||
        code == "PAYLOAD_LIST_MISMATCH" || code == "PAYLOAD_HASH_MISMATCH" || code == "NO_OUTPUT" ||
        code == "IMAGE_TOO_LARGE" || code == "INPUT_TOO_LARGE" || code == "OUTPUT_TOO_LARGE") return 400;
    return 500;
}

Json errorResponse(const Error& error) {
    auto value = errorJson(error.what());
    value["error"] = failure(error);
    return value;
}

template<class Call>
auto exportHandler(Call call) {
    return [call = std::move(call)](const httplib::Request& request, httplib::Response& response) {
        try {
            call(request, response);
        } catch (const Error& error) {
            send(response, httpStatus(error.code), errorResponse(error));
        } catch (const Json::exception&) {
            send(response, 400, errorResponse(Error("INVALID_REQUEST", "导出请求 JSON 或字段无效")));
        } catch (const fs::filesystem_error& error) {
            const auto code = error.code() == std::errc::permission_denied ? "PERMISSION_DENIED" : "IO_ERROR";
            send(response, httpStatus(code), errorResponse(Error(code, error.what())));
        } catch (const std::exception& error) {
            send(response, 500, errorResponse(Error("IO_ERROR", error.what())));
        }
    };
}

struct Location {
    Path path;
    std::string identity;
};

Path absolutePath(const std::string& text) {
    if (text.find('\0') != std::string::npos)
        throw Error("INVALID_PATH", "路径含空字符");
    const auto path = utf8path::pathFromUtf8(text);
    if (!path.is_absolute() || path.native().starts_with(L"\\\\?\\") || path.native().starts_with(L"\\\\.\\"))
        throw Error("INVALID_PATH", "请选择普通绝对目录路径", text);
    const auto root = path.root_name().native();
    if (!root.starts_with(L"\\\\") &&
        (root.size() != 2 || root[1] != L':' || !((root[0] >= L'A' && root[0] <= L'Z') ||
            (root[0] >= L'a' && root[0] <= L'z'))))
        throw Error("INVALID_PATH", "无效的目录盘符", text);
    for (const auto& part : path.relative_path())
        if (!part.empty() && !validComponent(part.native()))
            throw Error("INVALID_PATH", "目录含有父路径、数据流或非法路径段", text);
    return path;
}

Location locate(const Json& body, const char* field, bool package = false) {
    const auto path = absolutePath(body.at(field).get<std::string>());
    if (package) {
        if (path.extension() != L".llmchat-images")
            throw Error("INVALID_PATH", "请选择 .llmchat-images 成品包目录", utf8(path));
        const auto attributes = GetFileAttributesW(path.c_str());
        if (attributes == INVALID_FILE_ATTRIBUTES) {
            const auto status = GetLastError();
            if (status == ERROR_FILE_NOT_FOUND || status == ERROR_PATH_NOT_FOUND)
                throw Error("PACKAGE_NOT_FOUND", "成品包目录不存在", utf8(path));
            winError(status == ERROR_ACCESS_DENIED ? "PERMISSION_DENIED" : "IO_ERROR",
                "无法读取成品包目录", path, status);
        }
    }
    const Root root(path);
    return {root.path, root.ids.back()};
}

Json readJson(const Path& root, const Path& name, const char* code, uint64_t limit = maxMetadataBytes) {
    const auto handle = openSource(root, name, true);
    if (!handle) throw Error(code, "找不到导出记录", gamefiles::key(name));
    if (length(handle, root / name) > limit)
        throw Error(code, "导出记录超出允许大小", gamefiles::key(name));
    try {
        return Json::parse(read(handle, root / name, limit));
    } catch (const Json::exception&) {
        throw Error(code, "导出记录 JSON 无效", gamefiles::key(name));
    }
}

export_game::LayerSelection readLayer(const Json& image, const char* name, const char* version) {
    const auto& layer = image.at(name);
    const auto id = layer.at("confirmationId").get<std::string>();
    auto revision = layer.at(version).get<std::string>();
    if (!uuid(id) || revision.empty() ||
        (std::string_view(name) == "mosaic" && (revision.size() != 64 || !hexString(revision))))
        throw Error("INVALID_REQUEST", "图层确认编号或版本无效");
    return {id, std::move(revision)};
}

export_game::Request generationInput(const Json& body, const Location& game, const Location& output) {
    const auto& images = body.at("images");
    if (!images.is_array() || images.empty() || images.size() > 20000)
        throw Error("INVALID_REQUEST", "请指定要导出的图片");
    export_game::Request request{game.path, output.path, "0.1.0", {}};
    std::set<std::string> ids;
    for (const auto& image : images) {
        const auto id = image.at("imageId").get<std::string>();
        const auto source = image.at("sourceHash").get<std::string>();
        if (id.size() > 16 || !hexString(id) || !ids.insert(id).second ||
            source.empty() || source.size() > 60 || source.find_first_not_of("0123456789-") != std::string::npos)
            throw Error("INVALID_REQUEST", "图片编号重复或原图版本无效", id);
        export_game::ImageSelection selected{id, source, {}, {}};
        if (image.contains("translation")) selected.translation = readLayer(image, "translation", "renderedHash");
        if (image.contains("mosaic")) selected.mosaic = readLayer(image, "mosaic", "pngSha256");
        if (!selected.translation && !selected.mosaic)
            throw Error("INVALID_REQUEST", "图片缺少已确认的图层", id);
        request.images.push_back(std::move(selected));
    }
    return request;
}

void checkConfirmation(const Path& game, const export_game::ImageSelection& image,
    const char* layer, const export_game::LayerSelection& selected) {
    const auto metadata = Path("LLMChat-JSON/images/export-inputs") / image.imageId / (std::string(layer) + ".json");
    if (!openSource(game, metadata, true))
        throw Error("CONFIRMATION_REQUIRED", "缺少确认快照，请重新确认图片版本", image.imageId);
    const auto record = readJson(game, metadata, "INPUT_STALE");
    if (!record.contains("recordVersion") || !record.at("recordVersion").is_number_integer() ||
        record.at("recordVersion") != 1 || !record.contains("sourceSha256"))
        throw Error("CONFIRMATION_REQUIRED", "旧确认记录需要重新确认", image.imageId);
    try {
        const auto digest = record.at("pngSha256").get<std::string>();
        const auto& group = record.at("groupId");
        const auto mode = record.at("maskMode").get<std::string>();
        const auto& boxes = record.at("boxes");
        if (record.at("confirmationId") != selected.confirmationId || record.at("candidateVersion") != selected.version ||
            record.at("imageId") != image.imageId || record.at("sourceHash") != image.sourceHash ||
            (record.contains("layer") && record.at("layer") != layer) || digest.size() != 64 || !hexString(digest) ||
            (!group.is_null() && !group.is_string()) || !boxes.is_array() ||
            (mode != "boxes" && mode != "whole-image"))
            throw Error("INPUT_STALE", "确认快照已变化或格式无效", image.imageId);
    } catch (const Json::exception&) {
        throw Error("INPUT_STALE", "确认快照字段缺失或格式无效", image.imageId);
    }
}

void checkGeneration(const export_game::Request& request) {
    const Root game(request.gamePath);
    const Root output(request.outputDir);
    if (std::find(game.ids.begin(), game.ids.end(), output.ids.back()) != game.ids.end() ||
        std::find(output.ids.begin(), output.ids.end(), game.ids.back()) != output.ids.end())
        throw Error("INVALID_PATH", "输出目录与游戏目录必须互不包含", utf8(output.path));
    for (const auto& image : request.images) {
        if (image.translation) checkConfirmation(game.path, image, "translation", *image.translation);
        if (image.mosaic) checkConfirmation(game.path, image, "mosaic", *image.mosaic);
    }
}

enum class Operation { Generate, Apply, Restore, Remove };
using Clock = std::chrono::steady_clock;

class Jobs;
struct Job;
using Action = std::function<Json(Jobs&, Job&)>;

struct Job {
    std::string id;
    Operation operation;
    std::string game;
    std::string directory;
    std::string state = "queued";
    size_t sequence = 0;
    Json progress = nullptr;
    Json result = nullptr;
    Json error = nullptr;
    Clock::time_point finished{};
    bool cancelRequested = false;
    bool acceptsCancel;
    Action action;
};

class Jobs {
    using JobPtr = std::shared_ptr<Job>;
    std::mutex mutex_;
    std::condition_variable_any ready_;
    std::map<std::string, JobPtr> jobs_;
    std::deque<JobPtr> queue_;
    std::jthread worker_;

    void prune() {
        const auto now = Clock::now();
        std::erase_if(jobs_, [&](const auto& entry) {
            return entry.second->finished != Clock::time_point{} &&
                now - entry.second->finished > std::chrono::minutes(30);
        });
    }

    JobPtr reserve(Operation operation, const std::string& game, const std::string& directory) {
        std::lock_guard lock(mutex_);
        prune();
        size_t active = 0;
        for (const auto& [id, job] : jobs_) {
            if (job->finished != Clock::time_point{}) continue;
            ++active;
            if (job->directory == directory && operation == Operation::Apply && job->operation != Operation::Generate)
                throw Error("OPERATION_CONFLICT", "成品包已有操作进行中");
            if (job->directory == directory || (!game.empty() && job->game == game))
                throw Error("BUSY", "游戏或成品目录已在处理");
        }
        if (active >= 4 || jobs_.size() >= 128)
            throw Error("OPERATION_LIMIT", "导出任务达到上限，请稍后重试");
        const auto id = newId();
        auto job = std::make_shared<Job>();
        job->id = id;
        job->operation = operation;
        job->game = game;
        job->directory = directory;
        job->acceptsCancel = operation == Operation::Generate;
        jobs_.emplace(id, job);
        return job;
    }

    void forget(const JobPtr& job) {
        std::lock_guard lock(mutex_);
        jobs_.erase(job->id);
    }

    const JobPtr& find(const std::string& id) const {
        const auto found = jobs_.find(id);
        if (found == jobs_.end()) throw Error("OPERATION_NOT_FOUND", "导出任务不存在", id);
        return found->second;
    }

    void finish(Job& job, const char* state, Json result, Json error) {
        std::lock_guard lock(mutex_);
        job.state = state;
        job.result = std::move(result);
        job.error = std::move(error);
        job.acceptsCancel = false;
        job.finished = Clock::now();
        ++job.sequence;
    }

    void run(std::stop_token stopped) {
        while (!stopped.stop_requested()) {
            JobPtr job;
            Action action;
            {
                std::unique_lock lock(mutex_);
                if (!ready_.wait(lock, stopped, [&] { return !queue_.empty(); }) || stopped.stop_requested()) return;
                job = std::move(queue_.front());
                queue_.pop_front();
                action = std::move(job->action);
                if (!job->cancelRequested) job->state = "running";
                ++job->sequence;
            }
            try {
                if (cancelled(*job)) throw Error("CANCELLED", "已取消生成成品");
                auto result = action(*this, *job);
                finish(*job, "succeeded", std::move(result), nullptr);
            } catch (const Error& error) {
                finish(*job, error.code == "CANCELLED" ? "cancelled" : "failed", nullptr, failure(error));
            } catch (const std::exception& error) {
                finish(*job, "failed", nullptr, failure(Error("IO_ERROR", error.what())));
            }
        }
    }

public:
    Jobs() : worker_([this](std::stop_token stopped) { run(stopped); }) {}

    template<class Preflight>
    std::string submit(Operation operation, const Location& game, const Location& directory,
        Preflight preflight, Action action) {
        auto job = reserve(operation, game.identity, directory.identity);
        try {
            preflight();
            std::lock_guard lock(mutex_);
            job->action = std::move(action);
            queue_.push_back(job);
        } catch (...) {
            forget(job);
            throw;
        }
        ready_.notify_one();
        return job->id;
    }

    void remove(const Location& package) {
        auto job = reserve(Operation::Remove, {}, package.identity);
        try {
            transaction::remove(package.path);
        } catch (...) {
            forget(job);
            throw;
        }
        forget(job);
    }

    Json status(const std::string& id) {
        std::lock_guard lock(mutex_);
        prune();
        const auto& job = *find(id);
        return {{"operationId", job.id}, {"state", job.state}, {"lastSeq", job.sequence},
            {"progress", job.progress}, {"result", job.result}, {"error", job.error}};
    }

    bool cancel(const std::string& id) {
        std::lock_guard lock(mutex_);
        prune();
        auto& job = *find(id);
        if (job.state == "cancelled") return true;
        if (!job.acceptsCancel) throw Error("CANCEL_TOO_LATE", "此导出任务当前不可取消", id);
        if (!job.cancelRequested) {
            job.cancelRequested = true;
            job.state = "cancelling";
            ++job.sequence;
        }
        return false;
    }

    bool cancelled(const Job& job) {
        std::lock_guard lock(mutex_);
        return job.cancelRequested;
    }

    void progress(Job& job, const export_game::Progress& value) {
        std::lock_guard lock(mutex_);
        if (value.phase == "publish") job.acceptsCancel = false;
        job.progress = {{"phase", value.phase}, {"completed", value.completed}, {"total", value.total},
            {"relativePath", value.relativePath}};
        ++job.sequence;
    }
};

void queued(httplib::Response& response, const std::string& operationId) {
    send(response, 202, {{"operationId", operationId}, {"state", "queued"}});
}

Json persistedReceipt(const Path& package) {
    const Root root(package);
    return readJson(root.path, L"receipts/receipt.json", "INVALID_RECEIPT", 64ull << 20);
}

} // namespace

void registerExportRoutes(httplib::Server& svr, RpgImageProject& gameImages) {
    const auto jobs = std::make_shared<Jobs>();

    svr.Post("/api/game-image-exports/confirm", withCors(exportHandler([&gameImages](const auto& req, auto& res) {
        const auto body = Json::parse(req.body);
        const auto game = locate(body, "gamePath");
        send(res, 200, export_game::confirmation::save(gameImages, game.path, body));
    })));

    svr.Post("/api/game-image-exports/confirmation-status", withCors(exportHandler([&gameImages](const auto& req, auto& res) {
        const auto body = Json::parse(req.body);
        const auto game = locate(body, "gamePath");
        send(res, 200, export_game::confirmation::status(gameImages, game.path, body));
    })));

    svr.Post("/api/game-image-exports/generate", withCors(exportHandler([jobs, &gameImages](const auto& req, auto& res) {
        const auto body = Json::parse(req.body);
        const auto game = locate(body, "gamePath");
        const auto output = locate(body, "outputDir");
        const auto input = std::make_shared<const export_game::Request>(generationInput(body, game, output));
        queued(res, jobs->submit(Operation::Generate, game, output,
            [input] { checkGeneration(*input); },
            [input, &gameImages](Jobs& active, Job& job) -> Json {
                const auto result = export_game::generate(gameImages, *input, {
                    [&] { return active.cancelled(job); },
                    [&](const auto& state) { active.progress(job, state); },
                });
                return {{"packageId", result.packageId}, {"packagePath", gamefiles::key(result.packagePath)},
                    {"manifestSha256", result.manifestSha256}, {"files", result.files}, {"skipped", result.skipped}};
            }));
    })));

    svr.Get(R"(/api/game-image-exports/operations/([^/]+))", withCors(exportHandler([jobs](const auto& req, auto& res) {
        send(res, 200, jobs->status(req.matches[1].str()));
    })));

    svr.Post(R"(/api/game-image-exports/operations/([^/]+)/cancel)", withCors(exportHandler([jobs](const auto& req, auto& res) {
        const auto cancelled = jobs->cancel(req.matches[1].str());
        send(res, cancelled ? 200 : 202, {{"state", cancelled ? "cancelled" : "cancelling"}});
    })));

    svr.Post("/api/game-image-exports/apply", withCors(exportHandler([jobs](const auto& req, auto& res) {
        const auto body = Json::parse(req.body);
        const auto package = locate(body, "packagePath", true);
        const auto game = locate(body, "gamePath");
        queued(res, jobs->submit(Operation::Apply, game, package,
            [&] { transaction::checkApply(package.path, game.path); },
            [game, package](Jobs&, Job&) {
                transaction::apply(package.path, game.path);
                return persistedReceipt(package.path);
            }));
    })));

    svr.Post("/api/game-image-exports/restore", withCors(exportHandler([jobs](const auto& req, auto& res) {
        const auto body = Json::parse(req.body);
        const auto package = locate(body, "packagePath", true);
        const auto game = locate(body, "gamePath");
        transaction::RestoreKinds kinds;
        if (body.contains("kinds")) {
            const auto& values = body.at("kinds");
            if (!values.is_array() || values.empty() ||
                !std::all_of(values.begin(), values.end(), [](const Json& value) { return value.is_string(); }))
                throw Error("INVALID_KINDS", "kinds 必须是非空字符串数组，整包恢复请省略");
            kinds = values.get<std::vector<std::string>>();
        }
        auto rollback = std::make_shared<Json>();
        queued(res, jobs->submit(Operation::Restore, game, package,
            [&] {
                auto state = transaction::inspect(package.path, game.path, kinds);
                if (state.restoreError) throw *state.restoreError;
                if (state.receipt.is_null() && state.rollbackReceipt.is_null()) {
                    if (state.needsRecovery) transaction::recover(package.path, game.path);
                    throw Error("RECEIPT_NOT_FOUND", "此成品包没有可以恢复的应用记录");
                }
                *rollback = std::move(state.rollbackReceipt);
            },
            [game, package, rollback, kinds](Jobs&, Job&) {
                if (!rollback->is_null()) {
                    if (transaction::recover(package.path, game.path) != transaction::Recovery::RolledBack)
                        throw Error("RECOVERY_REQUIRED", "成品包状态已变化，请重新查询后恢复");
                    if (kinds) {
                        (*rollback)["restoredAsFullPackage"] = true;
                        (*rollback)["warning"] = "应用中断且尚无收据，已按整包回滚";
                    }
                    return std::move(*rollback);
                }
                return transaction::restore(package.path, game.path, kinds);
            }));
    })));

    svr.Post("/api/game-image-exports/receipts/query", withCors(exportHandler([](const auto& req, auto& res) {
        const auto body = Json::parse(req.body);
        const auto package = locate(body, "packagePath", true);
        const auto game = locate(body, "gamePath");
        auto status = transaction::inspect(package.path, game.path);
        if (status.restoreError && status.restoreError->code == "INVALID_RECEIPT") throw *status.restoreError;
        auto value = status.receipt.is_null() ? errorResponse(Error("RECEIPT_NOT_FOUND", "成品包尚无收据")) :
            Json{{"receipt", status.receipt}};
        value["applied"] = status.applied;
        value["canRestore"] = status.canRestore;
        value["needsRecovery"] = status.needsRecovery;
        value["layerRestoreSupported"] = status.layerRestoreSupported;
        value["layers"] = std::move(status.layers);
        send(res, status.receipt.is_null() ? 404 : 200, value);
    })));

    svr.Post("/api/game-image-exports/remove", withCors(exportHandler([jobs](const auto& req, auto& res) {
        const auto body = Json::parse(req.body);
        jobs->remove(locate(body, "packagePath", true));
        res.status = 204;
    })));
}

} // namespace http_router

#else
namespace http_router {
void registerExportRoutes(httplib::Server&, RpgImageProject&) {}
}
#endif

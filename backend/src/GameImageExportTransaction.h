#pragma once

#include "GameImageExportPackage.h"
#include <nlohmann/json.hpp>

namespace gameimageexport::transaction {

enum class ApplyPhase { BeforeReplace, BeforeReceipt, BeforeReceiptPublish, BeginMutation, CommitReceipt };

struct ApplyControl {
    // Called synchronously. Throwing aborts the operation and triggers rollback.
    std::function<void(ApplyPhase, size_t)> checkpoint;
    std::function<bool()> cancelRequested;
};

enum class Recovery { Clean, Applied, RolledBack, Restored, PartiallyRestored };

using RestoreKinds = std::optional<std::vector<std::string>>;

// Errors are reported as gameimageexport::Error, with a stable code and detail.
nlohmann::json apply(const std::filesystem::path& packageDir, const std::filesystem::path& gameRoot,
    const ApplyControl& control = {});
nlohmann::json restore(const std::filesystem::path& packageDir, const std::filesystem::path& gameRoot,
    const RestoreKinds& kinds = std::nullopt, const ApplyControl& control = {});
Recovery recover(const std::filesystem::path& packageDir, const std::filesystem::path& gameRoot,
    const ApplyControl& control = {});

struct PackageStatus {
    nlohmann::json receipt = nullptr;
    // Recovery returns this verified plan-derived result if apply never committed a receipt.
    nlohmann::json rollbackReceipt = nullptr;
    bool applied = false;
    bool canRestore = false;
    bool needsRecovery = false;
    bool layerRestoreSupported = false;
    nlohmann::json layers = nlohmann::json::object();
    std::optional<Error> restoreError;
};

void checkApply(const std::filesystem::path& packageDir, const std::filesystem::path& gameRoot);
PackageStatus inspect(const std::filesystem::path& packageDir, const std::filesystem::path& gameRoot,
    const RestoreKinds& kinds = std::nullopt);

// Active and interrupted packages must be restored/recovered first.
void remove(const std::filesystem::path& packageDir);
nlohmann::json restoreAndRemove(const std::filesystem::path& packageDir,
    const std::optional<std::filesystem::path>& gameRoot, const ApplyControl& control = {});
std::optional<uint64_t> packageBytes(const std::filesystem::path& packageDir);

nlohmann::json scanLegacy(RpgImageProject& project, const std::filesystem::path& gameRoot);
nlohmann::json migrateLegacy(RpgImageProject& project, const std::filesystem::path& gameRoot,
    const std::filesystem::path& outputDir, const nlohmann::json& entries, const Control& control = {});
void validateLegacyEntries(const nlohmann::json& entries);

} // namespace gameimageexport::transaction

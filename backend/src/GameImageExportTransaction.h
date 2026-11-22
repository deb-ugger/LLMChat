#pragma once

#include "GameImageExportPackage.h"
#include <nlohmann/json.hpp>

namespace gameimageexport::transaction {

enum class ApplyPhase { BeforeReplace, BeforeReceipt, BeforeReceiptPublish };

struct ApplyControl {
    // Called synchronously. Throwing aborts the operation and triggers rollback.
    std::function<void(ApplyPhase, size_t)> checkpoint;
};

enum class Recovery { Clean, Applied, RolledBack, Restored };

// Errors are reported as gameimageexport::Error, with a stable code and detail.
void apply(const std::filesystem::path& packageDir, const std::filesystem::path& gameRoot,
    const ApplyControl& control = {});
void restore(const std::filesystem::path& packageDir, const std::filesystem::path& gameRoot);
Recovery recover(const std::filesystem::path& packageDir, const std::filesystem::path& gameRoot);

struct PackageStatus {
    nlohmann::json receipt = nullptr;
    // Recovery returns this verified plan-derived result if apply never committed a receipt.
    nlohmann::json rollbackReceipt = nullptr;
    bool applied = false;
    bool canRestore = false;
    bool needsRecovery = false;
    std::optional<Error> restoreError;
};

void checkApply(const std::filesystem::path& packageDir, const std::filesystem::path& gameRoot);
PackageStatus inspect(const std::filesystem::path& packageDir, const std::filesystem::path& gameRoot);

// Active and interrupted packages must be restored/recovered first.
void remove(const std::filesystem::path& packageDir);

} // namespace gameimageexport::transaction

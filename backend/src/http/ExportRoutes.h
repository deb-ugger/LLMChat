#pragma once

#include <cstddef>
#include <functional>

namespace gameimageexport::transaction { enum class ApplyPhase; }
class RpgImageProject;
namespace httplib { class Server; }

namespace http_router {
using ExportCheckpoint = std::function<void(gameimageexport::transaction::ApplyPhase, size_t)>;
void registerExportRoutes(httplib::Server& svr, RpgImageProject& gameImages, const ExportCheckpoint& checkpoint = {});
}

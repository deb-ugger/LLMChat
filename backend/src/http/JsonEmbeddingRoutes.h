#pragma once

class JsonEmbedding;
namespace httplib { class Server; }

namespace http_router
{
void registerJsonEmbeddingStartRoute(httplib::Server& svr, JsonEmbedding& jsonEmbedding);
void registerJsonEmbeddingPatchDetectionRoute(httplib::Server& svr, JsonEmbedding& jsonEmbedding);
void registerJsonEmbeddingRoutes(httplib::Server& svr, JsonEmbedding& jsonEmbedding);
}

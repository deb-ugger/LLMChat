# LLMChat Backend API

Base URL: `http://127.0.0.1:17800`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/settings` | Read settings |
| PUT | `/api/settings` | Update settings |
| GET | `/api/conversations` | List non-empty conversations |
| POST | `/api/conversations` | Create conversation (clears empty ones) |
| GET | `/api/conversations/:id` | Get conversation + messages |
| DELETE | `/api/conversations/:id` | Delete conversation |
| POST | `/api/conversations/:id/messages` | Append one message |
| POST | `/api/chat` | Append user message, call LLM, append assistant reply |
| POST | `/api/translate` | Translate text (free MyMemory or LLM) |

## POST /api/chat body

```json
{ "conversationId": "...", "content": "hello" }
```

## POST /api/translate body

```json
{ "text": "commonly used" }
```

Response:

```json
{ "ok": true, "source": "...", "translation": "...", "provider": "free" }
```

## Settings

```json
{
  "apiUrl": "https://...",
  "apiKey": "...",
  "model": "deepseek-chat",
  "messagePageSize": 30,
  "port": 17800,
  "translateProvider": "free",
  "translateSource": "en",
  "translateTarget": "zh-CN"
}
```

`translateProvider`: `free` (MyMemory) or `llm` (uses apiUrl/apiKey/model).

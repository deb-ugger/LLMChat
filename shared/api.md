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

## POST /api/chat body

```json
{ "conversationId": "...", "content": "hello" }
```

## Settings

```json
{
  "apiUrl": "https://...",
  "apiKey": "...",
  "model": "deepseek-chat",
  "messagePageSize": 30,
  "port": 17800
}
```

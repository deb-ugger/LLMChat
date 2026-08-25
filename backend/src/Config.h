#pragma once

#include <mutex>
#include <string>

struct AppConfig {
    std::string apiUrl = "https://api.openai.com/v1/chat/completions";
    std::string apiKey;
    std::string model = "gpt-4o";
    int messagePageSize = 30;
    int port = 17800;
    /** auto = system/PAC; direct = no proxy; custom = httpProxy */
    std::string proxyMode = "direct";
    /** e.g. 127.0.0.1:7890 or http://127.0.0.1:7890 */
    std::string httpProxy;
    std::string translateProvider = "bing"; // google|bing|mymemory|...|llm
    std::string translateSource = "en";
    std::string translateTarget = "zh-CN";
    /** LLM model id for literature translate when provider=llm; empty = use model */
    std::string translateModel;
    /** Literature LLM prompt kind: general|academic|technical|custom (legacy / mirrors active id) */
    std::string translatePromptKind = "general";
    /** Active literature prompt id */
    std::string translatePromptId = "general";
    /** JSON array: [{id,tag,prompt}, ...] */
    std::string translatePromptCatalog = "[]";
    /** Literature LLM system prompt (used when provider=llm); synced from active catalog entry */
    std::string translatePrompt =
        "你是一名严谨的双语翻译。请将用户文本忠实翻译为目标语言，"
        "保留原意、语气与段落结构。"
        "不要添加解释、注释，也不要给整段译文加引号。"
        "只输出译文。";
    /** Max chars per translate request; 0 = use engine default */
    int translateMaxLength = 0;      // 0 = engine default
    bool translateAutoChunk = true;  // split long text when limited
    /** LLM literature: include prior N translated segments as context; 0 = off */
    int translateContextParagraphs = 0;
    /** Literature LLM glossary JSON: [{src,dst,info?}] */
    std::string translateGlossary = "[]";
    std::string ocrLang = "eng";
    /** fast = bundled small; precise = medium; english = medium detection + English recognition */
    std::string ocrMode = "fast";
    bool ocrAutoTranslate = true;
    std::string ocrTranslateProvider = "bing";
    std::string ocrTranslateSource = "en";
    std::string ocrTranslateTarget = "zh-CN";
    /** LLM model id for OCR translate when provider=llm; empty = use model */
    std::string ocrTranslateModel;
    int ocrTranslateMaxLength = 0;
    bool ocrTranslateAutoChunk = true;
    /** Text-translate workbench (LLM) */
    std::string textTranslateSource = "en";
    std::string textTranslateTarget = "zh-CN";
    std::string textTranslateProvider = "llm"; // google|bing|...|llm
    /** LLM model id for text translate when provider=llm; empty = use model */
    std::string textTranslateModel;
    std::string textTranslatePrompt =
        "You are a precise bilingual translator for general prose. "
        "Translate the user text faithfully into the target language. "
        "Preserve meaning, tone, paragraph breaks, and markdown/code fences when present. "
        "Do not add explanations, notes, or quotation marks around the whole result. "
        "Output only the translation.";
    std::string textPromptMtool =
        "You are a game and UI localization translator for MTool-style JSON string tables. "
        "Each user message is ONE source string (may be UI label, item name, or short dialogue). "
        "Translate into the target language naturally and concisely. "
        "STRICTLY preserve placeholders and control tokens exactly as written, including: "
        "{0}/{1}/..., %s/%d/%f, %%, \\n, \\t, tags, and similar markup. "
        "Do not invent extra lines or merge multiple entries. "
        "Output only the translated string.";
    std::string textPromptSubtitle =
        "You are a professional subtitle translator for on-screen captions. "
        "The input may be one cue or several consecutive cues of the same utterance. "
        "Translate dialogue into the target language for reading on screen: natural, concise, and timed-friendly. "
        "Keep line breaks if present. Do not add speaker names, timestamps, or notes. "
        "Preserve meaningful punctuation. Output only the translated subtitle text.";
    std::string textPromptSubtitleRetime =
        "You are a professional subtitle translator. "
        "Each input line is already a complete spoken utterance after timeline repair. "
        "Translate into the target language for on-screen captions: fluent, natural, and similar in length when possible. "
        "Do not add speaker names, timestamps, or commentary. "
        "Keep one translated line for one input line. Output only the translation.";
    /** Compact JSON arrays: [{src,dst,info?}] / [{src,dst}] */
    std::string textGlossary = "[]";
    std::string textPreReplace = "[]";
    std::string textPostReplace = "[]";
    /** Empty = <dataDir>/text-projects; relative paths resolve under dataDir */
    std::string textProjectsDir;
    /**
     * JSON: per-engine credentials, e.g.
     * {"baidu":{"appId":"...","secret":"..."},"niutrans":{"apiKey":"..."}}
     */
    std::string translateEngineKeys = "{}";
};

class ConfigStore {
public:
    explicit ConfigStore(std::string path);

    AppConfig snapshot() const;
    bool replace(const AppConfig& next, std::string* error = nullptr);

    void load();
    bool save(std::string* error = nullptr) const;

    const std::string& path() const { return path_; }

private:
    std::string path_;
    mutable std::mutex mutex_;
    AppConfig config_;
};

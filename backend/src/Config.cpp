#include "Config.h"
#include "AtomicFile.h"

#include <algorithm>
#include <cctype>
#include <fstream>
#include <sstream>

namespace {

std::string trim(std::string s)
{
    auto notSpace = [](unsigned char c) { return !std::isspace(c); };
    s.erase(s.begin(), std::find_if(s.begin(), s.end(), notSpace));
    s.erase(std::find_if(s.rbegin(), s.rend(), notSpace).base(), s.end());
    return s;
}

/** Escape multiline / backslash for single-line ini values. */
std::string escapeIniValue(const std::string& s)
{
    std::string out;
    out.reserve(s.size() + 8);
    for (char c : s)
    {
        if (c == '\\')
            out += "\\\\";
        else if (c == '\n')
            out += "\\n";
        else if (c == '\r')
            continue;
        else
            out += c;
    }
    return out;
}

std::string unescapeIniValue(const std::string& s)
{
    std::string out;
    out.reserve(s.size());
    for (size_t i = 0; i < s.size(); ++i)
    {
        if (s[i] == '\\' && i + 1 < s.size())
        {
            const char n = s[i + 1];
            if (n == 'n')
            {
                out += '\n';
                ++i;
                continue;
            }
            if (n == '\\')
            {
                out += '\\';
                ++i;
                continue;
            }
        }
        out += s[i];
    }
    return out;
}

std::string serializeConfig(const AppConfig& config)
{
    std::ostringstream out;
    out << "[General]\n";
    out << "apiUrl=" << config.apiUrl << "\n";
    out << "apiKey=" << config.apiKey << "\n";
    out << "model=" << config.model << "\n";
    out << "messagePageSize=" << config.messagePageSize << "\n";
    out << "port=" << config.port << "\n";
    out << "proxyMode=" << config.proxyMode << "\n";
    out << "httpProxy=" << config.httpProxy << "\n";
    out << "translateProvider=" << config.translateProvider << "\n";
    out << "translateSource=" << config.translateSource << "\n";
    out << "translateTarget=" << config.translateTarget << "\n";
    out << "translateModel=" << config.translateModel << "\n";
    out << "translatePromptId=" << config.translatePromptId << "\n";
    out << "translatePromptCatalog=" << escapeIniValue(config.translatePromptCatalog) << "\n";
    out << "translatePromptKind=" << config.translatePromptKind << "\n";
    out << "translatePrompt=" << escapeIniValue(config.translatePrompt) << "\n";
    out << "translateMaxLength=" << config.translateMaxLength << "\n";
    out << "translateAutoChunk=" << (config.translateAutoChunk ? "true" : "false") << "\n";
    out << "translateClearLineBreaks=" << (config.translateClearLineBreaks ? "true" : "false") << "\n";
    out << "translateContextParagraphs=" << config.translateContextParagraphs << "\n";
    out << "translateGlossary=" << escapeIniValue(config.translateGlossary) << "\n";
    out << "ocrLang=" << config.ocrLang << "\n";
    out << "ocrMode=" << config.ocrMode << "\n";
    out << "imageOcrMode=" << config.imageOcrMode << "\n";
    out << "ocrAutoTranslate=" << (config.ocrAutoTranslate ? "true" : "false") << "\n";
    out << "ocrTranslateProvider=" << config.ocrTranslateProvider << "\n";
    out << "ocrTranslateSource=" << config.ocrTranslateSource << "\n";
    out << "ocrTranslateTarget=" << config.ocrTranslateTarget << "\n";
    out << "ocrTranslateModel=" << config.ocrTranslateModel << "\n";
    out << "ocrTranslateMaxLength=" << config.ocrTranslateMaxLength << "\n";
    out << "ocrTranslateAutoChunk=" << (config.ocrTranslateAutoChunk ? "true" : "false") << "\n";
    out << "textTranslateSource=" << config.textTranslateSource << "\n";
    out << "textTranslateTarget=" << config.textTranslateTarget << "\n";
    out << "textTranslateProvider=" << config.textTranslateProvider << "\n";
    out << "textTranslateModel=" << config.textTranslateModel << "\n";
    out << "textTranslatePrompt=" << escapeIniValue(config.textTranslatePrompt) << "\n";
    out << "textPromptMtool=" << escapeIniValue(config.textPromptMtool) << "\n";
    out << "textPromptSubtitle=" << escapeIniValue(config.textPromptSubtitle) << "\n";
    out << "textPromptSubtitleRetime=" << escapeIniValue(config.textPromptSubtitleRetime) << "\n";
    out << "textGlossary=" << escapeIniValue(config.textGlossary) << "\n";
    out << "textPreReplace=" << escapeIniValue(config.textPreReplace) << "\n";
    out << "textPostReplace=" << escapeIniValue(config.textPostReplace) << "\n";
    out << "textProjectsDir=" << config.textProjectsDir << "\n";
    out << "translateEngineKeys=" << escapeIniValue(config.translateEngineKeys) << "\n";
    return out.str();
}

} // namespace

ConfigStore::ConfigStore(std::string path)
    : path_(std::move(path))
{
    load();
}

void ConfigStore::load()
{
    std::ifstream in(path_);
    if (!in)
    {
        return;
    }

    AppConfig next;

    std::string line;
    while (std::getline(in, line))
    {
        line = trim(line);
        if (line.empty() || line[0] == '#' || line[0] == ';')
        {
            continue;
        }
        if (!line.empty() && line.front() == '[' && line.back() == ']')
        {
            continue;
        }

        const auto eq = line.find('=');
        if (eq == std::string::npos)
        {
            continue;
        }

        const std::string key = trim(line.substr(0, eq));
        const std::string value = trim(line.substr(eq + 1));

        try
        {
            if (key == "apiUrl") next.apiUrl = value;
            else if (key == "apiKey") next.apiKey = value;
            else if (key == "model") next.model = value;
            else if (key == "messagePageSize") next.messagePageSize = std::stoi(value);
            else if (key == "port") next.port = std::stoi(value);
            else if (key == "proxyMode") next.proxyMode = value;
            else if (key == "httpProxy") next.httpProxy = value;
            else if (key == "translateProvider") next.translateProvider = value;
            else if (key == "translateSource") next.translateSource = value;
            else if (key == "translateTarget") next.translateTarget = value;
            else if (key == "translateModel") next.translateModel = value;
            else if (key == "translatePromptKind") next.translatePromptKind = value;
            else if (key == "translatePromptId") next.translatePromptId = value;
            else if (key == "translatePromptCatalog") next.translatePromptCatalog = unescapeIniValue(value);
            else if (key == "translatePrompt") next.translatePrompt = unescapeIniValue(value);
            else if (key == "translateMaxLength") next.translateMaxLength = std::stoi(value);
            else if (key == "translateAutoChunk") next.translateAutoChunk =
                (value == "1" || value == "true" || value == "True" || value == "yes");
            else if (key == "translateClearLineBreaks") next.translateClearLineBreaks =
                (value == "1" || value == "true" || value == "True" || value == "yes");
            else if (key == "translateContextParagraphs") next.translateContextParagraphs = std::stoi(value);
            else if (key == "translateGlossary") next.translateGlossary = unescapeIniValue(value);
            else if (key == "ocrLang") next.ocrLang = value;
            else if (key == "ocrMode") next.ocrMode = value;
            else if (key == "imageOcrMode") next.imageOcrMode = value;
            else if (key == "ocrAutoTranslate") next.ocrAutoTranslate =
                (value == "1" || value == "true" || value == "True" || value == "yes");
            else if (key == "ocrTranslateProvider") next.ocrTranslateProvider = value;
            else if (key == "ocrTranslateSource") next.ocrTranslateSource = value;
            else if (key == "ocrTranslateTarget") next.ocrTranslateTarget = value;
            else if (key == "ocrTranslateModel") next.ocrTranslateModel = value;
            else if (key == "ocrTranslateMaxLength") next.ocrTranslateMaxLength = std::stoi(value);
            else if (key == "ocrTranslateAutoChunk") next.ocrTranslateAutoChunk =
                (value == "1" || value == "true" || value == "True" || value == "yes");
            else if (key == "textTranslateSource") next.textTranslateSource = value;
            else if (key == "textTranslateTarget") next.textTranslateTarget = value;
            else if (key == "textTranslateProvider") next.textTranslateProvider = value;
            else if (key == "textTranslateModel") next.textTranslateModel = value;
            else if (key == "textTranslatePrompt") next.textTranslatePrompt = unescapeIniValue(value);
            else if (key == "textPromptMtool") next.textPromptMtool = unescapeIniValue(value);
            else if (key == "textPromptSubtitle") next.textPromptSubtitle = unescapeIniValue(value);
            else if (key == "textPromptSubtitleRetime") next.textPromptSubtitleRetime = unescapeIniValue(value);
            else if (key == "textGlossary") next.textGlossary = unescapeIniValue(value);
            else if (key == "textPreReplace") next.textPreReplace = unescapeIniValue(value);
            else if (key == "textPostReplace") next.textPostReplace = unescapeIniValue(value);
            else if (key == "textProjectsDir") next.textProjectsDir = value;
            else if (key == "translateEngineKeys") next.translateEngineKeys = unescapeIniValue(value);
        }
        catch (...)
        {
            // Keep the default for one malformed line instead of rejecting the whole file.
        }
    }

    std::lock_guard<std::mutex> lock(mutex_);
    config_ = std::move(next);
}

AppConfig ConfigStore::snapshot() const
{
    std::lock_guard<std::mutex> lock(mutex_);
    return config_;
}

bool ConfigStore::replace(const AppConfig& next, std::string* error)
{
    std::lock_guard<std::mutex> lock(mutex_);
    if (!atomicfile::writeText(path_, serializeConfig(next), error))
        return false;
    config_ = next;
    return true;
}

bool ConfigStore::save(std::string* error) const
{
    std::lock_guard<std::mutex> lock(mutex_);
    return atomicfile::writeText(path_, serializeConfig(config_), error);
}

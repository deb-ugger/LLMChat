#include "Config.h"

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

        if (key == "apiUrl")
        {
            config_.apiUrl = value;
        }
        else if (key == "apiKey")
        {
            config_.apiKey = value;
        }
        else if (key == "model")
        {
            config_.model = value;
        }
        else if (key == "messagePageSize")
        {
            config_.messagePageSize = std::stoi(value);
        }
        else if (key == "port")
        {
            config_.port = std::stoi(value);
        }
        else if (key == "proxyMode")
        {
            config_.proxyMode = value;
        }
        else if (key == "httpProxy")
        {
            config_.httpProxy = value;
        }
        else if (key == "translateProvider")
        {
            config_.translateProvider = value;
        }
        else if (key == "translateSource")
        {
            config_.translateSource = value;
        }
        else if (key == "translateTarget")
        {
            config_.translateTarget = value;
        }
        else if (key == "translateModel")
        {
            config_.translateModel = value;
        }
        else if (key == "translatePromptKind")
        {
            config_.translatePromptKind = value;
        }
        else if (key == "translatePromptId")
        {
            config_.translatePromptId = value;
        }
        else if (key == "translatePromptCatalog")
        {
            config_.translatePromptCatalog = unescapeIniValue(value);
        }
        else if (key == "translatePrompt")
        {
            config_.translatePrompt = unescapeIniValue(value);
        }
        else if (key == "translateMaxLength")
        {
            config_.translateMaxLength = std::stoi(value);
        }
        else if (key == "translateAutoChunk")
        {
            config_.translateAutoChunk =
                (value == "1" || value == "true" || value == "True" || value == "yes");
        }
        else if (key == "ocrLang")
        {
            config_.ocrLang = value;
        }
        else if (key == "ocrAutoTranslate")
        {
            config_.ocrAutoTranslate =
                (value == "1" || value == "true" || value == "True" || value == "yes");
        }
        else if (key == "ocrTranslateProvider")
        {
            config_.ocrTranslateProvider = value;
        }
        else if (key == "ocrTranslateSource")
        {
            config_.ocrTranslateSource = value;
        }
        else if (key == "ocrTranslateTarget")
        {
            config_.ocrTranslateTarget = value;
        }
        else if (key == "ocrTranslateModel")
        {
            config_.ocrTranslateModel = value;
        }
        else if (key == "ocrTranslateMaxLength")
        {
            config_.ocrTranslateMaxLength = std::stoi(value);
        }
        else if (key == "ocrTranslateAutoChunk")
        {
            config_.ocrTranslateAutoChunk =
                (value == "1" || value == "true" || value == "True" || value == "yes");
        }
        else if (key == "textTranslateSource")
        {
            config_.textTranslateSource = value;
        }
        else if (key == "textTranslateTarget")
        {
            config_.textTranslateTarget = value;
        }
        else if (key == "textTranslateProvider")
        {
            config_.textTranslateProvider = value;
        }
        else if (key == "textTranslateModel")
        {
            config_.textTranslateModel = value;
        }
        else if (key == "textTranslatePrompt")
        {
            config_.textTranslatePrompt = unescapeIniValue(value);
        }
        else if (key == "textPromptMtool")
        {
            config_.textPromptMtool = unescapeIniValue(value);
        }
        else if (key == "textPromptSubtitle")
        {
            config_.textPromptSubtitle = unescapeIniValue(value);
        }
        else if (key == "textPromptSubtitleRetime")
        {
            config_.textPromptSubtitleRetime = unescapeIniValue(value);
        }
        else if (key == "textGlossary")
        {
            config_.textGlossary = unescapeIniValue(value);
        }
        else if (key == "textPreReplace")
        {
            config_.textPreReplace = unescapeIniValue(value);
        }
        else if (key == "textPostReplace")
        {
            config_.textPostReplace = unescapeIniValue(value);
        }
        else if (key == "textProjectsDir")
        {
            config_.textProjectsDir = value;
        }
        else if (key == "translateEngineKeys")
        {
            config_.translateEngineKeys = unescapeIniValue(value);
        }
    }
}

void ConfigStore::save() const
{
    std::ofstream out(path_, std::ios::trunc);
    if (!out)
    {
        return;
    }

    out << "[General]\n";
    out << "apiUrl=" << config_.apiUrl << "\n";
    out << "apiKey=" << config_.apiKey << "\n";
    out << "model=" << config_.model << "\n";
    out << "messagePageSize=" << config_.messagePageSize << "\n";
    out << "port=" << config_.port << "\n";
    out << "proxyMode=" << config_.proxyMode << "\n";
    out << "httpProxy=" << config_.httpProxy << "\n";
    out << "translateProvider=" << config_.translateProvider << "\n";
    out << "translateSource=" << config_.translateSource << "\n";
    out << "translateTarget=" << config_.translateTarget << "\n";
    out << "translateModel=" << config_.translateModel << "\n";
    out << "translatePromptId=" << config_.translatePromptId << "\n";
    out << "translatePromptCatalog=" << escapeIniValue(config_.translatePromptCatalog) << "\n";
    out << "translatePromptKind=" << config_.translatePromptKind << "\n";
    out << "translatePrompt=" << escapeIniValue(config_.translatePrompt) << "\n";
    out << "translateMaxLength=" << config_.translateMaxLength << "\n";
    out << "translateAutoChunk=" << (config_.translateAutoChunk ? "true" : "false") << "\n";
    out << "ocrLang=" << config_.ocrLang << "\n";
    out << "ocrAutoTranslate=" << (config_.ocrAutoTranslate ? "true" : "false") << "\n";
    out << "ocrTranslateProvider=" << config_.ocrTranslateProvider << "\n";
    out << "ocrTranslateSource=" << config_.ocrTranslateSource << "\n";
    out << "ocrTranslateTarget=" << config_.ocrTranslateTarget << "\n";
    out << "ocrTranslateModel=" << config_.ocrTranslateModel << "\n";
    out << "ocrTranslateMaxLength=" << config_.ocrTranslateMaxLength << "\n";
    out << "ocrTranslateAutoChunk=" << (config_.ocrTranslateAutoChunk ? "true" : "false") << "\n";
    out << "textTranslateSource=" << config_.textTranslateSource << "\n";
    out << "textTranslateTarget=" << config_.textTranslateTarget << "\n";
    out << "textTranslateProvider=" << config_.textTranslateProvider << "\n";
    out << "textTranslateModel=" << config_.textTranslateModel << "\n";
    out << "textTranslatePrompt=" << escapeIniValue(config_.textTranslatePrompt) << "\n";
    out << "textPromptMtool=" << escapeIniValue(config_.textPromptMtool) << "\n";
    out << "textPromptSubtitle=" << escapeIniValue(config_.textPromptSubtitle) << "\n";
    out << "textPromptSubtitleRetime=" << escapeIniValue(config_.textPromptSubtitleRetime) << "\n";
    out << "textGlossary=" << escapeIniValue(config_.textGlossary) << "\n";
    out << "textPreReplace=" << escapeIniValue(config_.textPreReplace) << "\n";
    out << "textPostReplace=" << escapeIniValue(config_.textPostReplace) << "\n";
    out << "textProjectsDir=" << config_.textProjectsDir << "\n";
    out << "translateEngineKeys=" << escapeIniValue(config_.translateEngineKeys) << "\n";
}

#include "Config.h"

#include <fstream>
#include <sstream>
#include <algorithm>
#include <cctype>

namespace {

std::string trim(std::string s)
{
    auto notSpace = [](unsigned char c) { return !std::isspace(c); };
    s.erase(s.begin(), std::find_if(s.begin(), s.end(), notSpace));
    s.erase(std::find_if(s.rbegin(), s.rend(), notSpace).base(), s.end());
    return s;
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
        else if (key == "ocrTranslateMaxLength")
        {
            config_.ocrTranslateMaxLength = std::stoi(value);
        }
        else if (key == "ocrTranslateAutoChunk")
        {
            config_.ocrTranslateAutoChunk =
                (value == "1" || value == "true" || value == "True" || value == "yes");
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
    out << "translateMaxLength=" << config_.translateMaxLength << "\n";
    out << "translateAutoChunk=" << (config_.translateAutoChunk ? "true" : "false") << "\n";
    out << "ocrLang=" << config_.ocrLang << "\n";
    out << "ocrAutoTranslate=" << (config_.ocrAutoTranslate ? "true" : "false") << "\n";
    out << "ocrTranslateProvider=" << config_.ocrTranslateProvider << "\n";
    out << "ocrTranslateSource=" << config_.ocrTranslateSource << "\n";
    out << "ocrTranslateTarget=" << config_.ocrTranslateTarget << "\n";
    out << "ocrTranslateMaxLength=" << config_.ocrTranslateMaxLength << "\n";
    out << "ocrTranslateAutoChunk=" << (config_.ocrTranslateAutoChunk ? "true" : "false") << "\n";
}

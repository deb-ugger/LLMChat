/**
 * Convert LaTeX (especially full ctexart/article documents) into
 * Markdown + KaTeX-friendly math so chat can render them richly.
 */

function replaceEnv(
  input: string,
  name: string,
  replacer: (body: string) => string,
): string {
  const re = new RegExp(
    String.raw`\\begin\{${name}\}([\s\S]*?)\\end\{${name}\}`,
    "g",
  );
  return input.replace(re, (_m, body: string) => replacer(body));
}

/** Match \cmd{...} with nested braces. */
function matchCommandArg(
  source: string,
  cmd: string,
): { full: string; arg: string; index: number } | null {
  const re = new RegExp(String.raw`\\${cmd}\{`);
  const m = re.exec(source);
  if (!m || m.index === undefined) return null;

  const start = m.index + m[0].length;
  let depth = 1;
  let i = start;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === "\\" && i + 1 < source.length) {
      i += 2;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    i += 1;
  }
  if (depth !== 0) return null;
  return {
    full: source.slice(m.index, i),
    arg: source.slice(start, i - 1),
    index: m.index,
  };
}

function extractCommandArg(source: string, cmd: string): string | undefined {
  return matchCommandArg(source, cmd)?.arg;
}

function displayMath(body: string): string {
  // No blank lines between $$ and content — remark-math breaks otherwise
  // and may leave orphan single "$" in the rendered text.
  const formula = body
    .trim()
    .replace(/\n{2,}/g, "\n")
    .trim();
  return `\n\n$$\n${formula}\n$$\n\n`;
}

function convertTabular(body: string): string {
  const rows = body
    .split(/\\\\/)
    .map((r) => r.replace(/\\hline\b/g, "").trim())
    .filter((r) => r.length > 0);

  if (rows.length === 0) {
    return "";
  }

  const cells = rows.map((r) =>
    r.split("&").map((c) => c.trim().replace(/\s+/g, " ")),
  );
  const width = Math.max(...cells.map((c) => c.length));
  const norm = cells.map((c) => {
    const row = [...c];
    while (row.length < width) row.push("");
    return row;
  });

  const header = norm[0];
  const sep = header.map(() => "---");
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${sep.join(" | ")} |`,
    ...norm.slice(1).map((r) => `| ${r.join(" | ")} |`),
  ];
  return `\n\n${lines.join("\n")}\n\n`;
}

/**
 * Apply text replacements only outside math spans so formulas stay intact.
 */
function mapOutsideMath(text: string, fn: (chunk: string) => string): string {
  const parts: string[] = [];
  const re =
    /(\$\$[\s\S]+?\$\$|\$[^$\n]+?\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      parts.push(fn(text.slice(last, m.index)));
    }
    parts.push(m[0]);
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    parts.push(fn(text.slice(last)));
  }
  return parts.join("");
}

function convertSimpleCommands(text: string): string {
  return mapOutsideMath(text, (chunk) => {
    let s = chunk;
    s = s.replace(/\\textbf\{([^{}]*)\}/g, "**$1**");
    s = s.replace(/\\textit\{([^{}]*)\}/g, "*$1*");
    s = s.replace(/\\emph\{([^{}]*)\}/g, "*$1*");
    s = s.replace(/\\texttt\{([^{}]*)\}/g, "`$1`");
    s = s.replace(/\\underline\{([^{}]*)\}/g, "$1");

    s = s.replace(/\\LaTeX\{\}/g, "LaTeX");
    s = s.replace(/\\LaTeX\b/g, "LaTeX");
    s = s.replace(/\\TeX\{\}/g, "TeX");
    s = s.replace(/\\today\b/g, "");
    s = s.replace(/\\maketitle\b/g, "");
    s = s.replace(/\\centering\b/g, "");
    s = s.replace(/\\noindent\b/g, "");
    s = s.replace(/\\newpage\b/g, "\n\n");
    s = s.replace(/\\clearpage\b/g, "\n\n");
    s = s.replace(/\\hfill\b/g, " ");
    s = s.replace(/~/g, " ");

    s = s.replace(/\\caption\{([^{}]*)\}/g, "\n*$1*\n");
    s = s.replace(/\\label\{[^{}]*\}/g, "");
    s = s.replace(/\\ref\{[^{}]*\}/g, "");
    return s;
  });
}

function simplifyTitleArg(arg: string): string {
  return arg
    .replace(/\\LaTeX\{\}/g, "LaTeX")
    .replace(/\\LaTeX\b/g, "LaTeX")
    .replace(/\\TeX\{\}/g, "TeX")
    .trim();
}

/** Convert a LaTeX document (or document body) to Markdown. */
export function latexToMarkdown(latex: string): string {
  let s = latex.replace(/\r\n/g, "\n");

  const docMatch = s.match(/\\begin\{document\}([\s\S]*?)\\end\{document\}/);
  if (docMatch) {
    const preamble = s.slice(0, docMatch.index ?? 0);
    const title = extractCommandArg(preamble, "title");
    const author = extractCommandArg(preamble, "author");
    s = docMatch[1];
    const head: string[] = [];
    if (title) head.push(`# ${simplifyTitleArg(title)}`);
    if (author) head.push(`*${simplifyTitleArg(author)}*`);
    if (head.length) s = `${head.join("\n\n")}\n\n${s}`;
  } else {
    s = s.replace(
      /^[\s\S]*?(\\section|\\begin\{abstract\}|\\maketitle)/,
      "$1",
    );
  }

  s = s.replace(/^%.*$/gm, "");
  s = s.replace(/\\documentclass(?:\[[^\]]*\])?\{[^}]+\}/g, "");
  s = s.replace(/\\usepackage(?:\[[^\]]*\])?\{[^}]+\}/g, "");
  s = s.replace(/\\geometry\{[^}]*\}/g, "");

  // Remove leftover \title/\author/\date in body (already used if from preamble)
  for (const cmd of ["title", "author", "date"]) {
    for (;;) {
      const hit = matchCommandArg(s, cmd);
      if (!hit) break;
      if (cmd === "title") {
        s =
          s.slice(0, hit.index) +
          `\n# ${simplifyTitleArg(hit.arg)}\n` +
          s.slice(hit.index + hit.full.length);
      } else {
        s =
          s.slice(0, hit.index) +
          `\n*${simplifyTitleArg(hit.arg)}*\n` +
          s.slice(hit.index + hit.full.length);
      }
    }
  }

  s = replaceEnv(s, "abstract", (body) => {
    const lines = body
      .trim()
      .split("\n")
      .map((l) => `> ${l}`)
      .join("\n");
    return `\n${lines}\n`;
  });

  s = s.replace(/\\section\*?\{([^{}]*)\}/g, "\n## $1\n");
  s = s.replace(/\\subsection\*?\{([^{}]*)\}/g, "\n### $1\n");
  s = s.replace(/\\subsubsection\*?\{([^{}]*)\}/g, "\n#### $1\n");
  s = s.replace(/\\paragraph\*?\{([^{}]*)\}/g, "\n**$1** ");

  // \[...\] / \(...\) → $$ / $ before other processing
  s = s.replace(/\\\[([\s\S]*?)\\\]/g, (_m, body: string) =>
    displayMath(body),
  );
  s = s.replace(/\\\(([\s\S]*?)\\\)/g, (_m, body: string) => `$${body.trim()}$`);

  // Math environments → $$
  for (const name of [
    "equation\\*?",
    "align\\*?",
    "gather\\*?",
    "multline\\*?",
    "displaymath",
  ]) {
    const re = new RegExp(
      String.raw`\\begin\{${name}\}([\s\S]*?)\\end\{${name}\}`,
      "g",
    );
    s = s.replace(re, (_m, body: string) => displayMath(body));
  }

  s = replaceEnv(s, "itemize", (body) => {
    const items = body
      .split(/\\item\b/)
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => `- ${x}`)
      .join("\n");
    return `\n${items}\n`;
  });
  s = replaceEnv(s, "enumerate", (body) => {
    let i = 0;
    const items = body
      .split(/\\item\b/)
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => `${++i}. ${x}`)
      .join("\n");
    return `\n${items}\n`;
  });

  s = replaceEnv(s, "table", (body) => {
    const tab = body.match(
      /\\begin\{tabular\}\{[^}]*\}([\s\S]*?)\\end\{tabular\}/,
    );
    if (tab) {
      const caption = body.match(/\\caption\{([^{}]*)\}/)?.[1];
      return convertTabular(tab[1]) + (caption ? `\n*${caption}*\n` : "");
    }
    return body;
  });
  s = replaceEnv(s, "tabular", (body) => convertTabular(body));

  s = replaceEnv(s, "figure", (body) => {
    const caption = body.match(/\\caption\{([^{}]*)\}/)?.[1];
    return caption ? `\n*${caption}*\n` : "\n";
  });

  s = convertSimpleCommands(s);

  // Strip leftover environments outside math only
  s = mapOutsideMath(s, (chunk) =>
    chunk
      .replace(/\\begin\{[^}]+\}(?:\[[^\]]*\])?/g, "")
      .replace(/\\end\{[^}]+\}/g, ""),
  );

  s = s.replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

const DOCUMENT_RE =
  /(?:^[ \t]*%[^\n]*\n)*[ \t]*\\documentclass(?:\[[^\]]*\])?\{[^}]+\}[\s\S]*?\\end\{document\}/gm;

export function preprocessRichText(raw: string): string {
  let text = raw.replace(/\r\n/g, "\n");

  text = text.replace(
    /```(?:latex|tex|math)\s*\n([\s\S]*?)```/gi,
    (_match, body: string) => {
      const trimmed = body.trim();
      if (
        /\\documentclass\b/.test(trimmed) ||
        /\\begin\{document\}/.test(trimmed)
      ) {
        return `\n\n${latexToMarkdown(trimmed)}\n\n`;
      }
      if (
        /\\begin\{(?:equation|align|itemize|enumerate|tabular)/.test(trimmed)
      ) {
        return `\n\n${latexToMarkdown(trimmed)}\n\n`;
      }
      return displayMath(trimmed);
    },
  );

  text = text.replace(DOCUMENT_RE, (doc) => `\n\n${latexToMarkdown(doc)}\n\n`);

  text = text.replace(
    /\\begin\{(?:equation\*?|align\*?|itemize|enumerate|tabular)\}[\s\S]*?\\end\{(?:equation\*?|align\*?|itemize|enumerate|tabular)\}/g,
    (block) => {
      if (/\\documentclass/.test(block)) return block;
      return `\n\n${latexToMarkdown(`\\begin{document}\n${block}\n\\end{document}`)}\n\n`;
    },
  );

  // Fix broken single-dollar multiline formulas (not $$ display math)
  // Example left by older buggy conversion:
  //   $\n\int...\n$
  text = text.replace(
    /(?<!\$)\$\s*\n+\s*([^\n$][\s\S]*?)\s*\n+\s*\$(?!\$)/g,
    (_m, body: string) => {
      const t = body.trim();
      if (/\\[a-zA-Z]+|[_^]|\{|\}/.test(t)) {
        return displayMath(t);
      }
      return _m;
    },
  );

  // Collapse "$\n\n$$\n...\n$$\n\n$" artifacts from the previous bug
  text = text.replace(
    /\$\s*\n+\s*\$\$([\s\S]*?)\$\$\s*\n+\s*\$/g,
    (_m, body: string) => displayMath(body),
  );

  return text;
}

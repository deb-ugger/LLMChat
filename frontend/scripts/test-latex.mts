import { latexToMarkdown } from "../src/latexToMarkdown";

const sample = `% !TEX program = xelatex
\\documentclass[UTF8]{ctexart}
\\title{我的第一个 \\LaTeX{} 测试}
\\author{你的名字}
\\begin{document}
\\maketitle
\\section{问候与数学}
你好，世界！下面是一个经典积分：
\\begin{equation}
\\int_{-\\infty}^{\\infty} e^{-x^2} \\, dx = \\sqrt{\\pi}
\\end{equation}
\\end{document}`;

const out = latexToMarkdown(sample);
console.log(out);
console.log("---");
console.log("has $$", out.includes("$$"));
console.log(
  "broken single $ multiline",
  /\$\s*\n+\s*\\int/.test(out) && !out.includes("$$\n\\int"),
);

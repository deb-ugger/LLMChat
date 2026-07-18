/** SRT / ASS subtitle parse & rebuild (translate text only, keep timing). */

export type SrtCue = {
  index: number;
  start: string;
  end: string;
  text: string;
};

export type AssDialogue = {
  /** Full line prefix through Effect field, ending before Text (includes trailing comma). */
  prefix: string;
  text: string;
  rawLine: string;
};

export type AssDocument = {
  header: string;
  dialogues: AssDialogue[];
  footer: string;
};

export function parseSrt(raw: string): SrtCue[] {
  const normalized = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const blocks = normalized.split(/\n\s*\n/);
  const cues: SrtCue[] = [];
  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trimEnd()).filter((l, i, arr) => {
      // keep internal blank? SRT text can have empty lines rarely — drop trailing empties only
      return !(i === arr.length - 1 && l.trim() === "") || arr.length === 1;
    });
    const nonEmpty = lines.filter((l) => l.trim() !== "" || lines.indexOf(l) > 1);
    if (nonEmpty.length < 2) continue;
    let i = 0;
    let index = cues.length + 1;
    if (/^\d+$/.test(nonEmpty[0].trim())) {
      index = Number(nonEmpty[0].trim());
      i = 1;
    }
    const timeLine = nonEmpty[i] || "";
    const m = timeLine.match(
      /(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/,
    );
    if (!m) continue;
    const text = nonEmpty
      .slice(i + 1)
      .join("\n")
      .replace(/\n+$/, "");
    cues.push({
      index,
      start: m[1].replace(".", ","),
      end: m[2].replace(".", ","),
      text,
    });
  }
  return cues;
}

export function serializeSrt(cues: SrtCue[]): string {
  return (
    cues
      .map(
        (c, i) =>
          `${c.index || i + 1}\n${c.start} --> ${c.end}\n${c.text}\n`,
      )
      .join("\n") + "\n"
  );
}

/** Split ASS Dialogue line into prefix (through Effect,) and Text. */
export function splitAssDialogue(line: string): AssDialogue | null {
  const trimmed = line.replace(/^\uFEFF/, "");
  const m = trimmed.match(/^(Dialogue:\s*)(.*)$/i);
  if (!m) return null;
  const rest = m[2];
  // Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
  let commas = 0;
  let splitAt = -1;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === ",") {
      commas += 1;
      if (commas === 9) {
        splitAt = i;
        break;
      }
    }
  }
  if (splitAt < 0) return null;
  const prefix = m[1] + rest.slice(0, splitAt + 1);
  const text = rest.slice(splitAt + 1);
  return { prefix, text, rawLine: trimmed };
}

export function parseAss(raw: string): AssDocument {
  const normalized = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const headerParts: string[] = [];
  const dialogues: AssDialogue[] = [];
  const footerParts: string[] = [];
  let inEvents = false;
  let pastEvents = false;

  for (const line of lines) {
    if (/^\[Events\]/i.test(line.trim())) {
      inEvents = true;
      pastEvents = false;
      headerParts.push(line);
      continue;
    }
    if (inEvents && /^\[/.test(line.trim()) && !/^\[Events\]/i.test(line.trim())) {
      inEvents = false;
      pastEvents = true;
    }
    if (pastEvents) {
      footerParts.push(line);
      continue;
    }
    if (inEvents && /^Dialogue:/i.test(line.trim())) {
      const d = splitAssDialogue(line);
      if (d) dialogues.push(d);
      else headerParts.push(line);
      continue;
    }
    if (!pastEvents) headerParts.push(line);
  }

  return {
    header: headerParts.join("\n"),
    dialogues,
    footer: footerParts.join("\n"),
  };
}

export function serializeAss(doc: AssDocument): string {
  const body = doc.dialogues.map((d) => `${d.prefix}${d.text}`).join("\n");
  const parts = [doc.header, body];
  if (doc.footer.trim()) parts.push(doc.footer);
  return parts.filter((p) => p.length).join("\n").replace(/\n*$/, "\n");
}

/** Strip simple ASS override tags for "empty?" checks; keep for translation content. */
export function assTextLooksEmpty(text: string): boolean {
  const plain = text.replace(/\{[^}]*\}/g, "").replace(/\\[nNh]/g, "").trim();
  return !plain;
}

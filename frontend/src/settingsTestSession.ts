/** In-memory test results for the current app session (cleared on process exit). */

export type SessionTestResult = {
  ok: boolean;
  message: string;
};

let cardResults: Record<string, SessionTestResult> = {};
let sectionResults: {
  llm?: SessionTestResult;
  lit?: SessionTestResult;
  litLlm?: SessionTestResult;
  ocr?: SessionTestResult;
  text?: SessionTestResult;
} = {};

export function readCardTestResults(): Record<string, SessionTestResult> {
  return { ...cardResults };
}

export function writeCardTestResults(
  next: Record<string, SessionTestResult>,
): void {
  cardResults = { ...next };
}

export function readSectionTestResults(): typeof sectionResults {
  return { ...sectionResults };
}

export function writeSectionTestResults(next: typeof sectionResults): void {
  sectionResults = { ...next };
}

export interface CitationVerifyResult {
  textCitations: number[];
  jsonCitations: number[];
  verified: number[];
  malformed: boolean;
}

const MAX_CITATION = 5;

export function verifyCitations(answer: string): CitationVerifyResult {
  const textCitations = [
    ...new Set(
      [...answer.matchAll(/\[来源\s*(\d+)\]/g)]
        .map((m) => parseInt(m[1]!, 10))
        .filter((n) => n >= 1 && n <= MAX_CITATION),
    ),
  ];

  const jsonBlockMatch = answer.match(/\{"citations":\s*\[([^\]]*)\]\}\s*$/);
  let jsonCitations: number[] = [];
  let malformed = false;

  if (jsonBlockMatch) {
    const inner = jsonBlockMatch[1]!.trim();
    if (inner === "") {
      jsonCitations = [];
    } else {
      try {
        const parsed: unknown = JSON.parse(`[${inner}]`);
        if (!Array.isArray(parsed)) {
          malformed = true;
        } else {
          jsonCitations = parsed
            .filter((x): x is number => typeof x === "number" && Number.isInteger(x))
            .filter((n) => n >= 1 && n <= MAX_CITATION);
        }
      } catch {
        malformed = true;
      }
    }
  } else if (/\{"citations":/.test(answer)) {
    malformed = true;
  }

  const verified = textCitations.filter((n) => jsonCitations.includes(n));

  return { textCitations, jsonCitations, verified, malformed };
}
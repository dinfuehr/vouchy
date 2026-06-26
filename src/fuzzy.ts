export interface FuzzyMatch {
  score: number;
  indices: number[];
}

export function fuzzyMatch(candidate: string, query: string): FuzzyMatch | null {
  const needle = query.trim();
  if (needle.length === 0) {
    return { score: 0, indices: [] };
  }

  const lowerCandidate = candidate.toLocaleLowerCase();
  const lowerNeedle = needle.toLocaleLowerCase();
  const substringIndex = lowerCandidate.indexOf(lowerNeedle);
  if (substringIndex >= 0) {
    const indices = Array.from({ length: lowerNeedle.length }, (_, offset) => substringIndex + offset);
    return {
      score: 2000 + lowerNeedle.length * 20 - substringIndex - candidate.length * 0.01,
      indices,
    };
  }

  const indices: number[] = [];
  let searchFrom = 0;
  for (const char of lowerNeedle) {
    const index = lowerCandidate.indexOf(char, searchFrom);
    if (index < 0) {
      return null;
    }
    indices.push(index);
    searchFrom = index + 1;
  }

  let score = 1000 + lowerNeedle.length * 10 - candidate.length * 0.01;
  for (let index = 0; index < indices.length; index += 1) {
    const current = indices[index] ?? 0;
    const previous = indices[index - 1];
    if (previous != null) {
      const gap = current - previous - 1;
      score -= gap;
      if (gap === 0) {
        score += 8;
      }
    }

    const previousChar = candidate[current - 1];
    if (current === 0 || previousChar === "/" || previousChar === "-" || previousChar === "_" || previousChar === ".") {
      score += 12;
    }
  }

  return { score, indices };
}

export function normalizeSearchText(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9+#.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function lightStem(term, protectedTerms) {
  if (protectedTerms.has(term) || term.length < 4) return term;
  if (term.endsWith("ies") && term.length > 4) return `${term.slice(0, -3)}y`;
  if (term.endsWith("ing") && term.length > 6) return term.slice(0, -3);
  if (term.endsWith("ed") && term.length > 5) return term.slice(0, -2);
  if (term.endsWith("sses") && term.length > 5) return term.slice(0, -2);
  if (/(ches|shes|xes|zes|oes)$/.test(term) && term.length > 5) return term.slice(0, -2);
  if (term.endsWith("s") && term.length > 4 && !/(ss|us|is)$/.test(term)) return term.slice(0, -1);
  return term;
}

export function tokenizeSearchText(value, config = {}) {
  const stopwords = config.stopwords instanceof Set ? config.stopwords : new Set(config.stopwords ?? []);
  const protectedTerms = config.protectedTerms instanceof Set
    ? config.protectedTerms
    : new Set(config.protected_terms ?? []);
  return normalizeSearchText(value).split(" ").filter(Boolean).flatMap((raw) => {
    if (stopwords.has(raw)) return [];
    if (raw.length < 2 && !protectedTerms.has(raw)) return [];
    return [{ raw, term: lightStem(raw, protectedTerms) }];
  });
}

export function damerauLevenshtein(left, right, maximum = Number.POSITIVE_INFINITY) {
  const a = String(left);
  const b = String(right);
  if (Math.abs(a.length - b.length) > maximum) return maximum + 1;
  const previousPrevious = Array.from({ length: b.length + 1 }, () => 0);
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row += 1) {
    const current = [row];
    let rowMinimum = row;
    for (let column = 1; column <= b.length; column += 1) {
      const substitution = previous[column - 1] + (a[row - 1] === b[column - 1] ? 0 : 1);
      let distance = Math.min(previous[column] + 1, current[column - 1] + 1, substitution);
      if (row > 1 && column > 1 && a[row - 1] === b[column - 2] && a[row - 2] === b[column - 1]) {
        distance = Math.min(distance, previousPrevious[column - 2] + 1);
      }
      current[column] = distance;
      rowMinimum = Math.min(rowMinimum, distance);
    }
    if (rowMinimum > maximum) return maximum + 1;
    for (let index = 0; index < previous.length; index += 1) previousPrevious[index] = previous[index];
    previous = current;
  }
  return previous[b.length];
}

function intersectScoreMaps(maps) {
  if (!maps.length) return new Map();
  const ordered = [...maps].sort((left, right) => left.size - right.size);
  const result = new Map();
  ordered[0].forEach((score, documentIndex) => {
    let total = score;
    for (let index = 1; index < ordered.length; index += 1) {
      const next = ordered[index].get(documentIndex);
      if (next === undefined) return;
      total += next;
    }
    result.set(documentIndex, total);
  });
  return result;
}

function mergeMaximum(target, source, multiplier = 1) {
  source.forEach((score, documentIndex) => {
    target.set(documentIndex, Math.max(target.get(documentIndex) ?? Number.NEGATIVE_INFINITY, score * multiplier));
  });
}

function configSet(values) {
  return new Set((values ?? []).map((value) => normalizeSearchText(value)).filter(Boolean));
}

export function isCurrentSearchResponse(latestRequestId, message) {
  return message?.type === "results" && Number(message.requestId) === Number(latestRequestId);
}

export class SearchIndex {
  constructor(documents, config) {
    if (config?.schema_version !== "public-job-board-search-v1") throw new Error("Unsupported search configuration.");
    this.config = config;
    this.stopwords = configSet(config.stopwords);
    this.protectedTerms = configSet(config.protected_terms);
    this.tokenConfig = { stopwords: this.stopwords, protectedTerms: this.protectedTerms };
    this.fieldWeights = config.field_weights ?? {};
    this.fieldNames = Object.keys(this.fieldWeights);
    this.documents = [];
    this.postings = new Map();
    this.fieldLengthTotals = Object.fromEntries(this.fieldNames.map((field) => [field, 0]));
    this.displayTerms = new Map();
    this.suggestionCounts = new Map();
    this.aliasGroups = this.buildAliasGroups(config.synonym_groups ?? []);
    documents.forEach((document, index) => this.addDocument(document, index));
    this.averageFieldLengths = Object.fromEntries(this.fieldNames.map((field) => [
      field,
      Math.max(1, this.fieldLengthTotals[field] / Math.max(1, this.documents.length)),
    ]));
    this.vocabulary = [...this.postings.keys()];
    this.vocabularyBuckets = new Map();
    this.vocabularyLengthBuckets = new Map();
    this.vocabulary.forEach((term) => {
      const key = term.slice(0, 2);
      if (!this.vocabularyBuckets.has(key)) this.vocabularyBuckets.set(key, []);
      this.vocabularyBuckets.get(key).push(term);
      if (!this.vocabularyLengthBuckets.has(term.length)) this.vocabularyLengthBuckets.set(term.length, []);
      this.vocabularyLengthBuckets.get(term.length).push(term);
    });
    this.suggestions = [...this.suggestionCounts.values()];
  }

  buildAliasGroups(groups) {
    return groups.map((group) => {
      const labels = [group.canonical, ...(group.aliases ?? [])];
      const variants = labels.map((label) => ({
        label,
        tokens: tokenizeSearchText(label, this.tokenConfig).map((token) => token.term),
      })).filter((variant) => variant.tokens.length);
      return { canonical: group.canonical, variants };
    }).filter((group) => group.variants.length);
  }

  addDocument(document, documentIndex) {
    const fields = {};
    const normalizedFields = {};
    this.fieldNames.forEach((field) => {
      const text = Array.isArray(document.fields?.[field]) ? document.fields[field].join(" ") : document.fields?.[field];
      normalizedFields[field] = normalizeSearchText(text);
      const tokens = tokenizeSearchText(text, this.tokenConfig);
      fields[field] = tokens.length;
      this.fieldLengthTotals[field] += tokens.length;
      const counts = new Map();
      tokens.forEach(({ raw, term }) => {
        counts.set(term, (counts.get(term) ?? 0) + 1);
        const display = this.displayTerms.get(term) ?? new Map();
        display.set(raw, (display.get(raw) ?? 0) + 1);
        this.displayTerms.set(term, display);
      });
      counts.forEach((frequency, term) => {
        if (!this.postings.has(term)) this.postings.set(term, new Map());
        const documentFields = this.postings.get(term).get(documentIndex) ?? {};
        documentFields[field] = frequency;
        this.postings.get(term).set(documentIndex, documentFields);
      });
    });
    this.documents.push({
      id: document.id,
      posted_on: document.posted_on ?? "",
      fieldLengths: fields,
      normalizedFields,
    });
    (document.suggestions ?? []).forEach((suggestion) => {
      const label = String(suggestion.label ?? "").trim();
      const category = String(suggestion.category ?? "").trim();
      const normalized = normalizeSearchText(label);
      if (!label || !category || normalized.length < 2) return;
      const key = `${category}\u0000${normalized}`;
      const current = this.suggestionCounts.get(key) ?? { label, category, normalized, count: 0 };
      current.count += 1;
      this.suggestionCounts.set(key, current);
    });
  }

  displayTerm(term) {
    const choices = this.displayTerms.get(term);
    if (!choices) return term;
    return [...choices.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0][0];
  }

  parseConcepts(rawQuery) {
    const queryTokens = tokenizeSearchText(rawQuery, this.tokenConfig);
    const concepts = [];
    for (let position = 0; position < queryTokens.length;) {
      let selected = null;
      this.aliasGroups.forEach((group) => {
        group.variants.forEach((variant) => {
          if (position + variant.tokens.length > queryTokens.length) return;
          if (!variant.tokens.every((term, offset) => queryTokens[position + offset].term === term)) return;
          if (!selected || variant.tokens.length > selected.sourceLength) selected = { group, sourceLength: variant.tokens.length };
        });
      });
      if (selected) {
        concepts.push({
          source: queryTokens.slice(position, position + selected.sourceLength),
          variants: selected.group.variants,
        });
        position += selected.sourceLength;
      } else {
        concepts.push({
          source: [queryTokens[position]],
          variants: [{ label: queryTokens[position].raw, tokens: [queryTokens[position].term] }],
        });
        position += 1;
      }
    }
    return { concepts, queryTokens };
  }

  maximumDistance(term) {
    const fuzzy = this.config.fuzzy ?? {};
    return term.length >= Number(fuzzy.long_term_length ?? 8)
      ? Number(fuzzy.long_max_distance ?? 2)
      : Number(fuzzy.short_max_distance ?? 1);
  }

  resolveTerm(term) {
    const prefix = this.config.prefix ?? {};
    const fuzzy = this.config.fuzzy ?? {};
    const expansions = [];
    if (this.postings.has(term)) expansions.push({ term, multiplier: 1, kind: "exact" });
    if (term.length >= Number(prefix.min_length ?? 3)) {
      const candidates = this.vocabularyBuckets.get(term.slice(0, 2)) ?? [];
      candidates.filter((candidate) => candidate !== term && candidate.startsWith(term))
        .sort((left, right) => this.postings.get(right).size - this.postings.get(left).size || left.localeCompare(right))
        .slice(0, Number(prefix.max_expansions ?? 24))
        .forEach((candidate) => expansions.push({
          term: candidate,
          multiplier: Number(prefix.score_multiplier ?? 0.8),
          kind: "prefix",
        }));
    }
    if (!expansions.length && term.length >= Number(fuzzy.min_length ?? 4) && !this.protectedTerms.has(term)) {
      const maximum = this.maximumDistance(term);
      const candidates = [];
      for (let length = term.length - maximum; length <= term.length + maximum; length += 1) {
        candidates.push(...(this.vocabularyLengthBuckets.get(length) ?? []));
      }
      candidates.filter((candidate) => Math.abs(candidate.length - term.length) <= maximum)
        .map((candidate) => ({ candidate, distance: damerauLevenshtein(term, candidate, maximum) }))
        .filter((candidate) => candidate.distance <= maximum)
        .sort((left, right) => left.distance - right.distance
          || this.postings.get(right.candidate).size - this.postings.get(left.candidate).size
          || left.candidate.localeCompare(right.candidate))
        .slice(0, Number(fuzzy.max_expansions ?? 4))
        .forEach(({ candidate }) => expansions.push({
          term: candidate,
          multiplier: Number(fuzzy.score_multiplier ?? 0.65),
          kind: "fuzzy",
        }));
    }
    return expansions;
  }

  termScores(term, cache) {
    if (cache.has(term)) return cache.get(term);
    const posting = this.postings.get(term) ?? new Map();
    const documentFrequency = posting.size;
    const inverseDocumentFrequency = Math.log(1 + ((this.documents.length - documentFrequency + 0.5) / (documentFrequency + 0.5)));
    const scores = new Map();
    posting.forEach((frequencies, documentIndex) => {
      let score = 0;
      this.fieldNames.forEach((field) => {
        const frequency = frequencies[field] ?? 0;
        if (!frequency) return;
        const length = this.documents[documentIndex].fieldLengths[field] || 1;
        const average = this.averageFieldLengths[field] || 1;
        const normalizedFrequency = (frequency * 2.2) / (frequency + (1.2 * (0.25 + (0.75 * length / average))));
        score += Number(this.fieldWeights[field] ?? 1) * normalizedFrequency;
      });
      scores.set(documentIndex, inverseDocumentFrequency * score);
    });
    cache.set(term, scores);
    return scores;
  }

  expansionScores(expansions, cache) {
    const scores = new Map();
    expansions.forEach((expansion) => mergeMaximum(scores, this.termScores(expansion.term, cache), expansion.multiplier));
    return scores;
  }

  search(rawQuery) {
    const query = String(rawQuery ?? "").trim();
    const { concepts, queryTokens } = this.parseConcepts(query);
    if (!concepts.length) {
      const matches = this.documents.map((document, documentIndex) => ({ documentIndex, score: 0 }))
        .sort((left, right) => String(this.documents[right.documentIndex].posted_on)
          .localeCompare(String(this.documents[left.documentIndex].posted_on)));
      return { matches, suggestions: this.suggest(query), corrections: [], correctedQuery: "", highlightTerms: [] };
    }
    const termScoreCache = new Map();
    const conceptMaps = [];
    const corrections = [];
    const highlightTerms = new Set(queryTokens.map((token) => token.raw));
    for (const concept of concepts) {
      const conceptScores = new Map();
      concept.variants.forEach((variant) => {
        const termMaps = [];
        const usesAlias = variant.tokens.join(" ") !== concept.source.map((token) => token.term).join(" ");
        variant.tokens.forEach((term) => {
          const expansions = this.resolveTerm(term);
          if (!expansions.length) return;
          expansions.forEach((expansion) => {
            highlightTerms.add(this.displayTerm(expansion.term));
            if (expansion.kind === "fuzzy") corrections.push({ from: concept.source[0]?.raw ?? term, to: this.displayTerm(expansion.term) });
          });
          termMaps.push(this.expansionScores(expansions, termScoreCache));
        });
        if (termMaps.length !== variant.tokens.length) return;
        mergeMaximum(
          conceptScores,
          intersectScoreMaps(termMaps),
          usesAlias ? Number(this.config.alias_score_multiplier ?? 0.9) : 1,
        );
      });
      if (!conceptScores.size) {
        return {
          matches: [], suggestions: this.suggest(query), corrections: [], correctedQuery: "", highlightTerms: [...highlightTerms],
        };
      }
      conceptMaps.push(conceptScores);
    }
    const combined = intersectScoreMaps(conceptMaps);
    const normalizedPhrase = normalizeSearchText(query);
    if (normalizedPhrase.length > 2) {
      combined.forEach((score, documentIndex) => {
        const fields = this.documents[documentIndex].normalizedFields;
        if (fields.title.includes(normalizedPhrase)) {
          combined.set(documentIndex, score + Number(this.config.exact_title_phrase_bonus ?? 12));
        } else if (Object.entries(fields).some(([field, value]) => field !== "title" && value.includes(normalizedPhrase))) {
          combined.set(documentIndex, score + Number(this.config.other_phrase_bonus ?? 5));
        }
      });
    }
    const matches = [...combined.entries()].map(([documentIndex, score]) => ({ documentIndex, score }))
      .sort((left, right) => right.score - left.score
        || String(this.documents[right.documentIndex].posted_on).localeCompare(String(this.documents[left.documentIndex].posted_on)));
    const uniqueCorrections = [...new Map(corrections.map((item) => [`${item.from}\u0000${item.to}`, item])).values()];
    const correctionMap = new Map(uniqueCorrections.map((item) => [normalizeSearchText(item.from), item.to]));
    const correctedQuery = uniqueCorrections.length
      ? queryTokens.map((token) => correctionMap.get(token.raw) ?? token.raw).join(" ")
      : "";
    return {
      matches,
      suggestions: this.suggest(query),
      corrections: uniqueCorrections,
      correctedQuery: correctedQuery !== normalizeSearchText(query) ? correctedQuery : "",
      highlightTerms: [...highlightTerms].filter(Boolean).sort((left, right) => right.length - left.length).slice(0, 64),
    };
  }

  suggest(rawQuery) {
    const normalized = normalizeSearchText(rawQuery);
    if (normalized.length < 2) return [];
    const queryWords = normalized.split(" ");
    const lastWord = lightStem(queryWords.at(-1), this.protectedTerms);
    const fuzzyAllowed = lastWord.length >= Number(this.config.fuzzy?.min_length ?? 4) && !this.protectedTerms.has(lastWord);
    const maximum = fuzzyAllowed ? this.maximumDistance(lastWord) : 0;
    const candidates = [];
    this.suggestions.forEach((suggestion) => {
      if (suggestion.normalized === normalized) return;
      let score = 0;
      if (suggestion.normalized.startsWith(normalized)) score = 10;
      else if (suggestion.normalized.split(" ").some((word) => word.startsWith(lastWord))) score = 7;
      else if (normalized.length >= 3 && suggestion.normalized.includes(normalized)) score = 5;
      else if (fuzzyAllowed) {
        const bestDistance = Math.min(...suggestion.normalized.split(" ")
          .filter((word) => Math.abs(word.length - lastWord.length) <= maximum)
          .map((word) => damerauLevenshtein(lastWord, lightStem(word, this.protectedTerms), maximum)), maximum + 1);
        if (bestDistance <= maximum) score = 3 - (bestDistance * 0.5);
      }
      if (!score) return;
      candidates.push({ ...suggestion, score: score + Math.log1p(suggestion.count) });
    });
    const categoryOrder = { Role: 0, Skill: 1, Focus: 2, Company: 3, Location: 4 };
    candidates.sort((left, right) => right.score - left.score
      || (categoryOrder[left.category] ?? 99) - (categoryOrder[right.category] ?? 99)
      || left.label.localeCompare(right.label));
    const categoryCounts = new Map();
    const results = [];
    for (const candidate of candidates) {
      if ((categoryCounts.get(candidate.category) ?? 0) >= 3) continue;
      results.push({ label: candidate.label, category: candidate.category, query: candidate.label });
      categoryCounts.set(candidate.category, (categoryCounts.get(candidate.category) ?? 0) + 1);
      if (results.length >= Number(this.config.suggestion_limit ?? 8)) break;
    }
    return results;
  }
}

const EMBEDDING_LIBRARY_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.0.1";
const STOPWORDS = new Set([
  "a", "about", "and", "are", "as", "at", "be", "been", "by", "for", "from", "has", "have",
  "in", "is", "it", "of", "on", "or", "our", "that", "the", "their", "this", "to", "we", "will",
  "with", "you", "your", "experience", "role", "team", "work", "years",
]);

export function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9+#.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenize(value) {
  return normalizeText(value).split(" ").filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

function hasAny(jobValues, selectedValues) {
  return !selectedValues.length || selectedValues.some((value) => jobValues.includes(value));
}

function postedCutoff(range, jobs) {
  const days = Number.parseInt(range, 10) || 7;
  if (days >= 7) return null;
  const latestPostedOn = jobs.reduce((latest, job) => String(job.posted_on) > latest ? String(job.posted_on) : latest, "");
  const cutoff = new Date(`${latestPostedOn}T00:00:00`);
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - (days - 1));
  return cutoff;
}

function compareExperience(left, right) {
  const a = left.yoe_min ?? Number.POSITIVE_INFINITY;
  const b = right.yoe_min ?? Number.POSITIVE_INFINITY;
  if (a !== b) return a - b;
  return (left.yoe_max ?? a) - (right.yoe_max ?? b);
}

export function filterAndSortJobs(jobs, filters, { shortlist = null, resumeActive = false } = {}) {
  const queryTokens = tokenize(filters.query);
  const location = normalizeText(filters.location);
  const cutoff = postedCutoff(filters.postedRange, jobs);
  const years = Number.parseInt(filters.experienceYears, 10);
  const yearsActive = Number.isInteger(years) && years >= 0;
  const filtered = jobs.filter((job) => {
    if (shortlist && !shortlist[job.id]) return false;
    if (cutoff && new Date(`${job.posted_on}T00:00:00`) < cutoff) return false;
    if (location && !job._locationSearch.includes(location)) return false;
    if (!hasAny(job._domains, filters.domains)) return false;
    if (!hasAny(job._specializations, filters.specializations)) return false;
    if (!hasAny(job._industries, filters.industries)) return false;
    if (yearsActive && job.yoe_min != null
      && (job.yoe_min > years || (job.yoe_max != null && job.yoe_max < years))) return false;
    if (filters.careerBuckets.length && !filters.careerBuckets.includes(job.career_bucket)) return false;
    if (filters.authorizationCategories.length && !filters.authorizationCategories.includes(job.authorization_category)) return false;
    if (filters.sponsorshipStatuses.length && !filters.sponsorshipStatuses.includes(job.sponsorship_status)) return false;
    return queryTokens.every((token) => job._searchText.includes(token));
  });

  filtered.sort((a, b) => {
    if (resumeActive) {
      return (b._resumeScore ?? -Infinity) - (a._resumeScore ?? -Infinity)
        || String(b.posted_on).localeCompare(String(a.posted_on));
    }
    if (filters.sort === "date_asc") return String(a.posted_on).localeCompare(String(b.posted_on));
    if (filters.sort === "experience_asc") return compareExperience(a, b);
    if (filters.sort === "experience_desc") return compareExperience(b, a);
    if (filters.sort === "company_asc") return a.company.localeCompare(b.company) || a.title.localeCompare(b.title);
    return String(b.posted_on).localeCompare(String(a.posted_on)) || a.company.localeCompare(b.company);
  });
  return filtered;
}

export function explainResumeMatch(job, resumeTokens) {
  const resumeSet = new Set(resumeTokens);
  const titleMatches = [...new Set(tokenize(job.title).filter((token) => resumeSet.has(token)))].slice(0, 4);
  const signalMatches = [...new Set((job.match_terms ?? []).filter((token) => resumeSet.has(normalizeText(token))))]
    .filter((token) => !titleMatches.includes(token))
    .slice(0, 6);
  return { titleMatches, signalMatches, semanticOnly: !titleMatches.length && !signalMatches.length };
}

function normalizeVector(vector) {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + (value * value), 0)) || 1;
  return vector.map((value) => value / norm);
}

function splitChunks(value, chunkWords = 150, overlapWords = 24, maxChunks = 8) {
  const words = String(value ?? "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const chunks = [];
  for (let start = 0; start < words.length; start += chunkWords - overlapWords) {
    chunks.push(words.slice(start, start + chunkWords).join(" "));
  }
  return chunks.length <= maxChunks ? chunks : [...chunks.slice(0, maxChunks - 1), chunks.at(-1)];
}

function tensorMean(tensor) {
  const dimension = tensor?.dims?.at(-1);
  const rows = tensor?.dims?.length > 1 ? tensor.dims[0] : 1;
  if (!dimension || !tensor?.data || tensor.data.length !== rows * dimension) {
    throw new Error("The local matcher returned an unexpected result.");
  }
  const mean = Array.from({ length: dimension }, () => 0);
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < dimension; column += 1) {
      mean[column] += Number(tensor.data[(row * dimension) + column]) / rows;
    }
  }
  return normalizeVector(mean);
}

export class ResumeMatcher {
  constructor(onProgress = () => {}) {
    this.onProgress = onProgress;
    this.manifest = null;
    this.vectors = null;
    this.indexById = null;
    this.extractor = null;
    this.mode = "";
    this.loadPromise = null;
  }

  async load() {
    if (this.extractor && this.vectors) return;
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = (async () => {
      this.onProgress("Loading the local semantic matcher…");
      const [manifestResponse, vectorsResponse] = await Promise.all([
        fetch("./data/job_embeddings_manifest.json"),
        fetch("./data/job_embeddings.bin"),
      ]);
      if (!manifestResponse.ok || !vectorsResponse.ok) throw new Error("Semantic matching files are unavailable.");
      this.manifest = await manifestResponse.json();
      const bytes = await vectorsResponse.arrayBuffer();
      const jobs = this.manifest.jobs ?? [];
      const dimension = Number(this.manifest.dimension);
      if (!dimension || bytes.byteLength !== jobs.length * dimension * 4) throw new Error("Semantic matching files are inconsistent.");
      this.vectors = new Float32Array(bytes);
      this.indexById = new Map(jobs.map((entry) => [entry.id, Number(entry.index)]));
      const { pipeline } = await import(EMBEDDING_LIBRARY_URL);
      const attempts = navigator.gpu
        ? [["WebGPU", { device: "webgpu" }], ["WASM/CPU", { dtype: "q8" }]]
        : [["WASM/CPU", { dtype: "q8" }]];
      let lastError;
      for (const [label, options] of attempts) {
        try {
          this.onProgress(`Starting local ${label} matching…`);
          this.extractor = await pipeline("feature-extraction", this.manifest.browser_model_id, options);
          this.mode = label;
          return;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError || new Error("No local semantic runtime is available.");
    })().catch((error) => { this.loadPromise = null; throw error; });
    return this.loadPromise;
  }

  async score(rawResume, jobs) {
    const resumeTokens = [...new Set(tokenize(rawResume))];
    try {
      await this.load();
      const chunks = splitChunks(rawResume);
      const tensor = await this.extractor(chunks, { pooling: "mean", normalize: true });
      const embedding = tensorMean(tensor);
      const dimension = Number(this.manifest.dimension);
      jobs.forEach((job) => {
        const row = this.indexById.get(job.id);
        if (row === undefined) { job._resumeScore = -Infinity; return; }
        let score = 0;
        for (let index = 0; index < dimension; index += 1) score += embedding[index] * this.vectors[(row * dimension) + index];
        job._resumeScore = score;
      });
      return { mode: `Semantic · ${this.mode}`, resumeTokens };
    } catch (error) {
      this.onProgress("Semantic matching was unavailable; using transparent keyword matching.");
      const query = new Set(resumeTokens);
      jobs.forEach((job) => {
        const titleMatches = tokenize(job.title).filter((token) => query.has(token)).length;
        const termMatches = (job.match_terms ?? []).filter((token) => query.has(normalizeText(token))).length;
        job._resumeScore = (titleMatches * 3) + termMatches;
      });
      return { mode: "Keyword fallback", resumeTokens, fallbackReason: error.message };
    }
  }
}

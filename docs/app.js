const state = {
  payload: null,
  search: "",
  locationQuery: "",
  careerBucket: "",
  authorizationCategory: "",
  sponsorshipStatus: "",
  sort: "date_desc",
  currentPage: 1,
  resumeActive: false,
  resumeTokenSet: null,
};

const PAGE_SIZE = 20;
const RESUME_MATCH_MIN_CHARS = 200;
const RESUME_MATCH_MIN_TOKENS = 20;
const RESUME_MATCH_STOPWORDS = new Set([
  "a",
  "about",
  "above",
  "after",
  "again",
  "against",
  "all",
  "also",
  "am",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "because",
  "been",
  "before",
  "being",
  "below",
  "between",
  "both",
  "but",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "doing",
  "down",
  "during",
  "each",
  "few",
  "for",
  "from",
  "further",
  "had",
  "has",
  "have",
  "having",
  "he",
  "her",
  "here",
  "hers",
  "herself",
  "him",
  "himself",
  "his",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "itself",
  "just",
  "me",
  "more",
  "most",
  "my",
  "myself",
  "no",
  "nor",
  "not",
  "now",
  "of",
  "off",
  "on",
  "once",
  "only",
  "or",
  "other",
  "our",
  "ours",
  "ourselves",
  "out",
  "over",
  "own",
  "same",
  "she",
  "should",
  "so",
  "some",
  "such",
  "than",
  "that",
  "the",
  "their",
  "theirs",
  "them",
  "themselves",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "through",
  "to",
  "too",
  "under",
  "until",
  "up",
  "very",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "who",
  "whom",
  "why",
  "will",
  "with",
  "you",
  "your",
  "yours",
  "yourself",
  "yourselves",
]);

const els = {
  generatedAt: document.getElementById("generated-at"),
  repoLink: document.getElementById("repo-link"),
  statTotal: document.getElementById("stat-total"),
  statEarly: document.getElementById("stat-early"),
  statMid: document.getElementById("stat-mid"),
  statManagerial: document.getElementById("stat-managerial"),
  searchInput: document.getElementById("search-input"),
  locationInput: document.getElementById("location-input"),
  locationSuggestions: document.getElementById("location-suggestions"),
  careerFilter: document.getElementById("career-filter"),
  authFilter: document.getElementById("auth-filter"),
  sponsorshipFilter: document.getElementById("sponsorship-filter"),
  sortSelect: document.getElementById("sort-select"),
  sortGroup: document.getElementById("sort-select")?.closest(".control-group"),
  resetButton: document.getElementById("reset-button"),
  resumeInput: document.getElementById("resume-input"),
  resumeApplyButton: document.getElementById("resume-apply-button"),
  resumeClearButton: document.getElementById("resume-clear-button"),
  resumeStatus: document.getElementById("resume-status"),
  resultsMeta: document.getElementById("results-meta"),
  resultsBody: document.getElementById("results-body"),
  emptyState: document.getElementById("empty-state"),
  paginationShell: document.getElementById("pagination-shell"),
  paginationSummary: document.getElementById("pagination-summary"),
  paginationPrev: document.getElementById("pagination-prev"),
  paginationNext: document.getElementById("pagination-next"),
  paginationPages: document.getElementById("pagination-pages"),
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatDate(value) {
  return value ? String(value) : "Unknown";
}

function formatEnumLabel(value) {
  return String(value ?? "")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeComparableText(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeComparable(value) {
  return normalizeComparableText(value)
    .split(" ")
    .map((token) => token.trim())
    .filter(Boolean);
}

function tokenizeResumeMatch(value) {
  return normalizeComparableText(value)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token && !RESUME_MATCH_STOPWORDS.has(token));
}

function buildResumeTokenSet(value) {
  return new Set(tokenizeResumeMatch(value));
}

function countNonWhitespaceChars(value) {
  return String(value ?? "").replace(/\s+/g, "").length;
}

function maybeParseStructuredLocation(text) {
  if (typeof text !== "string") {
    return text;
  }
  const trimmed = text.trim();
  if (!trimmed || (trimmed[0] !== "[" && trimmed[0] !== "{")) {
    return text;
  }

  const jsonish = trimmed
    .replace(/\bNone\b/g, "null")
    .replace(/\bTrue\b/g, "true")
    .replace(/\bFalse\b/g, "false");

  try {
    return JSON.parse(jsonish.replaceAll("'", '"'));
  } catch {
    return text;
  }
}

function coerceLocationText(value) {
  const parsed = maybeParseStructuredLocation(value);
  if (parsed !== value) {
    return coerceLocationText(parsed);
  }
  if (value == null) {
    return "";
  }
  if (typeof value === "string") {
    return value.trim();
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => coerceLocationText(item))
      .flatMap((item) => item.split(" | "))
      .map((item) => item.trim())
      .filter(Boolean);
    return unique(parts).join(" | ");
  }
  if (typeof value === "object") {
    const parts = [];
    for (const key of [
      "name",
      "location",
      "city",
      "region",
      "state",
      "country",
      "addressLocality",
      "addressRegion",
      "addressCountry",
    ]) {
      const part = value[key];
      if (typeof part === "string" && part.trim()) {
        parts.push(part.trim());
      }
    }
    if (!("country" in value || "addressCountry" in value)) {
      const countryCode = value.countryCode;
      if (typeof countryCode === "string" && countryCode.trim()) {
        parts.push(countryCode.trim());
      }
    }
    return unique(parts).join(", ");
  }
  return String(value).trim();
}

function normalizeLocation(value) {
  const text = coerceLocationText(value) || "Unknown";
  return text
    .replace(/\s*;\s*/g, " | ")
    .replace(/\s*\|\s*/g, " | ")
    .replace(/\s+/g, " ")
    .trim();
}

function smartTitleCompanyToken(token) {
  if (!token) {
    return "";
  }
  if (/^\d+$/.test(token)) {
    return token;
  }
  if (/^[a-z]{1,5}$/.test(token)) {
    return token.toUpperCase();
  }
  if (/\d/.test(token)) {
    return token[0].toUpperCase() + token.slice(1);
  }
  return token[0].toUpperCase() + token.slice(1).toLowerCase();
}

function prettifyCompanySlug(value) {
  let text = String(value ?? "").trim().replace(/\/+$/, "");
  if (!text) {
    return "";
  }
  text = text.replace(/-\d+$/, "");
  text = text.replace(/(jobswd|jobsandcareers|jobsandcareer)$/i, "");
  text = text.replace(
    /(careers|career|jobs|job|externalcareersite|externalcareer_site|externalcareers|externalsite|external_site|external|globalexternalsite|global_external_site|global1|global|search|targeted|join|site)$/i,
    "",
  );
  text = text.replace(/^rec_/i, "");
  text = text.replace(/_ext_/gi, "_");
  text = text.replace(/_external_/gi, "_");
  text = text.replace(/[_/-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }
  return text
    .split(" ")
    .filter(Boolean)
    .map((token) => smartTitleCompanyToken(token))
    .join(" ");
}

function normalizeCompany(value) {
  const text = String(value ?? "").trim();
  if (!text) {
    return "Unknown";
  }
  const workdayMatch = text.match(/\/wd\d+\/([^/]+)/i);
  if (workdayMatch) {
    return prettifyCompanySlug(workdayMatch[1]) || prettifyCompanySlug(text.split("/")[0]) || text;
  }
  if (text.includes("/")) {
    const first = text.split("/")[0];
    const cleaned = prettifyCompanySlug(first);
    if (cleaned) {
      return cleaned;
    }
  }
  const cleaned = prettifyCompanySlug(text);
  return cleaned || text;
}

function buildLocationContext(locationValue, locationProfile = null) {
  const profile = locationProfile && typeof locationProfile === "object" ? locationProfile : {};
  const display = normalizeLocation(profile.display || locationValue);
  const region = profile.region || "";
  const regionCode = profile.region_code || "";
  const country = profile.country || "";
  const countryCode = profile.country_code || "";
  const city = profile.city || "";
  const label = profile.label || unique([city, region, country]).join(", ") || display;

  const parsed = maybeParseStructuredLocation(locationValue);
  const rawParts =
    parsed && typeof parsed === "object"
      ? tokenizeComparable(coerceLocationText(parsed))
      : [];

  const searchTerms = unique([
    display,
    label,
    city,
    region,
    regionCode,
    country,
    countryCode,
    ...(Array.isArray(profile.search_terms) ? profile.search_terms : []),
    ...rawParts,
  ]);

  const normalizedTerms = unique(searchTerms.map((term) => normalizeComparableText(term)).filter(Boolean));
  const candidateTokens = unique(normalizedTerms.flatMap((term) => term.split(" ")).filter(Boolean));

  return {
    display,
    label,
    city,
    region,
    regionCode,
    country,
    countryCode,
    searchTerms,
    normalizedTerms,
    candidateTokens,
    searchText: normalizedTerms.join(" "),
  };
}

function buildLocationSuggestions(jobs) {
  const counts = new Map();
  jobs.forEach((job) => {
    const suggestion = job.locationContext.label || job.locationContext.display;
    if (!suggestion || suggestion === "Unknown") {
      return;
    }
    counts.set(suggestion, (counts.get(suggestion) ?? 0) + 1);
  });

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 80)
    .map(([value]) => value);
}

function populateDatalist(list, options) {
  list.innerHTML = "";
  options.forEach((option) => {
    const el = document.createElement("option");
    el.value = option;
    list.appendChild(el);
  });
}

function populateSelect(select, options) {
  options.forEach((option) => {
    const el = document.createElement("option");
    el.value = option.value;
    el.textContent = option.count !== undefined ? `${option.label} (${option.count})` : option.label;
    select.appendChild(el);
  });
}

function levenshteinDistance(left, right) {
  if (left === right) {
    return 0;
  }
  if (!left.length) {
    return right.length;
  }
  if (!right.length) {
    return left.length;
  }

  const rows = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let previous = i - 1;
    rows[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const current = rows[j];
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      rows[j] = Math.min(
        rows[j] + 1,
        rows[j - 1] + 1,
        previous + cost,
      );
      previous = current;
    }
  }
  return rows[right.length];
}

function fuzzyTokenMatch(queryToken, candidateTokens) {
  if (!queryToken) {
    return true;
  }

  for (const candidate of candidateTokens) {
    if (candidate === queryToken || candidate.startsWith(queryToken) || candidate.includes(queryToken)) {
      return true;
    }
    if (queryToken.length < 4 || Math.abs(candidate.length - queryToken.length) > 2) {
      continue;
    }
    const allowance = queryToken.length >= 8 ? 2 : 1;
    if (levenshteinDistance(queryToken, candidate) <= allowance) {
      return true;
    }
  }
  return false;
}

function matchesLocationQuery(job, query) {
  const normalizedQuery = normalizeComparableText(query);
  if (!normalizedQuery) {
    return true;
  }
  if (job.locationContext.searchText.includes(normalizedQuery)) {
    return true;
  }
  const queryTokens = tokenizeComparable(normalizedQuery);
  return queryTokens.every((token) => fuzzyTokenMatch(token, job.locationContext.candidateTokens));
}

function loadStats(payload) {
  els.statTotal.textContent = payload.total_openings ?? 0;
  const bucketCounts = Object.fromEntries(payload.career_buckets.map((bucket) => [bucket.value, bucket.count]));
  els.statEarly.textContent = bucketCounts.early_career_or_new_grad ?? 0;
  els.statMid.textContent = bucketCounts.mid_career_or_senior ?? 0;
  els.statManagerial.textContent = bucketCounts.managerial ?? 0;
  els.generatedAt.textContent = `Updated ${payload.generated_at} · window: last ${payload.posted_within_days} day(s)`;
  if (payload.repo_url) {
    els.repoLink.href = payload.repo_url;
  }
}

function compareExperience(a, b) {
  const left = a.yoe_min ?? Number.POSITIVE_INFINITY;
  const right = b.yoe_min ?? Number.POSITIVE_INFINITY;
  if (left !== right) {
    return left - right;
  }
  const leftMax = a.yoe_max ?? a.yoe_min ?? Number.POSITIVE_INFINITY;
  const rightMax = b.yoe_max ?? b.yoe_min ?? Number.POSITIVE_INFINITY;
  if (leftMax !== rightMax) {
    return leftMax - rightMax;
  }
  return String(a.posted_on).localeCompare(String(b.posted_on));
}

function sortJobs(jobs) {
  jobs.sort((a, b) => {
    if (state.sort === "date_asc") {
      return String(a.posted_on).localeCompare(String(b.posted_on));
    }
    if (state.sort === "experience_asc") {
      return compareExperience(a, b);
    }
    if (state.sort === "experience_desc") {
      return compareExperience(b, a);
    }
    if (state.sort === "company_asc") {
      return String(a.company).localeCompare(String(b.company)) || String(a.title).localeCompare(String(b.title));
    }
    return String(b.posted_on).localeCompare(String(a.posted_on));
  });
  return jobs;
}

function ensureResumeMatchIndex(job) {
  if (!job.resumeTitleTokens) {
    job.resumeTitleTokens = buildResumeTokenSet(job.title);
  }
  if (!job.resumeDescriptionTokens) {
    job.resumeDescriptionTokens = buildResumeTokenSet(job.job_description);
  }
}

function scoreJobAgainstResume(job, resumeTokenSet) {
  ensureResumeMatchIndex(job);

  let titleTokenOverlap = 0;
  for (const token of job.resumeTitleTokens) {
    if (resumeTokenSet.has(token)) {
      titleTokenOverlap += 1;
    }
  }

  let jdTokenOverlap = 0;
  for (const token of job.resumeDescriptionTokens) {
    if (resumeTokenSet.has(token)) {
      jdTokenOverlap += 1;
    }
  }

  return (3 * titleTokenOverlap) + jdTokenOverlap;
}

function applyFilters(jobs) {
  const query = normalizeComparableText(state.search);
  const filtered = jobs.filter((job) => {
    if (!matchesLocationQuery(job, state.locationQuery)) {
      return false;
    }
    if (state.careerBucket && job.career_bucket !== state.careerBucket) {
      return false;
    }
    if (state.authorizationCategory && job.authorization_category !== state.authorizationCategory) {
      return false;
    }
    if (state.sponsorshipStatus && job.sponsorship_status !== state.sponsorshipStatus) {
      return false;
    }
    if (!query) {
      return true;
    }
    const haystack = normalizeComparableText(
      [
        job.title,
        job.company,
        job.locationContext.display,
        job.locationContext.label,
        job.career_bucket_label,
        job.authorization_category_label,
        job.work_authorization_display,
        job.experience_display,
      ].join(" "),
    );
    return haystack.includes(query);
  });

  if (!state.resumeActive || !state.resumeTokenSet || state.resumeTokenSet.size === 0) {
    return sortJobs(filtered);
  }

  const matched = [];
  filtered.forEach((job) => {
    job.resumeMatchScore = scoreJobAgainstResume(job, state.resumeTokenSet);
    if (job.resumeMatchScore > 0) {
      matched.push(job);
    }
  });

  matched.sort((a, b) => (
    b.resumeMatchScore - a.resumeMatchScore
    || String(b.posted_on).localeCompare(String(a.posted_on))
    || String(a.company).localeCompare(String(b.company))
    || String(a.title).localeCompare(String(b.title))
  ));

  return matched;
}

function getPagination(totalItems) {
  const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
  const currentPage = Math.min(state.currentPage, totalPages);
  const startIndex = totalItems ? (currentPage - 1) * PAGE_SIZE : 0;
  const endIndex = Math.min(startIndex + PAGE_SIZE, totalItems);

  return {
    totalPages,
    currentPage,
    startIndex,
    endIndex,
  };
}

function buildVisiblePageNumbers(totalPages, currentPage) {
  const pages = [];
  const startPage = Math.max(1, currentPage - 2);
  const endPage = Math.min(totalPages, startPage + 4);
  const adjustedStart = Math.max(1, endPage - 4);

  for (let page = adjustedStart; page <= endPage; page += 1) {
    pages.push(page);
  }
  return pages;
}

function renderPagination(totalItems, pagination) {
  const { totalPages, currentPage, startIndex, endIndex } = pagination;
  const shownStart = totalItems ? startIndex + 1 : 0;

  els.paginationSummary.textContent = `Showing ${shownStart}-${endIndex} of ${totalItems} job${totalItems === 1 ? "" : "s"}`;
  els.paginationPrev.disabled = currentPage <= 1;
  els.paginationNext.disabled = currentPage >= totalPages;
  els.paginationShell.classList.toggle("hidden", totalItems === 0);

  if (totalItems === 0) {
    els.paginationPages.innerHTML = "";
    return;
  }

  const visiblePages = buildVisiblePageNumbers(totalPages, currentPage);
  const buttons = [];

  if (visiblePages[0] > 1) {
    buttons.push(
      `<button class="pagination-page" type="button" data-page="1">1</button>`,
    );
    if (visiblePages[0] > 2) {
      buttons.push('<span class="pagination-ellipsis" aria-hidden="true">...</span>');
    }
  }

  visiblePages.forEach((page) => {
    buttons.push(
      `<button class="pagination-page${page === currentPage ? " is-active" : ""}" type="button" data-page="${page}"${page === currentPage ? ' aria-current="page"' : ""}>${page}</button>`,
    );
  });

  if (visiblePages[visiblePages.length - 1] < totalPages) {
    if (visiblePages[visiblePages.length - 1] < totalPages - 1) {
      buttons.push('<span class="pagination-ellipsis" aria-hidden="true">...</span>');
    }
    buttons.push(
      `<button class="pagination-page" type="button" data-page="${totalPages}">${totalPages}</button>`,
    );
  }

  els.paginationPages.innerHTML = buttons.join("");
}

function renderRows(jobs) {
  if (!jobs.length) {
    els.resultsBody.innerHTML = "";
    els.emptyState.classList.remove("hidden");
    if (state.resumeActive) {
      els.emptyState.innerHTML = "<h3>No jobs match your filters and resume text.</h3><p>Try broadening your filters or pasting a fuller resume snapshot.</p>";
      els.resultsMeta.textContent = "0 jobs match the current filters and resume text.";
    } else {
      els.emptyState.innerHTML = "<h3>No jobs match the current filters.</h3><p>Try clearing one or more filters or broadening your search.</p>";
      els.resultsMeta.textContent = "0 jobs match the current filters.";
    }
    return;
  }

  els.emptyState.classList.add("hidden");
  els.resultsBody.innerHTML = jobs
    .map(
      (job) => `
        <tr>
          <td data-label="Date"><span class="cell-date">${escapeHtml(formatDate(job.posted_on))}</span></td>
          <td data-label="Company"><span class="cell-primary">${escapeHtml(job.company)}</span></td>
          <td data-label="Role">
            <span class="cell-primary">${escapeHtml(job.title)}</span>
            <span class="cell-subtext">Experience: ${escapeHtml(job.experience_display)}</span>
            ${state.resumeActive ? '<span class="cell-match-note">Resume match</span>' : ""}
          </td>
          <td data-label="Location"><span class="cell-secondary">${escapeHtml(job.locationContext.label || job.locationContext.display)}</span></td>
          <td data-label="Snapshot">
            <div class="snapshot-stack">
              <div class="snapshot-item">
                <span class="snapshot-label">Bucket</span>
                <span class="pill pill-bucket">${escapeHtml(job.career_bucket_label)}</span>
              </div>
              <div class="snapshot-item">
                <span class="snapshot-label">Authorization</span>
                <span class="pill pill-auth">${escapeHtml(job.authorization_category_label)}</span>
              </div>
              <div class="snapshot-item">
                <span class="snapshot-label">Sponsorship</span>
                <span class="pill pill-neutral">${escapeHtml(formatEnumLabel(job.sponsorship_status))}</span>
              </div>
            </div>
          </td>
          <td data-label="Link"><a class="link-button" href="${escapeHtml(job.job_link)}" target="_blank" rel="noopener noreferrer">Apply</a></td>
        </tr>
      `,
    )
    .join("");
}

function setResumeStatus(message = "", tone = "idle") {
  els.resumeStatus.textContent = message;
  els.resumeStatus.classList.toggle("is-active", tone === "active");
  els.resumeStatus.classList.toggle("is-error", tone === "error");
}

function updateSortControlState() {
  els.sortSelect.disabled = state.resumeActive;
  if (els.sortGroup) {
    els.sortGroup.classList.toggle("is-disabled", state.resumeActive);
  }
  els.sortSelect.title = state.resumeActive
    ? "Sorting is locked to resume match while resume mode is active."
    : "";
}

function getResumeValidationMessage(rawText) {
  const charCount = countNonWhitespaceChars(rawText);
  const tokenCount = tokenizeResumeMatch(rawText).length;
  if (charCount >= RESUME_MATCH_MIN_CHARS && tokenCount >= RESUME_MATCH_MIN_TOKENS) {
    return "";
  }

  const parts = [];
  if (charCount < RESUME_MATCH_MIN_CHARS) {
    parts.push(`at least ${RESUME_MATCH_MIN_CHARS} non-whitespace characters`);
  }
  if (tokenCount < RESUME_MATCH_MIN_TOKENS) {
    parts.push(`at least ${RESUME_MATCH_MIN_TOKENS} normalized tokens`);
  }
  return `Paste ${parts.join(" and ")} before running resume match.`;
}

function applyResumeMatch() {
  const rawText = els.resumeInput.value;
  const validationMessage = getResumeValidationMessage(rawText);
  if (validationMessage) {
    setResumeStatus(
      state.resumeActive
        ? `${validationMessage} Current resume match is still active.`
        : validationMessage,
      "error",
    );
    return;
  }

  state.resumeTokenSet = new Set(tokenizeResumeMatch(rawText));
  state.resumeActive = true;
  state.currentPage = 1;
  setResumeStatus(
    "Resume match is active. Results now show only jobs with overlapping title or description terms.",
    "active",
  );
  render();
}

function clearResumeMatch() {
  state.resumeActive = false;
  state.resumeTokenSet = null;
  state.currentPage = 1;
  els.resumeInput.value = "";
  setResumeStatus("", "idle");
  render();
}

function render() {
  if (!state.payload) {
    return;
  }

  updateSortControlState();
  const filteredJobs = applyFilters(state.payload.jobs);
  const pagination = getPagination(filteredJobs.length);
  state.currentPage = pagination.currentPage;

  const paginatedJobs = filteredJobs.slice(pagination.startIndex, pagination.endIndex);
  els.resultsMeta.textContent = state.resumeActive
    ? `${filteredJobs.length} job${filteredJobs.length === 1 ? "" : "s"} match the current filters and resume text. Sorted by resume match.`
    : `${filteredJobs.length} job${filteredJobs.length === 1 ? "" : "s"} match the current filters.`;
  renderRows(paginatedJobs);
  renderPagination(filteredJobs.length, pagination);
}

function bindControls() {
  els.searchInput.addEventListener("input", (event) => {
    state.search = event.target.value;
    state.currentPage = 1;
    render();
  });
  els.locationInput.addEventListener("input", (event) => {
    state.locationQuery = event.target.value;
    state.currentPage = 1;
    render();
  });
  els.careerFilter.addEventListener("change", (event) => {
    state.careerBucket = event.target.value;
    state.currentPage = 1;
    render();
  });
  els.authFilter.addEventListener("change", (event) => {
    state.authorizationCategory = event.target.value;
    state.currentPage = 1;
    render();
  });
  els.sponsorshipFilter.addEventListener("change", (event) => {
    state.sponsorshipStatus = event.target.value;
    state.currentPage = 1;
    render();
  });
  els.sortSelect.addEventListener("change", (event) => {
    state.sort = event.target.value;
    state.currentPage = 1;
    render();
  });
  els.resetButton.addEventListener("click", () => {
    state.search = "";
    state.locationQuery = "";
    state.careerBucket = "";
    state.authorizationCategory = "";
    state.sponsorshipStatus = "";
    state.sort = "date_desc";
    state.currentPage = 1;
    els.searchInput.value = "";
    els.locationInput.value = "";
    els.careerFilter.value = "";
    els.authFilter.value = "";
    els.sponsorshipFilter.value = "";
    els.sortSelect.value = "date_desc";
    render();
  });
  els.resumeInput.addEventListener("input", () => {
    if (els.resumeStatus.classList.contains("is-error")) {
      setResumeStatus(
        state.resumeActive
          ? "Resume match is active. Click Find matches again to refresh results with the edited text."
          : "",
        state.resumeActive ? "active" : "idle",
      );
    }
  });
  els.resumeApplyButton.addEventListener("click", applyResumeMatch);
  els.resumeClearButton.addEventListener("click", clearResumeMatch);
  els.paginationPrev.addEventListener("click", () => {
    if (state.currentPage <= 1) {
      return;
    }
    state.currentPage -= 1;
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  els.paginationNext.addEventListener("click", () => {
    state.currentPage += 1;
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  els.paginationPages.addEventListener("click", (event) => {
    const button = event.target.closest("[data-page]");
    if (!button) {
      return;
    }
    const page = Number(button.dataset.page);
    if (!Number.isFinite(page) || page < 1 || page === state.currentPage) {
      return;
    }
    state.currentPage = page;
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
}

async function init() {
  const response = await fetch("./data/public_jobs.json");
  if (!response.ok) {
    throw new Error(`Failed to load site data: ${response.status}`);
  }

  state.payload = await response.json();
  state.payload.jobs = (state.payload.jobs ?? []).map((job) => {
    const company = normalizeCompany(job.company);
    const location = normalizeLocation(job.location);
    return {
      ...job,
      company,
      location,
      locationContext: buildLocationContext(location, job.location_profile),
    };
  });

  loadStats(state.payload);
  populateDatalist(els.locationSuggestions, buildLocationSuggestions(state.payload.jobs));
  populateSelect(els.careerFilter, state.payload.career_buckets);
  populateSelect(els.authFilter, state.payload.authorization_categories);
  populateSelect(els.sponsorshipFilter, state.payload.sponsorship_statuses);
  bindControls();
  render();
}

init().catch((error) => {
  els.resultsMeta.textContent = "Could not load the job board data.";
  els.resultsBody.innerHTML = "";
  els.emptyState.classList.remove("hidden");
  els.emptyState.innerHTML = `<h3>Data load failed.</h3><p>${escapeHtml(error.message)}</p>`;
});

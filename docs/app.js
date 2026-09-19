import {
  DEFAULT_FILTERS,
  STORAGE_KEY,
  freshFilters,
  loadStorage,
  pruneShortlist,
  saveStorage,
  sanitizeFilters,
  toggleShortlist,
} from "./storage.js";
import { countFacetValues, explainResumeMatch, filterAndSortJobs, normalizeText, ResumeMatcher, sortFacetItems, tokenize } from "./matching.js";
import { isCurrentSearchResponse } from "./search.js";
import { createMarketAnalysis } from "./market-analysis.js";
import { createProductTour } from "./product-tour.js";

const PAGE_BATCH = 40;
const FILTER_PARAM_MAP = {
  query: "q",
  domains: "domain",
  specializations: "specialization",
  industries: "industry",
  location: "location",
  careerBuckets: "career",
  authorizationCategories: "authorization",
  sponsorshipStatuses: "sponsorship",
  experienceYears: "years",
  postedRange: "posted",
  sort: "sort",
};
const ARRAY_FILTERS = new Set([
  "domains", "specializations", "industries", "careerBuckets", "authorizationCategories", "sponsorshipStatuses",
]);

const state = {
  payload: null,
  jobs: [],
  filters: freshFilters(),
  shortlist: {},
  view: "all",
  visibleLimit: PAGE_BATCH,
  selectedId: "",
  selectionPinned: false,
  storageWarning: "",
  resumeActive: false,
  resumeTokens: [],
  resumeMode: "",
  searchReady: false,
  searchPending: false,
  searchFailed: false,
  searchScores: null,
  searchLexicalCount: null,
  searchSuggestions: [],
  searchHighlightTerms: [],
  searchCorrectedQuery: "",
  suggestionIndex: -1,
  suggestionsOpen: false,
  latestSearchRequestId: 0,
  emptyActionMode: "clear-filters",
  resumeBusy: false,
  resumeCancelRequested: false,
  resumeRunId: 0,
  companyBrands: {},
};

const els = Object.fromEntries([
  "freshness", "job-count", "filter-apply", "all-count", "shortlist-count", "repo-link", "resume-open", "search-input", "search-clear", "search-state",
  "search-suggestions", "search-assist", "mobile-filter-open",
  "mobile-filter-close", "mobile-filter-count", "filter-panel", "domain-filter", "specialization-filter",
  "industry-filter", "location-filter", "location-suggestions", "career-filter", "experience-years-filter", "authorization-filter",
  "sponsorship-filter", "posted-filter", "sort-filter", "advanced-filters-toggle", "advanced-filter-count", "clear-filters", "active-filters", "storage-warning",
  "results-heading", "results-summary", "shortlist-clear-filters", "sort-note", "results-trust-copy", "match-mode", "job-list", "empty-state", "empty-title", "empty-copy",
  "empty-action", "empty-suggestions", "load-more", "detail-pane", "detail-empty", "detail-content", "sheet-backdrop", "resume-dialog",
  "resume-input", "resume-status", "resume-progress", "resume-clear", "resume-cancel", "resume-apply", "toast", "board-content", "search-shell", "jobs-workspace",
].map((id) => [id.replaceAll("-", "_"), document.getElementById(id)]));

const resumeMatcher = new ResumeMatcher((message) => setResumeStatus(message));
const marketAnalysis = createMarketAnalysis();
const productTour = createProductTour();
let searchWorker = null;
let searchTimer = null;
let toastTimer = null;
let renderedFacetState = "";
let advancedFiltersOpen = false;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightText(value, terms = state.searchHighlightTerms) {
  const text = String(value ?? "");
  if (!state.filters.query || !terms.length) return escapeHtml(text);
  const alternatives = [...new Set(terms.map((term) => String(term).trim()).filter(Boolean))]
    .sort((left, right) => right.length - left.length)
    .map(escapeRegExp);
  if (!alternatives.length) return escapeHtml(text);
  const matcher = new RegExp(`(^|[^a-z0-9+#.])(${alternatives.join("|")})(?=$|[^a-z0-9+#.])`, "gi");
  let output = "";
  let cursor = 0;
  for (const match of text.matchAll(matcher)) {
    const start = match.index + match[1].length;
    const end = start + match[2].length;
    output += escapeHtml(text.slice(cursor, start));
    output += `<mark>${escapeHtml(text.slice(start, end))}</mark>`;
    cursor = end;
  }
  return output + escapeHtml(text.slice(cursor));
}

function bookmarkIcon() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4.8A1.8 1.8 0 0 1 7.8 3h8.4A1.8 1.8 0 0 1 18 4.8V21l-6-4-6 4V4.8Z"/></svg>';
}

function closeIcon() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
}

function formatCount(value) {
  return new Intl.NumberFormat("en-US").format(Number(value) || 0);
}

function jobAgeDays(value) {
  const date = new Date(`${value}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((today - date) / 86400000));
}

function formatCalendarDate(value, { includeYear = true } = {}) {
  const raw = String(value || "");
  const date = new Date(raw.length === 10 ? `${raw}T12:00:00` : raw);
  if (Number.isNaN(date.getTime())) return String(value || "Unknown date");
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(includeYear ? { year: "numeric" } : {}),
  });
}

function compactJobDate(value) {
  const raw = String(value || "");
  const date = new Date(raw.length === 10 ? `${raw}T12:00:00` : raw);
  if (Number.isNaN(date.getTime())) return escapeHtml(value || "Unknown");
  const month = date.toLocaleDateString(undefined, { month: "short" });
  const day = date.toLocaleDateString(undefined, { day: "numeric" });
  const label = formatCalendarDate(value, { includeYear: false });
  return `<span class="job-age-date" aria-label="${escapeHtml(label)}">`
    + `<span class="job-age-month" aria-hidden="true">${escapeHtml(month)}</span>`
    + `<span class="job-age-day" aria-hidden="true">${escapeHtml(day)}</span>`
    + `</span>`;
}

function formatGeneratedAt(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Current US openings";
  return `Updated ${formatCalendarDate(date.toISOString().slice(0, 10))} · 7-day feed`;
}

function renderFlapCount(total) {
  if (!els.job_count) return;
  const text = formatCount(total);
  els.job_count.setAttribute("aria-label", `${text} open roles`);
  els.job_count.innerHTML = [...text].map((ch, i) =>
    `<span class="flap-tile${/\d/.test(ch) ? "" : " flap-sep"}" style="--i:${i}">${escapeHtml(ch)}</span>`).join("");
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  els.job_count.querySelectorAll(".flap-tile:not(.flap-sep)").forEach((tile, index) => {
    const finalDigit = Number(tile.textContent);
    let remaining = 5 + index * 3;
    const timer = window.setInterval(() => {
      remaining -= 1;
      tile.textContent = String(remaining <= 0 ? finalDigit : (finalDigit + remaining) % 10);
      if (remaining <= 0) window.clearInterval(timer);
    }, 70);
  });
}

function companyInitials(value) {
  return String(value || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function companyAvatar(company, variant = "") {
  const brand = state.companyBrands[String(company || "")];
  const logo = brand?.logo;
  const variantClass = variant ? ` company-avatar-${variant}` : "";
  return `<span class="company-avatar${variantClass}${logo ? " has-logo" : ""}">`
    + `<span class="company-initials">${escapeHtml(companyInitials(company))}</span>`
    + (logo ? `<img class="company-logo" src="${escapeHtml(logo)}" alt="" loading="lazy" decoding="async">` : "")
    + `</span>`;
}

function taxonomyMaps(payload) {
  const domains = new Map();
  const specializations = new Map();
  const industries = new Map();
  (payload.taxonomy?.domains ?? []).forEach((domain) => {
    domains.set(domain.value, domain.label);
    (domain.specializations ?? []).forEach((specialization) => specializations.set(specialization.value, specialization.label));
  });
  (payload.taxonomy?.industries ?? []).forEach((industry) => industries.set(industry.value, industry.label));
  return { domains, specializations, industries };
}

function prepareJobs(payload) {
  const labels = taxonomyMaps(payload);
  return (payload.jobs ?? []).map((job) => {
    const paths = job.classification_paths ?? [];
    const domains = [...new Set(paths.map((path) => path.domain).filter(Boolean))];
    const specializations = [...new Set(paths.flatMap((path) => path.specializations ?? []).filter(Boolean))];
    const industries = [...new Set(paths.map((path) => path.industry).filter(Boolean))];
    const taxonomyLabels = [
      ...domains.map((value) => labels.domains.get(value) || value),
      ...specializations.map((value) => labels.specializations.get(value) || value),
      ...industries.map((value) => labels.industries.get(value) || value),
    ];
    const taxonomyText = taxonomyLabels.join(" ");
    return {
      ...job,
      _domains: domains,
      _specializations: specializations,
      _industries: industries,
      _taxonomyLabels: taxonomyLabels,
      _locationSearch: normalizeText([job.location, ...(job.location_profile?.search_terms ?? [])].join(" ")),
      _searchText: normalizeText([
        job.title, job.company, job.location, job.experience_display, job.work_authorization_display,
        taxonomyText, job.summary, job.description_excerpt, ...(job.match_terms ?? []),
      ].join(" ")),
      _resumeScore: null,
    };
  });
}

function searchDocuments() {
  return state.jobs.map((job) => ({
    id: job.id,
    posted_on: job.posted_on,
    fields: {
      title: job.title,
      match_terms: job.match_terms,
      taxonomy: job._taxonomyLabels,
      company: job.company,
      location: [job.location, ...(job.location_profile?.search_terms ?? [])],
      experience: job.experience_display,
      authorization: [job.work_authorization_display, job.authorization_category_label, job.sponsorship_status],
      summary: job.summary,
      excerpt: job.description_excerpt,
    },
    suggestions: [
      { category: "Role", label: job.title },
      { category: "Company", label: job.company },
      { category: "Location", label: job.location },
      ...(job.match_terms ?? []).map((label) => ({ category: "Skill", label })),
      ...job._taxonomyLabels.map((label) => ({ category: "Focus", label })),
    ],
  }));
}

function failAdvancedSearch() {
  state.searchFailed = true;
  state.searchReady = false;
  state.searchPending = false;
  state.searchScores = null;
  state.searchLexicalCount = null;
  state.searchSuggestions = [];
  state.searchCorrectedQuery = "";
  state.searchHighlightTerms = tokenize(state.filters.query);
  state.suggestionsOpen = false;
  if (searchWorker) searchWorker.terminate();
  searchWorker = null;
  render();
}

function requestAdvancedSearch() {
  const query = state.filters.query.trim();
  state.latestSearchRequestId += 1;
  if (!query) {
    state.searchPending = false;
    state.searchScores = null;
    state.searchLexicalCount = null;
    state.searchSuggestions = [];
    state.searchCorrectedQuery = "";
    state.searchHighlightTerms = [];
    state.suggestionIndex = -1;
    state.suggestionsOpen = false;
    return;
  }
  if (!state.searchReady || !searchWorker) {
    state.searchHighlightTerms = tokenize(query);
    return;
  }
  state.searchPending = true;
  state.searchScores = null;
  state.searchLexicalCount = null;
  state.searchSuggestions = [];
  state.searchCorrectedQuery = "";
  state.suggestionIndex = -1;
  searchWorker.postMessage({ type: "query", requestId: state.latestSearchRequestId, query });
}

function startSearchWorker() {
  if (!("Worker" in window)) {
    failAdvancedSearch();
    return;
  }
  try {
    searchWorker = new Worker("./search-worker.js", { type: "module" });
    searchWorker.addEventListener("message", (event) => {
      const message = event.data ?? {};
      if (message.type === "ready") {
        state.searchReady = true;
        state.searchFailed = false;
        requestAdvancedSearch();
        render();
        return;
      }
      if (message.type === "error") {
        failAdvancedSearch();
        return;
      }
      if (!isCurrentSearchResponse(state.latestSearchRequestId, message)) return;
      state.searchPending = false;
      state.searchScores = new Map(message.matches.map(({ documentIndex, score }) => [state.jobs[documentIndex]?.id, score]).filter(([id]) => id));
      state.searchLexicalCount = message.matches.length;
      state.searchSuggestions = message.suggestions ?? [];
      state.searchCorrectedQuery = message.correctedQuery ?? "";
      state.searchHighlightTerms = message.highlightTerms ?? [];
      state.suggestionIndex = -1;
      state.suggestionsOpen = document.activeElement === els.search_input && state.searchSuggestions.length > 0;
      render();
    });
    searchWorker.addEventListener("error", failAdvancedSearch);
    searchWorker.postMessage({ type: "init", documents: searchDocuments() });
  } catch {
    failAdvancedSearch();
  }
}

function parseListParam(value) {
  return value ? [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))] : [];
}

function readUrlState(filters) {
  const params = new URLSearchParams(window.location.search);
  const next = sanitizeFilters(filters);
  Object.entries(FILTER_PARAM_MAP).forEach(([key, param]) => {
    if (!params.has(param)) return;
    next[key] = ARRAY_FILTERS.has(key) ? parseListParam(params.get(param)) : (params.get(param) || DEFAULT_FILTERS[key]);
  });
  if (params.has("q") && !params.has("sort") && next.query) next.sort = "relevance";
  state.view = ["shortlist", "market"].includes(params.get("view")) ? params.get("view") : "all";
  return sanitizeFilters(next);
}

function writeUrlState() {
  const { history = "replace", jobId = "" } = arguments[0] || {};
  const historyMethod = history === "push" ? "pushState" : "replaceState";
  const params = new URLSearchParams();
  Object.entries(FILTER_PARAM_MAP).forEach(([key, param]) => {
    const value = state.filters[key];
    const defaultValue = DEFAULT_FILTERS[key];
    if (Array.isArray(value) ? value.length : value && value !== defaultValue) {
      params.set(param, Array.isArray(value) ? value.join(",") : value);
    }
  });
  if (state.view !== "all") params.set("view", state.view);
  if (jobId) params.set("job", jobId);
  const query = params.toString();
  const hash = window.location.hash;
  window.history[historyMethod]({}, "", `${window.location.pathname}${query ? `?${query}` : ""}${hash}`);
}

function isCompactViewport() {
  return window.matchMedia("(max-width: 840px), (max-height: 600px) and (max-width: 1000px)").matches;
}

function persist() {
  const result = saveStorage({ filters: state.filters, shortlist: state.shortlist });
  state.filters = result.value.filters;
  state.shortlist = result.value.shortlist;
  if (result.warning) state.storageWarning = result.warning;
  renderStorageWarning();
}

function renderStorageWarning() {
  els.storage_warning.textContent = state.storageWarning;
  els.storage_warning.classList.toggle("hidden", !state.storageWarning);
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.classList.remove("hidden");
  toastTimer = window.setTimeout(() => els.toast.classList.add("hidden"), 2600);
}

function option(value, label, count) {
  return `<option value="${escapeHtml(value)}">${escapeHtml(label)}${Number.isFinite(count) ? ` (${formatCount(count)})` : ""}</option>`;
}

function uniqueFacetItems(items) {
  return [...new Map(items.map((item) => [item.value, item])).values()];
}

function facetStateSignature() {
  const { sort, ...filters } = state.filters;
  return JSON.stringify({
    filters,
    view: state.view,
    shortlist: state.view === "shortlist" ? Object.keys(state.shortlist).sort() : [],
    searchPending: state.searchPending,
    searchFailed: state.searchFailed,
    searchRequest: state.searchScores instanceof Map ? state.latestSearchRequestId : 0,
    jobCount: state.jobs.length,
  });
}

function setFacetOptions(element, defaultLabel, items, counts, selectedValue) {
  element.innerHTML = option("", defaultLabel)
    + sortFacetItems(uniqueFacetItems(items)).map((item) => option(item.value, item.label, counts.get(item.value) ?? 0)).join("");
  element.value = selectedValue || "";
}

function updateFacetOptions({ force = false } = {}) {
  const signature = facetStateSignature();
  if (!force && signature === renderedFacetState) return;
  const taxonomy = state.payload.taxonomy ?? {};
  const selectedDomain = state.filters.domains[0] || "";
  const domains = taxonomy.domains ?? [];
  const specializationItems = selectedDomain
    ? domains.find((item) => item.value === selectedDomain)?.specializations ?? []
    : domains.flatMap((item) => item.specializations ?? []);
  const shared = {
    shortlist: state.view === "shortlist" ? state.shortlist : null,
    searchScores: state.searchScores,
  };
  const definitions = [
    {
      element: els.domain_filter, defaultLabel: "All focus areas", key: "domains", items: domains,
      values: (job) => job._domains, ignoreFilters: ["domains", "specializations"],
    },
    {
      element: els.specialization_filter, defaultLabel: "All specializations", key: "specializations", items: specializationItems,
      values: (job) => job._specializations, ignoreFilters: ["specializations"],
    },
    {
      element: els.industry_filter, defaultLabel: "All industries", key: "industries", items: taxonomy.industries ?? [],
      values: (job) => job._industries, ignoreFilters: ["industries"],
    },
    {
      element: els.career_filter, defaultLabel: "All experience", key: "careerBuckets", items: state.payload.career_buckets ?? [],
      values: (job) => job.career_bucket, ignoreFilters: ["careerBuckets"],
    },
    {
      element: els.authorization_filter, defaultLabel: "Any authorization", key: "authorizationCategories", items: state.payload.authorization_categories ?? [],
      values: (job) => job.authorization_category, ignoreFilters: ["authorizationCategories"],
    },
    {
      element: els.sponsorship_filter, defaultLabel: "Any sponsorship", key: "sponsorshipStatuses", items: state.payload.sponsorship_statuses ?? [],
      values: (job) => job.sponsorship_status, ignoreFilters: ["sponsorshipStatuses"],
    },
  ];
  definitions.forEach((definition) => {
    const counts = countFacetValues(state.jobs, state.filters, definition.values, {
      ...shared,
      ignoreFilters: definition.ignoreFilters,
    });
    setFacetOptions(
      definition.element,
      definition.defaultLabel,
      definition.items,
      counts,
      state.filters[definition.key][0],
    );
  });
  renderedFacetState = signature;
}

function populateFilters() {
  const locations = state.payload.locations ?? [...new Set(state.jobs.map((job) => job.location))].map((value) => ({ value }));
  els.location_suggestions.innerHTML = locations.slice(0, 100).map((item) => `<option value="${escapeHtml(item.value)}"></option>`).join("");
  updateFacetOptions({ force: true });
  syncControlsFromState();
}

function setSingleArrayFilter(key, value) {
  state.filters[key] = value ? [value] : [];
  state.visibleLimit = PAGE_BATCH;
  state.selectedId = "";
  state.selectionPinned = false;
  persist();
  writeUrlState();
  render();
}

function syncControlsFromState() {
  els.search_input.value = state.filters.query;
  els.domain_filter.value = state.filters.domains[0] || "";
  els.specialization_filter.value = state.filters.specializations[0] || "";
  els.industry_filter.value = state.filters.industries[0] || "";
  els.location_filter.value = state.filters.location;
  els.career_filter.value = state.filters.careerBuckets[0] || "";
  els.experience_years_filter.value = state.filters.experienceYears;
  els.authorization_filter.value = state.filters.authorizationCategories[0] || "";
  els.sponsorship_filter.value = state.filters.sponsorshipStatuses[0] || "";
  els.posted_filter.value = state.filters.postedRange;
  els.sort_filter.value = state.filters.sort;
}

function filterLabel(key, value) {
  if (key === "query") return `Search: ${value}`;
  if (key === "location") return `Location: ${value}`;
  if (key === "experienceYears") return `Fits ${value} ${value === "1" ? "yr" : "yrs"}`;
  if (key === "postedRange") return { "1d": "Posted: 24 hours", "3d": "Posted: 3 days", "7d": "" }[value] || value;
  if (key === "sort") return "";
  const lookup = {
    domains: els.domain_filter,
    specializations: els.specialization_filter,
    industries: els.industry_filter,
    careerBuckets: els.career_filter,
    authorizationCategories: els.authorization_filter,
    sponsorshipStatuses: els.sponsorship_filter,
  }[key];
  const label = [...(lookup?.options ?? [])].find((entry) => entry.value === value)?.textContent?.replace(/ \([\d,]+\)$/, "") || value;
  return label;
}

function renderActiveFilters() {
  const chips = [];
  Object.entries(state.filters).forEach(([key, value]) => {
    if (key === "sort") return;
    const values = Array.isArray(value) ? value : [value];
    values.filter(Boolean).forEach((entry) => {
      if (entry === DEFAULT_FILTERS[key]) return;
      const label = filterLabel(key, entry);
      if (!label) return;
      chips.push(`<span class="filter-chip">${escapeHtml(label)}<button type="button" data-clear-key="${escapeHtml(key)}" data-clear-value="${escapeHtml(entry)}" aria-label="Remove ${escapeHtml(label)}">×</button></span>`);
    });
  });
  const activeLabel = chips.length === 1 ? "1 active filter" : `${chips.length} active filters`;
  els.active_filters.innerHTML = chips.length
    ? `<span class="active-filters-label">${activeLabel}</span>${chips.join("")}`
    : "";
  els.active_filters.classList.toggle("hidden", !chips.length);
  els.mobile_filter_count.textContent = String(chips.length);
  els.mobile_filter_count.classList.toggle("hidden", !chips.length);
}

function renderSearchChrome() {
  let status = "";
  if (!state.searchReady && !state.searchFailed) status = "Indexing";
  else if (state.searchPending) status = "Searching";
  else if (state.searchFailed && state.filters.query) status = "Basic search";
  els.search_state.textContent = status;
  els.search_state.title = state.searchFailed
    ? "Advanced search is unavailable; transparent keyword matching is active."
    : status ? `${status}…` : "";
  els.search_state.classList.toggle("hidden", !status);
  els.search_clear.classList.toggle("hidden", !state.filters.query);
  els.search_clear.setAttribute("aria-hidden", String(!state.filters.query));

  if (state.searchCorrectedQuery && state.filters.query) {
    els.search_assist.innerHTML = `Did you mean <button type="button" data-corrected-query="${escapeHtml(state.searchCorrectedQuery)}">${escapeHtml(state.searchCorrectedQuery)}</button>?`;
    els.search_assist.classList.remove("hidden");
  } else {
    els.search_assist.innerHTML = "";
    els.search_assist.classList.add("hidden");
  }

  const open = state.suggestionsOpen && state.searchSuggestions.length > 0;
  els.search_suggestions.innerHTML = state.searchSuggestions.map((suggestion, index) => `
    <button class="search-suggestion${index === state.suggestionIndex ? " is-active" : ""}" id="search-suggestion-${index}"
      type="button" role="option" aria-selected="${index === state.suggestionIndex}" data-suggestion-index="${index}">
      <span>${highlightText(suggestion.label, tokenize(state.filters.query))}</span><small>${escapeHtml(suggestion.category)}</small>
    </button>`).join("");
  els.search_suggestions.classList.toggle("hidden", !open);
  els.search_input.setAttribute("aria-expanded", String(open));
  if (open && state.suggestionIndex >= 0) {
    els.search_input.setAttribute("aria-activedescendant", `search-suggestion-${state.suggestionIndex}`);
  } else {
    els.search_input.removeAttribute("aria-activedescendant");
  }
}

function setSearchQuery(value, { keepFocus = false } = {}) {
  const previous = state.filters.query.trim();
  const raw = String(value ?? "");
  const next = raw.trim() ? raw : "";
  state.filters.query = next;
  if (!previous && next) state.filters.sort = "relevance";
  if (previous && !next && state.filters.sort === "relevance") state.filters.sort = "date_desc";
  state.visibleLimit = PAGE_BATCH;
  state.selectedId = "";
  state.selectionPinned = false;
  els.search_input.value = next;
  els.sort_filter.value = state.filters.sort;
  persist();
  writeUrlState();
  requestAdvancedSearch();
  render();
  if (keepFocus) els.search_input.focus();
}

function clearSearchQuery() {
  window.clearTimeout(searchTimer);
  setSearchQuery("", { keepFocus: true });
}

function clearStructuredFilters() {
  const query = state.filters.query;
  const sort = state.filters.sort;
  state.filters = freshFilters();
  state.filters.query = query;
  state.filters.sort = sort;
  state.view = "all";
  state.visibleLimit = PAGE_BATCH;
  state.selectedId = "";
  state.selectionPinned = false;
  syncControlsFromState();
  persist();
  writeUrlState();
  render();
}

function authSignalClass(job) {
  if (job.sponsorship_status === "supports_sponsorship") return "signal-positive";
  if (["requires_us_citizenship", "requires_us_person_status", "requires_security_clearance_or_public_trust", "no_sponsorship"].includes(job.authorization_category)
    || job.sponsorship_status === "no_sponsorship") return "signal-restricted";
  if (job.authorization_category !== "open_or_not_specified") return "signal-warning";
  return "";
}

function sponsorshipLabel(job) {
  if (job.sponsorship_status === "supports_sponsorship") return "Visa: sponsorship supported";
  if (job.sponsorship_status === "no_sponsorship") return "Visa: no sponsorship";
  return `Work auth: ${job.authorization_category_label || "not stated"}`;
}

function sponsorshipDecision(job) {
  if (job.sponsorship_status === "supports_sponsorship") return "Likely sponsorship supported";
  if (job.sponsorship_status === "no_sponsorship") return "Likely no sponsorship";
  return "Sponsorship not stated";
}

function authorizationDecision(job) {
  if (job.authorization_category === "open_or_not_specified") return "Likely open / not specified";
  return job.authorization_category_label || "Authorization not stated";
}

function primarySpecialization(job) {
  const map = taxonomyMaps(state.payload).specializations;
  const values = job._specializations;
  if (!values.length) return "Uncategorized";
  const label = map.get(values[0]) || values[0].replaceAll("_", " ");
  return values.length > 1 ? `${label} +${values.length - 1}` : label;
}

function searchMatchReasons(job) {
  if (!state.filters.query) return [];
  const terms = state.searchHighlightTerms.length ? state.searchHighlightTerms : tokenize(state.filters.query);
  const fields = [
    ["role title", job.title],
    ["company", job.company],
    ["skills", (job.match_terms ?? []).join(" ")],
    ["focus", job._taxonomyLabels.join(" ")],
    ["location", job.location],
    ["summary", [job.summary, job.description_excerpt].filter(Boolean).join(" ")],
  ];
  return fields.filter(([, value]) => {
    const normalized = normalizeText(value);
    return terms.some((term) => normalized.includes(normalizeText(term)));
  }).map(([label]) => label).slice(0, 3);
}

function currentResults() {
  return filterAndSortJobs(state.jobs, state.filters, {
    shortlist: state.view === "shortlist" ? state.shortlist : null,
    resumeActive: state.resumeActive,
    searchScores: state.searchScores,
  });
}

function renderJobList(results) {
  const visible = results.slice(0, state.visibleLimit);
  els.job_list.innerHTML = visible.map((job) => {
    const saved = Boolean(state.shortlist[job.id]);
    const days = jobAgeDays(job.posted_on);
    const ageLabel = days === 0 ? "Today" : compactJobDate(job.posted_on);
    const location = job.location || "Location not stated";
    const experience = job.experience_display || "Experience not stated";
    const sponsorship = sponsorshipLabel(job);
    const specialization = primarySpecialization(job);
    const matchReasons = searchMatchReasons(job);
    return `
      <div class="job-row${state.selectedId === job.id ? " is-selected" : ""}" role="option" tabindex="-1" aria-selected="${state.selectedId === job.id}" data-job-id="${escapeHtml(job.id)}">
        <div class="job-age-cell"><span class="job-age${days === 0 ? " is-new" : ""}">${days === 0 ? escapeHtml(ageLabel) : ageLabel}</span></div>
        <div class="job-main">
          <h2 class="job-title">${highlightText(job.title)}</h2>
          <p class="job-company">${companyAvatar(job.company, "row")}<span class="job-company-text">${highlightText(job.company)}<span class="job-loc-sep">·</span><span class="job-loc">${highlightText(location)}</span></span></p>
          <div class="job-meta">
            <span>Level: ${highlightText(experience)}</span>
            <span class="${authSignalClass(job)}">${highlightText(sponsorship)}</span>
            <span>Focus: ${highlightText(specialization)}</span>
          </div>
          ${matchReasons.length ? `<p class="match-context">Matched in ${matchReasons.map((reason) => `<span>${escapeHtml(reason)}</span>`).join(" · ")}</p>` : ""}
        </div>
        <button class="shortlist-button${saved ? " is-saved" : ""}" type="button" data-shortlist-id="${escapeHtml(job.id)}" aria-label="${saved ? "Remove from" : "Add to"} shortlist" aria-pressed="${saved}">${bookmarkIcon()}</button>
      </div>`;
  }).join("");
  els.load_more.classList.toggle("hidden", visible.length >= results.length || !results.length);
}

function renderEmpty(results) {
  const empty = results.length === 0;
  els.empty_state.classList.toggle("hidden", !empty);
  els.job_list.classList.toggle("hidden", empty);
  els.empty_suggestions.innerHTML = "";
  if (!empty) return;
  if (state.searchPending && state.filters.query) {
    state.emptyActionMode = "clear-search";
    els.empty_title.textContent = "Searching the board";
    els.empty_copy.textContent = "Checking role titles, skills, companies, and locations…";
    els.empty_action.classList.add("hidden");
  } else if (state.view === "shortlist" && !Object.keys(state.shortlist).length) {
    els.empty_action.classList.remove("hidden");
    state.emptyActionMode = "browse-all";
    els.empty_title.textContent = "Your shortlist is empty";
    els.empty_copy.textContent = "Bookmark promising roles from All roles to compare them here.";
    els.empty_action.textContent = "Browse all jobs";
  } else if (state.filters.query && state.searchLexicalCount === 0 && !state.searchPending) {
    els.empty_action.classList.remove("hidden");
    state.emptyActionMode = "clear-search";
    els.empty_title.textContent = "No search matches yet";
    els.empty_copy.textContent = state.searchCorrectedQuery
      ? "Try the suggested spelling above or remove one search term."
      : "Try a broader role, skill, company, or location term.";
    els.empty_action.textContent = "Clear search";
    els.empty_suggestions.innerHTML = ["software engineer", "data analyst", "machine learning"]
      .map((query) => `<button type="button" class="empty-suggestion" data-empty-query="${escapeHtml(query)}">Try ${escapeHtml(query)}</button>`).join("");
  } else if (state.filters.query && state.searchLexicalCount > 0) {
    els.empty_action.classList.remove("hidden");
    state.emptyActionMode = "clear-structured";
    els.empty_title.textContent = "Matches are hidden by filters";
    els.empty_copy.textContent = `${formatCount(state.searchLexicalCount)} search ${state.searchLexicalCount === 1 ? "match is" : "matches are"} outside the current filters or view.`;
    els.empty_action.textContent = "Clear filters";
    els.empty_suggestions.innerHTML = relaxationButtons();
  } else {
    els.empty_action.classList.remove("hidden");
    state.emptyActionMode = "clear-filters";
    els.empty_title.textContent = "Nothing on the board matches";
    els.empty_copy.textContent = "Clear one or more filters to widen the search.";
    els.empty_action.textContent = "Clear filters";
    els.empty_suggestions.innerHTML = relaxationButtons();
  }
}

function relaxationButtons() {
  const active = [];
  if (state.filters.sponsorshipStatuses.length) active.push(["sponsorshipStatuses", "Remove sponsorship filter"]);
  if (state.filters.authorizationCategories.length) active.push(["authorizationCategories", "Remove authorization filter"]);
  if (state.filters.careerBuckets.length || state.filters.experienceYears) active.push(["careerBuckets", "Broaden experience"]);
  if (state.filters.location) active.push(["location", "Broaden location"]);
  if (!active.length) return "";
  return active.map(([key, label]) => `<button type="button" class="empty-suggestion" data-relax-key="${escapeHtml(key)}">${escapeHtml(label)}</button>`).join("");
}

function selectedJob() {
  return state.jobs.find((job) => job.id === state.selectedId) || null;
}

function taxonomyDetail(job) {
  const maps = taxonomyMaps(state.payload);
  const tags = [];
  job._domains.forEach((value) => tags.push(maps.domains.get(value) || value));
  job._specializations.forEach((value) => tags.push(maps.specializations.get(value) || value));
  job._industries.forEach((value) => tags.push(maps.industries.get(value) || value));
  return [...new Set(tags)];
}

function renderMatchEvidence(job) {
  if (!state.resumeActive) return "";
  const explanation = explainResumeMatch(job, state.resumeTokens);
  const row = (label, terms) => terms.length ? `
    <div class="match-evidence-row"><span class="match-evidence-label">${label}</span>${terms.map((term) => `<span class="match-term">${escapeHtml(term)}</span>`).join("")}</div>` : "";
  return `
    <section class="detail-section">
      <h3>Why this surfaced</h3>
      <div class="match-evidence">
        ${row("Title overlap", explanation.titleMatches)}
        ${row("Posting signals", explanation.signalMatches)}
        ${explanation.semanticOnly ? '<div class="semantic-note">Semantic similarity only—verify the posting requirements before applying.</div>' : ""}
      </div>
      <p class="disclosure">Guidance only. Matching runs locally and is not an eligibility decision.</p>
    </section>`;
}

function summarySection(job) {
  if (job.summary) {
    return `
    <section class="detail-section">
      <h3>Role summary</h3>
      <p class="summary-text">${escapeHtml(job.summary)}</p>
      <p class="disclosure">AI-generated summary. The complete posting is on the employer site.</p>
    </section>`;
  }
  return `
    <section class="detail-section">
      <h3>Role summary</h3>
      <p class="summary-text">${escapeHtml(job.description_excerpt || "Open the employer posting to review the role details.")}</p>
      <p class="disclosure">Excerpt from the posting. The complete posting is on the employer site.</p>
    </section>`;
}

function renderDetail() {
  const job = selectedJob();
  els.detail_empty.classList.toggle("hidden", Boolean(job));
  els.detail_content.classList.toggle("hidden", !job);
  if (!job) {
    els.detail_content.innerHTML = "";
    document.body.classList.remove("detail-open");
    return;
  }
  const saved = Boolean(state.shortlist[job.id]);
  const taxonomyTags = taxonomyDetail(job);
  const sponsorship = sponsorshipDecision(job);
  const authorization = authorizationDecision(job);
  els.detail_content.innerHTML = `
    <header class="detail-header">
      <div class="detail-header-top">
        <div class="company-line">${companyAvatar(job.company)}${escapeHtml(job.company)}</div>
        <button class="icon-button mobile-detail-close" type="button" data-close-detail aria-label="Close job details">${closeIcon()}</button>
      </div>
      <h2>${escapeHtml(job.title)}</h2>
      <p class="detail-subline">Posted ${escapeHtml(formatCalendarDate(job.posted_on))} <span class="detail-scroll-note">Scroll for full details</span></p>
      <div class="detail-actions">
        <button class="button button-secondary${saved ? " is-saved" : ""}" type="button" data-shortlist-id="${escapeHtml(job.id)}" aria-pressed="${saved}">${bookmarkIcon()} ${saved ? "Shortlisted" : "Shortlist"}</button>
        ${job.job_link ? `<a class="button button-primary" data-apply-link href="${escapeHtml(job.job_link)}" target="_blank" rel="noopener noreferrer" aria-label="Apply on company site; opens in a new tab">Apply on company site <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 5h5v5m0-5-9 9M19 13v6H5V5h6"/></svg></a>` : ""}
      </div>
    </header>
    <div class="decision-grid">
      <div class="decision-item"><span class="decision-label">Location</span><span class="decision-value">${escapeHtml(job.location || "Not stated")}</span></div>
      <div class="decision-item"><span class="decision-label">Experience</span><span class="decision-value">${escapeHtml(job.experience_display || "Not stated")}</span></div>
      <div class="decision-item"><span class="decision-label">Visa sponsorship <button class="info-badge" type="button" title="This is an inferred signal from the posting text, not a guarantee." aria-label="Visa sponsorship definition">i</button></span><span class="decision-value ${authSignalClass(job)}">${escapeHtml(sponsorship)}</span></div>
      <div class="decision-item"><span class="decision-label">Work authorization <button class="info-badge" type="button" title="Open or not specified means no restriction was detected. Not stated means the posting was silent." aria-label="Work authorization definition">i</button></span><span class="decision-value ${authSignalClass(job)}">${escapeHtml(authorization)}</span></div>
    </div>
    <p class="eligibility-note"><span class="info-badge" aria-hidden="true">i</span><span><strong>Eligibility signals are inferred.</strong> Confirm sponsorship, citizenship, and clearance requirements with the employer before applying.</span></p>
    ${summarySection(job)}
    ${renderMatchEvidence(job)}
    <section class="detail-section">
      <h3>Role classification</h3>
      <div class="taxonomy-row">${taxonomyTags.map((tag) => `<span class="taxonomy-tag">${escapeHtml(tag)}</span>`).join("") || '<span class="taxonomy-tag">Uncategorized</span>'}</div>
      <p class="disclosure">Classification and authorization signals are model-derived. Verify all requirements on the employer site.</p>
    </section>`;
}

function selectJob(id, { openMobile = true, navigate = true } = {}) {
  if (!state.jobs.some((job) => job.id === id)) return;
  state.selectedId = id;
  state.selectionPinned = true;
  if (openMobile && isCompactViewport()) document.body.classList.add("detail-open");
  if (navigate) writeUrlState({ history: "push", jobId: id });
  render();
}

function closeDetail({ updateHistory = true } = {}) {
  document.body.classList.remove("detail-open");
  if (updateHistory && new URLSearchParams(window.location.search).has("job")) writeUrlState();
}

function render() {
  document.querySelectorAll("[data-view]").forEach((button) => {
    const active = button.dataset.view === state.view;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  const marketView = state.view === "market";
  els.board_content.classList.toggle("hidden", marketView);
  els.search_shell.classList.toggle("hidden", marketView);
  els.jobs_workspace.classList.toggle("hidden", marketView);
  els.storage_warning.classList.toggle("hidden", marketView || !state.storageWarning);
  if (marketView) {
    marketAnalysis.show();
    els.all_count.textContent = `(${formatCount(state.jobs.length)})`;
    els.shortlist_count.textContent = formatCount(Object.keys(state.shortlist).length);
    document.body.classList.remove("detail-open");
    return;
  }
  marketAnalysis.hide();
  if (!state.payload) return;
  const results = currentResults();
  if (state.selectedId && !results.some((job) => job.id === state.selectedId)) {
    state.selectedId = "";
    state.selectionPinned = false;
  }
  if (!state.selectionPinned && results.length) state.selectedId = results[0].id;
  if (!results.length) {
    state.selectedId = "";
    state.selectionPinned = false;
  }
  els.results_heading.textContent = state.view === "shortlist" ? "Shortlist" : "All roles";
  const employerCount = new Set(results.map((job) => job.company).filter(Boolean)).size;
  const shortlistTotal = Object.keys(state.shortlist).length;
  const shortlistHasFilters = state.filters.query || state.filters.location || state.filters.domains.length
    || state.filters.specializations.length || state.filters.industries.length || state.filters.careerBuckets.length
    || state.filters.authorizationCategories.length || state.filters.sponsorshipStatuses.length || state.filters.experienceYears;
  els.results_summary.textContent = state.searchPending && state.filters.query
    ? `Searching ${formatCount(results.length)} current ${results.length === 1 ? "match" : "matches"}…`
    : state.view === "shortlist"
      ? `${formatCount(results.length)} of ${formatCount(shortlistTotal)} saved ${shortlistTotal === 1 ? "role" : "roles"}${shortlistHasFilters ? " · filters active" : ""}`
    : state.filters.query
      ? `${formatCount(results.length)} ${results.length === 1 ? "role" : "roles"} · ${formatCount(employerCount)} employers · matched terms highlighted`
      : `${formatCount(results.length)} ${results.length === 1 ? "role" : "roles"} in view`;
  els.shortlist_clear_filters.classList.toggle("hidden", state.view !== "shortlist" || !shortlistHasFilters || results.length === shortlistTotal);
  els.all_count.textContent = `(${formatCount(state.jobs.length)})`;
  els.shortlist_count.textContent = formatCount(Object.keys(state.shortlist).length);
  if (els.filter_apply) els.filter_apply.textContent = `Show ${formatCount(results.length)} ${results.length === 1 ? "role" : "roles"}`;
  els.match_mode.textContent = state.resumeActive ? `Sorted by ${state.resumeMode}` : "";
  els.match_mode.classList.toggle("hidden", !state.resumeActive);
  const sortLabel = els.sort_filter.selectedOptions[0]?.textContent || "";
  els.sort_note.textContent = state.resumeActive ? "" : `Sort: ${sortLabel}`;
  els.sort_note.classList.toggle("hidden", state.resumeActive || state.filters.sort === DEFAULT_FILTERS.sort || !sortLabel);
  els.sort_filter.disabled = state.resumeActive;
  els.sort_filter.title = state.resumeActive ? "Resume relevance controls sorting while matching is active." : "";
  els.job_list.setAttribute("aria-busy", String(state.searchPending));
  els.resume_clear.classList.toggle("hidden", !state.resumeActive);
  updateFacetOptions();
  renderSearchChrome();
  renderActiveFilters();
  renderJobList(results);
  renderEmpty(results);
  renderDetail();
  const freshToday = results.filter((job) => jobAgeDays(job.posted_on) === 0).length;
  els.results_trust_copy.textContent = state.payload.generated_at
    ? `${formatGeneratedAt(state.payload.generated_at)} · ${formatCount(freshToday)} fresh today · US roles`
    : "Updated daily · US technology roles";
  renderStorageWarning();
}

function clearFilters() {
  state.filters = freshFilters();
  state.visibleLimit = PAGE_BATCH;
  state.selectedId = "";
  state.selectionPinned = false;
  syncControlsFromState();
  persist();
  writeUrlState();
  requestAdvancedSearch();
  render();
}

function clearShortlistFilters() {
  state.filters = freshFilters();
  state.view = "shortlist";
  state.visibleLimit = PAGE_BATCH;
  state.selectedId = "";
  state.selectionPinned = false;
  syncControlsFromState();
  persist();
  writeUrlState();
  requestAdvancedSearch();
  render();
}

function toggleSaved(id) {
  const wasSaved = Boolean(state.shortlist[id]);
  state.shortlist = toggleShortlist(state.shortlist, id);
  persist();
  render();
  showToast(wasSaved ? "Removed from shortlist" : "Added to shortlist");
}

function openFilters() {
  els.filter_panel.classList.add("is-open");
  els.sheet_backdrop.classList.remove("hidden");
  els.mobile_filter_open.setAttribute("aria-expanded", "true");
}

function closeFilters() {
  els.filter_panel.classList.remove("is-open");
  els.sheet_backdrop.classList.add("hidden");
  els.mobile_filter_open.setAttribute("aria-expanded", "false");
}

function setResumeStatus(message, error = false) {
  els.resume_status.textContent = message;
  els.resume_status.classList.toggle("is-error", error);
  if (!state.resumeBusy) {
    els.resume_progress.textContent = "";
    els.resume_progress.classList.add("hidden");
    return;
  }
  const lower = String(message).toLowerCase();
  const stage = lower.includes("loading") || lower.includes("preparing")
    ? "Step 1 of 3 · Preparing the local matcher"
    : lower.includes("starting")
      ? "Step 2 of 3 · Starting the browser runtime"
      : lower.includes("ranking") || lower.includes("semantic") || lower.includes("keyword")
        ? "Step 3 of 3 · Ranking your roles"
        : "Step 1 of 3 · Preparing the local matcher";
  els.resume_progress.textContent = stage;
  els.resume_progress.classList.remove("hidden");
}

async function applyResume() {
  const raw = els.resume_input.value;
  if (raw.replace(/\s/g, "").length < 200 || tokenize(raw).length < 20) {
    setResumeStatus("Paste at least 200 non-whitespace characters and 20 meaningful words.", true);
    return;
  }
  const runId = ++state.resumeRunId;
  state.resumeBusy = true;
  state.resumeCancelRequested = false;
  els.resume_apply.disabled = true;
  els.resume_cancel.classList.remove("hidden");
  els.resume_cancel.disabled = false;
  setResumeStatus("Preparing local matching… Usually 10–30 seconds on the first run.");
  try {
    const result = await resumeMatcher.score(raw, state.jobs);
    if (state.resumeCancelRequested || state.resumeRunId !== runId) return;
    state.resumeActive = true;
    state.resumeTokens = result.resumeTokens;
    state.resumeMode = result.mode;
    state.visibleLimit = PAGE_BATCH;
    setResumeStatus(`Matching is active (${result.mode}). Nothing was uploaded or saved.`);
    els.resume_dialog.close();
    render();
  } catch (error) {
    if (!state.resumeCancelRequested) setResumeStatus(`Matching could not start: ${error.message || "try again"}.`, true);
  } finally {
    if (state.resumeRunId === runId) {
      state.resumeBusy = false;
      els.resume_apply.disabled = false;
      els.resume_cancel.classList.add("hidden");
      setResumeStatus(els.resume_status.textContent, els.resume_status.classList.contains("is-error"));
    }
  }
}

function cancelResume() {
  state.resumeCancelRequested = true;
  state.resumeBusy = false;
  els.resume_apply.disabled = false;
  els.resume_cancel.disabled = true;
  els.resume_cancel.classList.add("hidden");
  setResumeStatus("Matching canceled. Your resume remains in this tab.");
}

function clearResume() {
  state.resumeActive = false;
  state.resumeTokens = [];
  state.resumeMode = "";
  state.resumeBusy = false;
  state.resumeCancelRequested = false;
  state.jobs.forEach((job) => { job._resumeScore = null; });
  els.resume_input.value = "";
  setResumeStatus("Matching combines local semantic relevance with visible keyword evidence.");
  els.resume_dialog.close();
  render();
}

function bindEvents() {
  const advancedFilterCount = document.querySelectorAll(".advanced-filter").length;
  els.advanced_filter_count.textContent = `(${advancedFilterCount} available)`;
  const headerTools = document.querySelector(".header-tools");
  const toolsSummary = headerTools?.querySelector("summary");
  const positionToolsMenu = () => {
    if (!toolsSummary) return;
    const rect = toolsSummary.getBoundingClientRect();
    headerTools.style.setProperty("--tools-menu-top", `${Math.round(rect.bottom + 8)}px`);
  };
  headerTools?.addEventListener("toggle", positionToolsMenu);
  window.addEventListener("resize", positionToolsMenu);
  window.addEventListener("scroll", positionToolsMenu, true);
  positionToolsMenu();

  document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => {
    state.view = button.dataset.view;
    state.visibleLimit = PAGE_BATCH;
    state.selectedId = "";
    state.selectionPinned = false;
    writeUrlState();
    render();
  }));
  document.querySelectorAll("[data-starter-query]").forEach((button) => button.addEventListener("click", () => {
    setSearchQuery(button.dataset.starterQuery, { keepFocus: true });
  }));
  els.search_input.addEventListener("input", () => {
    window.clearTimeout(searchTimer);
    state.suggestionsOpen = false;
    renderSearchChrome();
    if (!els.search_input.value.trim()) {
      clearSearchQuery();
      return;
    }
    searchTimer = window.setTimeout(() => {
      setSearchQuery(els.search_input.value);
    }, 120);
  });
  els.search_input.addEventListener("search", () => {
    if (!els.search_input.value.trim()) clearSearchQuery();
  });
  els.search_clear.addEventListener("click", clearSearchQuery);
  els.search_input.addEventListener("focus", () => {
    state.suggestionsOpen = state.searchSuggestions.length > 0;
    renderSearchChrome();
  });
  els.search_input.addEventListener("keydown", (event) => {
    if (!["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(event.key)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      state.suggestionsOpen = false;
      state.suggestionIndex = -1;
      renderSearchChrome();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (state.suggestionsOpen && state.suggestionIndex >= 0 && state.searchSuggestions.length) {
        setSearchQuery(state.searchSuggestions[state.suggestionIndex].query, { keepFocus: true });
        return;
      }
      state.suggestionsOpen = false;
      state.suggestionIndex = -1;
      renderSearchChrome();
      return;
    }
    if (!state.searchSuggestions.length) return;
    event.preventDefault();
    state.suggestionsOpen = true;
    const direction = event.key === "ArrowDown" ? 1 : -1;
    const start = state.suggestionIndex < 0 ? (direction > 0 ? -1 : 0) : state.suggestionIndex;
    state.suggestionIndex = (start + direction + state.searchSuggestions.length) % state.searchSuggestions.length;
    renderSearchChrome();
  });
  els.search_suggestions.addEventListener("mousedown", (event) => event.preventDefault());
  els.search_suggestions.addEventListener("click", (event) => {
    const optionButton = event.target.closest("[data-suggestion-index]");
    if (!optionButton) return;
    const suggestion = state.searchSuggestions[Number(optionButton.dataset.suggestionIndex)];
    if (suggestion) setSearchQuery(suggestion.query, { keepFocus: true });
  });
  els.search_assist.addEventListener("click", (event) => {
    const correction = event.target.closest("[data-corrected-query]");
    if (correction) setSearchQuery(correction.dataset.correctedQuery, { keepFocus: true });
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "/" && !/input|textarea|select/i.test(document.activeElement?.tagName)) {
      event.preventDefault();
      els.search_input.focus();
    }
    if (event.key === "Escape" && event.target.closest?.("#search-input")) return;
    if (event.key === "Escape") {
      state.suggestionsOpen = false;
      state.suggestionIndex = -1;
      renderSearchChrome();
      closeFilters();
      closeDetail();
    }
  });
  document.addEventListener("click", (event) => {
    if (event.target.closest(".search-combobox")) return;
    state.suggestionsOpen = false;
    state.suggestionIndex = -1;
    renderSearchChrome();
  });
  els.domain_filter.addEventListener("change", () => {
    state.filters.domains = els.domain_filter.value ? [els.domain_filter.value] : [];
    state.filters.specializations = [];
    setSingleArrayFilter("domains", els.domain_filter.value);
  });
  els.specialization_filter.addEventListener("change", () => setSingleArrayFilter("specializations", els.specialization_filter.value));
  els.industry_filter.addEventListener("change", () => setSingleArrayFilter("industries", els.industry_filter.value));
  els.career_filter.addEventListener("change", () => setSingleArrayFilter("careerBuckets", els.career_filter.value));
  els.experience_years_filter.addEventListener("input", () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      const years = Number.parseInt(els.experience_years_filter.value, 10);
      state.filters.experienceYears = Number.isInteger(years) && years >= 0 && years <= 60 ? String(years) : "";
      state.visibleLimit = PAGE_BATCH;
      state.selectedId = "";
      state.selectionPinned = false;
      persist(); writeUrlState(); render();
    }, 160);
  });
  els.authorization_filter.addEventListener("change", () => setSingleArrayFilter("authorizationCategories", els.authorization_filter.value));
  els.sponsorship_filter.addEventListener("change", () => setSingleArrayFilter("sponsorshipStatuses", els.sponsorship_filter.value));
  els.location_filter.addEventListener("input", () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      state.filters.location = els.location_filter.value.trim();
      state.visibleLimit = PAGE_BATCH;
      state.selectedId = "";
      state.selectionPinned = false;
      persist(); writeUrlState(); render();
    }, 120);
  });
  els.posted_filter.addEventListener("change", () => {
    state.filters.postedRange = els.posted_filter.value;
    state.visibleLimit = PAGE_BATCH;
    state.selectedId = "";
    state.selectionPinned = false;
    persist(); writeUrlState(); render();
  });
  els.sort_filter.addEventListener("change", () => {
    state.filters.sort = els.sort_filter.value;
    state.selectedId = "";
    state.selectionPinned = false;
    persist(); writeUrlState(); render();
  });
  els.advanced_filters_toggle.addEventListener("click", () => {
    advancedFiltersOpen = !advancedFiltersOpen;
    els.filter_panel.classList.toggle("is-advanced-open", advancedFiltersOpen);
    els.advanced_filters_toggle.setAttribute("aria-expanded", String(advancedFiltersOpen));
    els.advanced_filters_toggle.firstChild.textContent = advancedFiltersOpen ? "Fewer filters " : "More filters ";
    els.advanced_filter_count.textContent = advancedFiltersOpen ? "" : `(${advancedFilterCount} available)`;
  });
  els.clear_filters.addEventListener("click", clearFilters);
  els.shortlist_clear_filters.addEventListener("click", clearShortlistFilters);
  els.active_filters.addEventListener("click", (event) => {
    const button = event.target.closest("[data-clear-key]");
    if (!button) return;
    const key = button.dataset.clearKey;
    if (key === "query") {
      setSearchQuery("");
      return;
    }
    if (Array.isArray(state.filters[key])) state.filters[key] = state.filters[key].filter((value) => value !== button.dataset.clearValue);
    else state.filters[key] = DEFAULT_FILTERS[key];
    syncControlsFromState();
    persist(); writeUrlState(); render();
  });
  els.job_list.addEventListener("click", (event) => {
    const save = event.target.closest("[data-shortlist-id]");
    if (save) { event.stopPropagation(); toggleSaved(save.dataset.shortlistId); return; }
    const row = event.target.closest("[data-job-id]");
    if (row) selectJob(row.dataset.jobId);
  });
  els.job_list.addEventListener("keydown", (event) => {
    if (!["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) return;
    const rows = [...els.job_list.querySelectorAll("[data-job-id]")];
    if (!rows.length) return;
    event.preventDefault();
    const current = rows.findIndex((row) => row.dataset.jobId === state.selectedId);
    if (event.key === "Enter" || event.key === " ") {
      const row = current >= 0 ? rows[current] : rows[0];
      selectJob(row.dataset.jobId);
      return;
    }
    const next = event.key === "ArrowDown" ? Math.min(rows.length - 1, current + 1) : Math.max(0, current < 0 ? 0 : current - 1);
    selectJob(rows[next].dataset.jobId, { openMobile: false });
    rows[next].scrollIntoView({ block: "nearest" });
  });
  els.detail_content.addEventListener("click", (event) => {
    const save = event.target.closest("[data-shortlist-id]");
    if (save) { toggleSaved(save.dataset.shortlistId); return; }
    const apply = event.target.closest("[data-apply-link]");
    if (apply) {
      showToast("Opening the employer site in a new tab…");
      apply.classList.add("is-opening");
      window.setTimeout(() => apply.classList.remove("is-opening"), 1800);
      return;
    }
    if (event.target.closest("[data-close-detail]")) closeDetail();
  });
  els.load_more.addEventListener("click", () => { state.visibleLimit += PAGE_BATCH; render(); });
  [els.detail_content, els.job_list].forEach((container) => {
    container.addEventListener("error", (event) => {
      if (event.target instanceof HTMLImageElement && event.target.classList.contains("company-logo")) {
        event.target.hidden = true;
      }
    }, true);
  });
  els.empty_action.addEventListener("click", () => {
    if (state.emptyActionMode === "browse-all") {
      state.view = "all"; writeUrlState(); render();
    } else if (state.emptyActionMode === "clear-search") {
      setSearchQuery("");
    } else if (state.emptyActionMode === "clear-structured") {
      clearStructuredFilters();
    } else clearFilters();
  });
  els.empty_suggestions.addEventListener("click", (event) => {
    const queryButton = event.target.closest("[data-empty-query]");
    if (queryButton) {
      setSearchQuery(queryButton.dataset.emptyQuery);
      return;
    }
    const relaxButton = event.target.closest("[data-relax-key]");
    if (!relaxButton) return;
    const key = relaxButton.dataset.relaxKey;
    if (key === "careerBuckets") {
      state.filters.careerBuckets = [];
      state.filters.experienceYears = "";
    } else if (Array.isArray(state.filters[key])) {
      state.filters[key] = [];
    } else {
      state.filters[key] = DEFAULT_FILTERS[key];
    }
    state.selectedId = "";
    state.selectionPinned = false;
    syncControlsFromState();
    persist(); writeUrlState(); requestAdvancedSearch(); render();
  });
  els.mobile_filter_open.addEventListener("click", openFilters);
  els.mobile_filter_close.addEventListener("click", closeFilters);
  els.filter_apply.addEventListener("click", closeFilters);
  els.sheet_backdrop.addEventListener("click", closeFilters);
  els.resume_open.addEventListener("click", () => els.resume_dialog.showModal());
  els.resume_apply.addEventListener("click", applyResume);
  els.resume_cancel.addEventListener("click", cancelResume);
  els.resume_clear.addEventListener("click", clearResume);
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY) return;
    const loaded = loadStorage();
    state.filters = loaded.value.filters;
    state.shortlist = pruneShortlist(loaded.value.shortlist, new Set(state.jobs.map((job) => job.id))).shortlist;
    state.storageWarning = loaded.warning;
    state.selectedId = "";
    state.selectionPinned = false;
    syncControlsFromState();
    requestAdvancedSearch();
    render();
  });
  window.addEventListener("popstate", () => {
    state.filters = readUrlState(state.filters);
    const requestedJobId = new URLSearchParams(window.location.search).get("job") || "";
    state.selectedId = requestedJobId && state.jobs.some((job) => job.id === requestedJobId) ? requestedJobId : "";
    state.selectionPinned = Boolean(state.selectedId);
    document.body.classList.toggle("detail-open", Boolean(state.selectedId && isCompactViewport()));
    syncControlsFromState();
    requestAdvancedSearch();
    render();
  });
}

async function init() {
  const requestedJobId = new URLSearchParams(window.location.search).get("job") || "";
  const loaded = loadStorage();
  state.filters = readUrlState(loaded.value.filters);
  state.shortlist = loaded.value.shortlist;
  state.storageWarning = loaded.warning;
  bindEvents();
  render();

  const [response, brandResponse] = await Promise.all([
    fetch("./data/public_jobs.json"),
    fetch("./data/company_brands.json").catch(() => null),
  ]);
  if (!response.ok) throw new Error(`Current jobs could not be loaded (${response.status}).`);
  state.payload = await response.json();
  if (brandResponse?.ok) {
    try {
      const brandPayload = await brandResponse.json();
      if (brandPayload?.schema_version === "public-company-brands-v1" && brandPayload.companies) {
        state.companyBrands = brandPayload.companies;
      }
    } catch (_error) { /* Branding is optional; initials remain available. */ }
  }
  state.jobs = prepareJobs(state.payload);

  const pruned = pruneShortlist(state.shortlist, new Set(state.jobs.map((job) => job.id)));
  state.shortlist = pruned.shortlist;
  if (pruned.removed) {
    const noun = pruned.removed === 1 ? "job" : "jobs";
    state.storageWarning = `${pruned.removed} expired shortlisted ${noun} were removed because they left the seven-day feed.`;
  }
  persist();
  if (pruned.removed) state.storageWarning = `${pruned.removed} expired shortlisted ${pruned.removed === 1 ? "job was" : "jobs were"} removed because they left the seven-day feed.`;

  els.freshness.textContent = formatGeneratedAt(state.payload.generated_at);
  renderFlapCount(state.jobs.length);
  if (state.payload.repo_url) els.repo_link.href = state.payload.repo_url;
  populateFilters();
  const validRequestedJobId = requestedJobId && state.jobs.some((job) => job.id === requestedJobId) ? requestedJobId : "";
  writeUrlState({ jobId: validRequestedJobId });
  render();
  window.setTimeout(startSearchWorker, 0);
  if (validRequestedJobId) {
    await selectJob(validRequestedJobId, { navigate: false });
  }
  window.setTimeout(() => {
    // A shared Market Trends link should open directly into the dashboard;
    // the board tour is only relevant to the job-search view.
    if (state.view !== "market") productTour.autoStart();
  }, 650);
}

await init().catch((error) => {
  els.results_summary.textContent = "The current job feed could not be loaded.";
  els.empty_state.classList.remove("hidden");
  els.job_list.classList.add("hidden");
  els.empty_title.textContent = "Job data is unavailable";
  els.empty_copy.textContent = error.message;
  els.empty_action.classList.add("hidden");
});

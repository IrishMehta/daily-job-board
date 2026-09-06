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
};

const els = Object.fromEntries([
  "freshness", "job-count", "filter-apply", "all-count", "shortlist-count", "repo-link", "resume-open", "search-input", "search-state",
  "search-suggestions", "search-assist", "mobile-filter-open",
  "mobile-filter-close", "mobile-filter-count", "filter-panel", "domain-filter", "specialization-filter",
  "industry-filter", "location-filter", "location-suggestions", "career-filter", "experience-years-filter", "authorization-filter",
  "sponsorship-filter", "posted-filter", "sort-filter", "clear-filters", "active-filters", "storage-warning",
  "results-heading", "results-summary", "match-mode", "job-list", "empty-state", "empty-title", "empty-copy",
  "empty-action", "load-more", "detail-pane", "detail-empty", "detail-content", "sheet-backdrop", "resume-dialog",
  "resume-input", "resume-status", "resume-clear", "resume-apply", "toast",
].map((id) => [id.replaceAll("-", "_"), document.getElementById(id)]));

const resumeMatcher = new ResumeMatcher((message) => setResumeStatus(message));
let searchWorker = null;
let searchTimer = null;
let toastTimer = null;
let renderedFacetState = "";

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

function formatGeneratedAt(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Current US openings";
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay ? "Updated today · 7-day window" : `Updated ${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })} · 7-day window`;
}

function renderFlapCount(total) {
  if (!els.job_count) return;
  const text = formatCount(total);
  els.job_count.setAttribute("aria-label", `${text} roles on the board`);
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
  state.view = params.get("view") === "shortlist" ? "shortlist" : "all";
  return sanitizeFilters(next);
}

function writeUrlState() {
  const params = new URLSearchParams();
  Object.entries(FILTER_PARAM_MAP).forEach(([key, param]) => {
    const value = state.filters[key];
    const defaultValue = DEFAULT_FILTERS[key];
    if (Array.isArray(value) ? value.length : value && value !== defaultValue) {
      params.set(param, Array.isArray(value) ? value.join(",") : value);
    }
  });
  if (state.view === "shortlist") params.set("view", "shortlist");
  const query = params.toString();
  window.history.replaceState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
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
  if (key === "sort") return value === "date_desc" ? "" : `Sort: ${els.sort_filter.selectedOptions[0]?.textContent || value}`;
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
    const values = Array.isArray(value) ? value : [value];
    values.filter(Boolean).forEach((entry) => {
      if (entry === DEFAULT_FILTERS[key]) return;
      const label = filterLabel(key, entry);
      if (!label) return;
      chips.push(`<span class="filter-chip">${escapeHtml(label)}<button type="button" data-clear-key="${escapeHtml(key)}" data-clear-value="${escapeHtml(entry)}" aria-label="Remove ${escapeHtml(label)}">×</button></span>`);
    });
  });
  els.active_filters.innerHTML = chips.join("");
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
  const next = String(value ?? "").trim();
  state.filters.query = next;
  if (!previous && next) state.filters.sort = "relevance";
  if (previous && !next && state.filters.sort === "relevance") state.filters.sort = "date_desc";
  state.visibleLimit = PAGE_BATCH;
  state.selectedId = "";
  els.search_input.value = next;
  els.sort_filter.value = state.filters.sort;
  persist();
  writeUrlState();
  requestAdvancedSearch();
  render();
  if (keepFocus) els.search_input.focus();
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
  if (job.sponsorship_status === "supports_sponsorship") return "Sponsorship supported";
  if (job.sponsorship_status === "no_sponsorship") return "No sponsorship";
  return job.authorization_category_label || "Authorization not specified";
}

function primarySpecialization(job) {
  const map = taxonomyMaps(state.payload).specializations;
  const values = job._specializations;
  if (!values.length) return "Uncategorized";
  const label = map.get(values[0]) || values[0].replaceAll("_", " ");
  return values.length > 1 ? `${label} +${values.length - 1}` : label;
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
    const location = job.location || "Location not stated";
    const experience = job.experience_display || "Experience not stated";
    const sponsorship = sponsorshipLabel(job);
    const specialization = primarySpecialization(job);
    return `
      <div class="job-row${state.selectedId === job.id ? " is-selected" : ""}" role="option" tabindex="-1" aria-selected="${state.selectedId === job.id}" data-job-id="${escapeHtml(job.id)}">
        <div class="job-age-cell"><span class="job-age${days === 0 ? " is-new" : ""}">${days === 0 ? "NEW" : `${days}D<small>AGO</small>`}</span></div>
        <div class="job-main">
          <h2 class="job-title">${highlightText(job.title)}</h2>
          <p class="job-company">${highlightText(job.company)}<span class="job-loc-sep">·</span><span class="job-loc">${highlightText(location)}</span></p>
          <div class="job-meta">
            <span>${highlightText(experience)}</span>
            <span class="${authSignalClass(job)}">${highlightText(sponsorship)}</span>
            <span>${highlightText(specialization)}</span>
          </div>
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
  if (!empty) return;
  if (state.view === "shortlist" && !Object.keys(state.shortlist).length) {
    state.emptyActionMode = "browse-all";
    els.empty_title.textContent = "Your shortlist is empty";
    els.empty_copy.textContent = "Bookmark promising roles from All jobs to compare them here.";
    els.empty_action.textContent = "Browse all jobs";
  } else if (state.filters.query && state.searchLexicalCount === 0 && !state.searchPending) {
    state.emptyActionMode = "clear-search";
    els.empty_title.textContent = "No search matches yet";
    els.empty_copy.textContent = state.searchCorrectedQuery
      ? "Try the suggested spelling above or remove one search term."
      : "Try a broader role, skill, company, or location term.";
    els.empty_action.textContent = "Clear search";
  } else if (state.filters.query && state.searchLexicalCount > 0) {
    state.emptyActionMode = "clear-structured";
    els.empty_title.textContent = "Matches are hidden by filters";
    els.empty_copy.textContent = `${formatCount(state.searchLexicalCount)} search ${state.searchLexicalCount === 1 ? "match is" : "matches are"} outside the current filters or view.`;
    els.empty_action.textContent = "Clear filters";
  } else {
    state.emptyActionMode = "clear-filters";
    els.empty_title.textContent = "Nothing on the board matches";
    els.empty_copy.textContent = "Clear one or more filters to widen the search.";
    els.empty_action.textContent = "Clear filters";
  }
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
  const sponsorship = job.sponsorship_status === "supports_sponsorship" ? "Supports sponsorship"
    : job.sponsorship_status === "no_sponsorship" ? "No sponsorship" : "Not specified";
  els.detail_content.innerHTML = `
    <header class="detail-header">
      <div class="detail-header-top">
        <div class="company-line"><span class="company-avatar">${escapeHtml(companyInitials(job.company))}</span>${escapeHtml(job.company)}</div>
        <button class="icon-button mobile-detail-close" type="button" data-close-detail aria-label="Close job details">${closeIcon()}</button>
      </div>
      <h2>${escapeHtml(job.title)}</h2>
      <p class="detail-subline">Posted ${escapeHtml(new Date(`${job.posted_on}T00:00:00`).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }))}</p>
      <div class="detail-actions">
        <button class="button button-secondary${saved ? " is-saved" : ""}" type="button" data-shortlist-id="${escapeHtml(job.id)}" aria-pressed="${saved}">${bookmarkIcon()} ${saved ? "Shortlisted" : "Shortlist"}</button>
        ${job.job_link ? `<a class="button button-primary" href="${escapeHtml(job.job_link)}" target="_blank" rel="noopener noreferrer">Apply on company site <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 5h5v5m0-5-9 9M19 13v6H5V5h6"/></svg></a>` : ""}
      </div>
    </header>
    <div class="decision-grid">
      <div class="decision-item"><span class="decision-label">Location</span><span class="decision-value">${escapeHtml(job.location || "Not stated")}</span></div>
      <div class="decision-item"><span class="decision-label">Experience</span><span class="decision-value">${escapeHtml(job.experience_display || "Not stated")}</span></div>
      <div class="decision-item"><span class="decision-label">Sponsorship</span><span class="decision-value ${authSignalClass(job)}">${escapeHtml(sponsorship)}</span></div>
      <div class="decision-item"><span class="decision-label">Authorization</span><span class="decision-value ${authSignalClass(job)}">${escapeHtml(job.authorization_category_label || "Not specified")}</span></div>
    </div>
    ${summarySection(job)}
    ${renderMatchEvidence(job)}
    <section class="detail-section">
      <h3>Role classification</h3>
      <div class="taxonomy-row">${taxonomyTags.map((tag) => `<span class="taxonomy-tag">${escapeHtml(tag)}</span>`).join("") || '<span class="taxonomy-tag">Uncategorized</span>'}</div>
      <p class="disclosure">Classification and authorization signals are model-derived. Verify all requirements on the employer site.</p>
    </section>`;
}

function selectJob(id, { openMobile = true } = {}) {
  if (!state.jobs.some((job) => job.id === id)) return;
  state.selectedId = id;
  if (openMobile && window.matchMedia("(max-width: 840px)").matches) document.body.classList.add("detail-open");
  render();
}

function render() {
  if (!state.payload) return;
  const results = currentResults();
  if (state.selectedId && !results.some((job) => job.id === state.selectedId)) state.selectedId = "";
  document.querySelectorAll("[data-view]").forEach((button) => {
    const active = button.dataset.view === state.view;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  els.results_heading.textContent = state.view === "shortlist" ? "Shortlist" : "All jobs";
  els.results_summary.textContent = state.searchPending && state.filters.query
    ? `Searching ${formatCount(results.length)} current ${results.length === 1 ? "match" : "matches"}…`
    : `${formatCount(results.length)} ${results.length === 1 ? "role" : "roles"} in view`;
  els.all_count.textContent = `(${formatCount(state.jobs.length)})`;
  els.shortlist_count.textContent = formatCount(Object.keys(state.shortlist).length);
  if (els.filter_apply) els.filter_apply.textContent = `Show ${formatCount(results.length)} ${results.length === 1 ? "role" : "roles"}`;
  els.match_mode.textContent = state.resumeActive ? `Sorted by ${state.resumeMode}` : "";
  els.match_mode.classList.toggle("hidden", !state.resumeActive);
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
  renderStorageWarning();
}

function clearFilters() {
  state.filters = freshFilters();
  state.visibleLimit = PAGE_BATCH;
  state.selectedId = "";
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
}

async function applyResume() {
  const raw = els.resume_input.value;
  if (raw.replace(/\s/g, "").length < 200 || tokenize(raw).length < 20) {
    setResumeStatus("Paste at least 200 non-whitespace characters and 20 meaningful words.", true);
    return;
  }
  els.resume_apply.disabled = true;
  setResumeStatus("Preparing local matching…");
  try {
    const result = await resumeMatcher.score(raw, state.jobs);
    state.resumeActive = true;
    state.resumeTokens = result.resumeTokens;
    state.resumeMode = result.mode;
    state.visibleLimit = PAGE_BATCH;
    setResumeStatus(`Matching is active (${result.mode}). Nothing was uploaded or saved.`);
    els.resume_dialog.close();
    render();
  } finally {
    els.resume_apply.disabled = false;
  }
}

function clearResume() {
  state.resumeActive = false;
  state.resumeTokens = [];
  state.resumeMode = "";
  state.jobs.forEach((job) => { job._resumeScore = null; });
  els.resume_input.value = "";
  setResumeStatus("Matching combines local semantic relevance with visible keyword evidence.");
  els.resume_dialog.close();
  render();
}

function bindEvents() {
  document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => {
    state.view = button.dataset.view;
    state.visibleLimit = PAGE_BATCH;
    state.selectedId = "";
    writeUrlState();
    render();
  }));
  els.search_input.addEventListener("input", () => {
    window.clearTimeout(searchTimer);
    state.suggestionsOpen = false;
    renderSearchChrome();
    searchTimer = window.setTimeout(() => {
      setSearchQuery(els.search_input.value);
    }, 120);
  });
  els.search_input.addEventListener("focus", () => {
    state.suggestionsOpen = state.searchSuggestions.length > 0;
    renderSearchChrome();
  });
  els.search_input.addEventListener("keydown", (event) => {
    if (!["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(event.key)) return;
    if (event.key === "Escape") {
      state.suggestionsOpen = false;
      state.suggestionIndex = -1;
      renderSearchChrome();
      return;
    }
    if (!state.searchSuggestions.length) return;
    if (event.key === "Enter") {
      if (!state.suggestionsOpen || state.suggestionIndex < 0) return;
      event.preventDefault();
      setSearchQuery(state.searchSuggestions[state.suggestionIndex].query, { keepFocus: true });
      return;
    }
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
    if (event.key === "Escape") {
      state.suggestionsOpen = false;
      state.suggestionIndex = -1;
      renderSearchChrome();
      closeFilters();
      document.body.classList.remove("detail-open");
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
      persist(); writeUrlState(); render();
    }, 120);
  });
  els.posted_filter.addEventListener("change", () => {
    state.filters.postedRange = els.posted_filter.value;
    state.visibleLimit = PAGE_BATCH;
    persist(); writeUrlState(); render();
  });
  els.sort_filter.addEventListener("change", () => {
    state.filters.sort = els.sort_filter.value;
    persist(); writeUrlState(); render();
  });
  els.clear_filters.addEventListener("click", clearFilters);
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
    if (event.target.closest("[data-close-detail]")) document.body.classList.remove("detail-open");
  });
  els.load_more.addEventListener("click", () => { state.visibleLimit += PAGE_BATCH; render(); });
  els.empty_action.addEventListener("click", () => {
    if (state.emptyActionMode === "browse-all") {
      state.view = "all"; writeUrlState(); render();
    } else if (state.emptyActionMode === "clear-search") {
      setSearchQuery("");
    } else if (state.emptyActionMode === "clear-structured") {
      clearStructuredFilters();
    } else clearFilters();
  });
  els.mobile_filter_open.addEventListener("click", openFilters);
  els.mobile_filter_close.addEventListener("click", closeFilters);
  els.filter_apply.addEventListener("click", closeFilters);
  els.sheet_backdrop.addEventListener("click", closeFilters);
  els.resume_open.addEventListener("click", () => els.resume_dialog.showModal());
  els.resume_apply.addEventListener("click", applyResume);
  els.resume_clear.addEventListener("click", clearResume);
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY) return;
    const loaded = loadStorage();
    state.filters = loaded.value.filters;
    state.shortlist = pruneShortlist(loaded.value.shortlist, new Set(state.jobs.map((job) => job.id))).shortlist;
    state.storageWarning = loaded.warning;
    syncControlsFromState();
    requestAdvancedSearch();
    render();
  });
  window.addEventListener("popstate", () => {
    state.filters = readUrlState(state.filters);
    state.view = new URLSearchParams(window.location.search).get("view") === "shortlist" ? "shortlist" : "all";
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

  const response = await fetch("./data/public_jobs.json");
  if (!response.ok) throw new Error(`Current jobs could not be loaded (${response.status}).`);
  state.payload = await response.json();
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
  bindEvents();
  writeUrlState();
  render();
  window.setTimeout(startSearchWorker, 0);
  if (requestedJobId && state.jobs.some((job) => job.id === requestedJobId)) {
    await selectJob(requestedJobId);
  }
}

await init().catch((error) => {
  els.results_summary.textContent = "The current job feed could not be loaded.";
  els.empty_state.classList.remove("hidden");
  els.job_list.classList.add("hidden");
  els.empty_title.textContent = "Job data is unavailable";
  els.empty_copy.textContent = error.message;
  els.empty_action.classList.add("hidden");
});

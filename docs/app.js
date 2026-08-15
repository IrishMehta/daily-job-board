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
import { explainResumeMatch, filterAndSortJobs, normalizeText, ResumeMatcher, tokenize } from "./matching.js";

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
};

const els = Object.fromEntries([
  "freshness", "job-count", "filter-apply", "all-count", "shortlist-count", "repo-link", "resume-open", "search-input", "mobile-filter-open",
  "mobile-filter-close", "mobile-filter-count", "filter-panel", "domain-filter", "specialization-filter",
  "industry-filter", "location-filter", "location-suggestions", "career-filter", "experience-years-filter", "authorization-filter",
  "sponsorship-filter", "posted-filter", "sort-filter", "clear-filters", "active-filters", "storage-warning",
  "results-heading", "results-summary", "match-mode", "job-list", "empty-state", "empty-title", "empty-copy",
  "empty-action", "load-more", "detail-pane", "detail-empty", "detail-content", "sheet-backdrop", "resume-dialog",
  "resume-input", "resume-status", "resume-clear", "resume-apply", "toast",
].map((id) => [id.replaceAll("-", "_"), document.getElementById(id)]));

const resumeMatcher = new ResumeMatcher((message) => setResumeStatus(message));
let searchTimer = null;
let toastTimer = null;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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
    const taxonomyText = [
      ...domains.map((value) => labels.domains.get(value) || value),
      ...specializations.map((value) => labels.specializations.get(value) || value),
      ...industries.map((value) => labels.industries.get(value) || value),
    ].join(" ");
    return {
      ...job,
      _domains: domains,
      _specializations: specializations,
      _industries: industries,
      _locationSearch: normalizeText([job.location, ...(job.location_profile?.search_terms ?? [])].join(" ")),
      _searchText: normalizeText([
        job.title, job.company, job.location, job.experience_display, job.work_authorization_display,
        taxonomyText, job.summary, job.description_excerpt, ...(job.match_terms ?? []),
      ].join(" ")),
      _resumeScore: null,
    };
  });
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

function populateFilters() {
  const taxonomy = state.payload.taxonomy ?? {};
  els.domain_filter.insertAdjacentHTML("beforeend", (taxonomy.domains ?? []).map((item) => option(item.value, item.label, item.count)).join(""));
  els.industry_filter.insertAdjacentHTML("beforeend", (taxonomy.industries ?? []).map((item) => option(item.value, item.label, item.count)).join(""));
  els.career_filter.insertAdjacentHTML("beforeend", (state.payload.career_buckets ?? []).map((item) => option(item.value, item.label, item.count)).join(""));
  els.authorization_filter.insertAdjacentHTML("beforeend", (state.payload.authorization_categories ?? []).map((item) => option(item.value, item.label, item.count)).join(""));
  els.sponsorship_filter.insertAdjacentHTML("beforeend", (state.payload.sponsorship_statuses ?? []).map((item) => option(item.value, item.label, item.count)).join(""));
  const locations = state.payload.locations ?? [...new Set(state.jobs.map((job) => job.location))].map((value) => ({ value }));
  els.location_suggestions.innerHTML = locations.slice(0, 100).map((item) => `<option value="${escapeHtml(item.value)}"></option>`).join("");
  updateSpecializationOptions();
  syncControlsFromState();
}

function updateSpecializationOptions() {
  const selectedDomain = state.filters.domains[0] || "";
  const domains = state.payload.taxonomy?.domains ?? [];
  const candidates = selectedDomain
    ? domains.find((item) => item.value === selectedDomain)?.specializations ?? []
    : domains.flatMap((item) => item.specializations ?? []);
  const unique = [...new Map(candidates.map((item) => [item.value, item])).values()];
  els.specialization_filter.innerHTML = '<option value="">All specializations</option>'
    + unique.map((item) => option(item.value, item.label, item.count)).join("");
  if (!unique.some((item) => state.filters.specializations.includes(item.value))) state.filters.specializations = [];
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
  updateSpecializationOptions();
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
  });
}

function renderJobList(results) {
  const visible = results.slice(0, state.visibleLimit);
  els.job_list.innerHTML = visible.map((job) => {
    const saved = Boolean(state.shortlist[job.id]);
    const days = jobAgeDays(job.posted_on);
    return `
      <div class="job-row${state.selectedId === job.id ? " is-selected" : ""}" role="option" tabindex="-1" aria-selected="${state.selectedId === job.id}" data-job-id="${escapeHtml(job.id)}">
        <div class="job-age-cell"><span class="job-age${days === 0 ? " is-new" : ""}">${days === 0 ? "NEW" : `${days}D<small>AGO</small>`}</span></div>
        <div class="job-main">
          <h2 class="job-title">${escapeHtml(job.title)}</h2>
          <p class="job-company">${escapeHtml(job.company)}<span class="job-loc-sep">·</span><span class="job-loc">${escapeHtml(job.location || "Location not stated")}</span></p>
          <div class="job-meta">
            <span>${escapeHtml(job.experience_display || "Experience not stated")}</span>
            <span class="${authSignalClass(job)}">${escapeHtml(sponsorshipLabel(job))}</span>
            <span>${escapeHtml(primarySpecialization(job))}</span>
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
    els.empty_title.textContent = "Your shortlist is empty";
    els.empty_copy.textContent = "Bookmark promising roles from All jobs to compare them here.";
    els.empty_action.textContent = "Browse all jobs";
  } else {
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
  const evidence = (job.classification_paths ?? []).map((path) => path.evidence_quote).find((value) => value && value !== "Not explicitly stated");
  return { tags: [...new Set(tags)], evidence };
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
  const taxonomy = taxonomyDetail(job);
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
      <div class="taxonomy-row">${taxonomy.tags.map((tag) => `<span class="taxonomy-tag">${escapeHtml(tag)}</span>`).join("") || '<span class="taxonomy-tag">Uncategorized</span>'}</div>
      ${taxonomy.evidence ? `<div class="evidence-block">“${escapeHtml(taxonomy.evidence)}”</div>` : ""}
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
  els.results_summary.textContent = `${formatCount(results.length)} ${results.length === 1 ? "role" : "roles"} in view`;
  els.all_count.textContent = `(${formatCount(state.jobs.length)})`;
  els.shortlist_count.textContent = formatCount(Object.keys(state.shortlist).length);
  if (els.filter_apply) els.filter_apply.textContent = `Show ${formatCount(results.length)} ${results.length === 1 ? "role" : "roles"}`;
  els.match_mode.textContent = state.resumeActive ? `Sorted by ${state.resumeMode}` : "";
  els.match_mode.classList.toggle("hidden", !state.resumeActive);
  els.sort_filter.disabled = state.resumeActive;
  els.sort_filter.title = state.resumeActive ? "Resume relevance controls sorting while matching is active." : "";
  els.resume_clear.classList.toggle("hidden", !state.resumeActive);
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
    searchTimer = window.setTimeout(() => {
      state.filters.query = els.search_input.value.trim();
      state.visibleLimit = PAGE_BATCH;
      persist();
      writeUrlState();
      render();
    }, 120);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "/" && !/input|textarea|select/i.test(document.activeElement?.tagName)) {
      event.preventDefault();
      els.search_input.focus();
    }
    if (event.key === "Escape") {
      closeFilters();
      document.body.classList.remove("detail-open");
    }
  });
  els.domain_filter.addEventListener("change", () => {
    state.filters.domains = els.domain_filter.value ? [els.domain_filter.value] : [];
    state.filters.specializations = [];
    updateSpecializationOptions();
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
    if (state.view === "shortlist" && !Object.keys(state.shortlist).length) {
      state.view = "all"; writeUrlState(); render();
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
    render();
  });
  window.addEventListener("popstate", () => {
    state.filters = readUrlState(state.filters);
    state.view = new URLSearchParams(window.location.search).get("view") === "shortlist" ? "shortlist" : "all";
    syncControlsFromState();
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

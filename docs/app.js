const state = {
  payload: null,
  search: "",
  location: "",
  careerBucket: "",
  authorizationCategory: "",
  sponsorshipStatus: "",
  sort: "date_desc",
};

const els = {
  generatedAt: document.getElementById("generated-at"),
  repoLink: document.getElementById("repo-link"),
  statTotal: document.getElementById("stat-total"),
  statEarly: document.getElementById("stat-early"),
  statMid: document.getElementById("stat-mid"),
  statManagerial: document.getElementById("stat-managerial"),
  searchInput: document.getElementById("search-input"),
  locationFilter: document.getElementById("location-filter"),
  careerFilter: document.getElementById("career-filter"),
  authFilter: document.getElementById("auth-filter"),
  sponsorshipFilter: document.getElementById("sponsorship-filter"),
  sortSelect: document.getElementById("sort-select"),
  resetButton: document.getElementById("reset-button"),
  resultsMeta: document.getElementById("results-meta"),
  resultsBody: document.getElementById("results-body"),
  emptyState: document.getElementById("empty-state"),
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
  if (!value) {
    return "Unknown";
  }
  return value;
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
    return [...new Set(parts)].join(" | ");
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
    return [...new Set(parts)].join(", ");
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

function buildLocationOptions(jobs) {
  const counts = new Map();
  jobs.forEach((job) => {
    const location = normalizeLocation(job.location);
    counts.set(location, (counts.get(location) ?? 0) + 1);
  });
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([value, count]) => ({ value, label: value, count }));
}

function populateSelect(select, options) {
  options.forEach((option) => {
    const el = document.createElement("option");
    el.value = option.value;
    el.textContent = option.count !== undefined ? `${option.label} (${option.count})` : option.label;
    select.appendChild(el);
  });
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

function applyFilters(jobs) {
  const query = state.search.trim().toLowerCase();
  const filtered = jobs.filter((job) => {
    if (state.location && job.location !== state.location) {
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
    const haystack = [
      job.title,
      job.company,
      job.location,
      job.career_bucket_label,
      job.authorization_category_label,
      job.work_authorization_display,
      job.experience_display,
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(query);
  });

  filtered.sort((a, b) => {
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

  return filtered;
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

function renderRows(jobs) {
  if (!jobs.length) {
    els.resultsBody.innerHTML = "";
    els.emptyState.classList.remove("hidden");
    els.resultsMeta.textContent = "0 jobs match the current filters.";
    return;
  }

  els.emptyState.classList.add("hidden");
  els.resultsMeta.textContent = `${jobs.length} job${jobs.length === 1 ? "" : "s"} shown`;
  els.resultsBody.innerHTML = jobs
    .map(
      (job) => `
        <tr>
          <td><span class="cell-date">${escapeHtml(formatDate(job.posted_on))}</span></td>
          <td><span class="cell-primary">${escapeHtml(job.company)}</span></td>
          <td><span class="cell-primary">${escapeHtml(job.title)}</span></td>
          <td><span class="cell-secondary">${escapeHtml(job.location)}</span></td>
          <td><span class="pill pill-bucket">${escapeHtml(job.career_bucket_label)}</span></td>
          <td><span class="cell-primary">${escapeHtml(job.experience_display)}</span></td>
          <td><span class="pill pill-auth">${escapeHtml(job.authorization_category_label)}</span></td>
          <td><span class="pill pill-neutral">${escapeHtml(job.sponsorship_status.replaceAll("_", " "))}</span></td>
          <td><a class="link-button" href="${escapeHtml(job.job_link)}" target="_blank" rel="noopener noreferrer">Apply</a></td>
        </tr>
      `
    )
    .join("");
}

function render() {
  if (!state.payload) {
    return;
  }
  const filtered = applyFilters(state.payload.jobs);
  renderRows(filtered);
}

function bindControls() {
  els.searchInput.addEventListener("input", (event) => {
    state.search = event.target.value;
    render();
  });
  els.locationFilter.addEventListener("change", (event) => {
    state.location = event.target.value;
    render();
  });
  els.careerFilter.addEventListener("change", (event) => {
    state.careerBucket = event.target.value;
    render();
  });
  els.authFilter.addEventListener("change", (event) => {
    state.authorizationCategory = event.target.value;
    render();
  });
  els.sponsorshipFilter.addEventListener("change", (event) => {
    state.sponsorshipStatus = event.target.value;
    render();
  });
  els.sortSelect.addEventListener("change", (event) => {
    state.sort = event.target.value;
    render();
  });
  els.resetButton.addEventListener("click", () => {
    state.search = "";
    state.location = "";
    state.careerBucket = "";
    state.authorizationCategory = "";
    state.sponsorshipStatus = "";
    state.sort = "date_desc";
    els.searchInput.value = "";
    els.locationFilter.value = "";
    els.careerFilter.value = "";
    els.authFilter.value = "";
    els.sponsorshipFilter.value = "";
    els.sortSelect.value = "date_desc";
    render();
  });
}

async function init() {
  const response = await fetch("./data/public_jobs.json");
  if (!response.ok) {
    throw new Error(`Failed to load site data: ${response.status}`);
  }
  state.payload = await response.json();
  state.payload.jobs = (state.payload.jobs ?? []).map((job) => ({
    ...job,
    company: normalizeCompany(job.company),
    location: normalizeLocation(job.location),
  }));
  state.payload.locations = buildLocationOptions(state.payload.jobs);
  loadStats(state.payload);
  populateSelect(els.locationFilter, state.payload.locations);
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

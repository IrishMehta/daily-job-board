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

export function sortFacetItems(items) {
  return [...items].sort((left, right) =>
    String(left.label || left.value).localeCompare(String(right.label || right.value), "en", { sensitivity: "base" })
      || String(left.value).localeCompare(String(right.value)));
}

function hasAny(jobValues, selectedValues) {
  return !selectedValues.length || selectedValues.some((value) => jobValues.includes(value));
}

function postedCutoff(range, jobs) {
  const days = Number.parseInt(range, 10) || 7;
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

export function filterJobs(jobs, filters, { shortlist = null, searchScores = null, ignoreFilters = [] } = {}) {
  const ignored = new Set(ignoreFilters);
  const queryTokens = tokenize(filters.query);
  const rankedSearch = Boolean(filters.query) && searchScores instanceof Map;
  const cutoff = postedCutoff(filters.postedRange, jobs);
  const years = Number.parseInt(filters.experienceYears, 10);
  const yearsActive = Number.isInteger(years) && years >= 0;
  return jobs.filter((job) => {
    if (shortlist && !shortlist[job.id]) return false;
    if (!ignored.has("postedRange") && cutoff && new Date(`${job.posted_on}T00:00:00`) < cutoff) return false;
    const locationFilters = Array.isArray(filters.location) ? filters.location : [];
    if (!ignored.has("location") && !hasAny(job._locationCategories ?? [], locationFilters)) return false;
    if (!ignored.has("domains") && !hasAny(job._domains, filters.domains)) return false;
    if (!ignored.has("specializations") && !hasAny(job._specializations, filters.specializations)) return false;
    if (!ignored.has("industries") && !hasAny(job._industries, filters.industries)) return false;
    if (!ignored.has("experienceYears") && yearsActive && job.yoe_min != null && job.yoe_min > years) return false;
    if (!ignored.has("careerBuckets") && filters.careerBuckets.length && !filters.careerBuckets.includes(job.career_bucket)) return false;
    if (!ignored.has("authorizationCategories") && filters.authorizationCategories.length && !filters.authorizationCategories.includes(job.authorization_category)) return false;
    if (!ignored.has("sponsorshipStatuses") && filters.sponsorshipStatuses.length && !filters.sponsorshipStatuses.includes(job.sponsorship_status)) return false;
    if (rankedSearch) return searchScores.has(job.id);
    return queryTokens.every((token) => job._searchText.includes(token));
  });
}

export function countFacetValues(jobs, filters, valueSelector, options = {}) {
  const counts = new Map();
  filterJobs(jobs, filters, options).forEach((job) => {
    const selected = valueSelector(job);
    const values = Array.isArray(selected) ? selected : [selected];
    new Set(values.filter(Boolean)).forEach((value) => counts.set(value, (counts.get(value) ?? 0) + 1));
  });
  return counts;
}

export function filterAndSortJobs(jobs, filters, { shortlist = null, searchScores = null } = {}) {
  const rankedSearch = Boolean(filters.query) && searchScores instanceof Map;
  const filtered = filterJobs(jobs, filters, { shortlist, searchScores });

  filtered.sort((a, b) => {
    if (filters.sort === "relevance" && rankedSearch) {
      return (searchScores.get(b.id) ?? Number.NEGATIVE_INFINITY) - (searchScores.get(a.id) ?? Number.NEGATIVE_INFINITY)
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

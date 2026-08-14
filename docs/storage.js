export const STORAGE_KEY = "jobDiscoveryBoard:v1";

export const DEFAULT_FILTERS = Object.freeze({
  query: "",
  domains: [],
  specializations: [],
  industries: [],
  location: "",
  careerBuckets: [],
  authorizationCategories: [],
  sponsorshipStatuses: [],
  postedRange: "7d",
  sort: "date_desc",
});

const ARRAY_FILTERS = [
  "domains",
  "specializations",
  "industries",
  "careerBuckets",
  "authorizationCategories",
  "sponsorshipStatuses",
];

export function freshFilters() {
  return { ...DEFAULT_FILTERS, ...Object.fromEntries(ARRAY_FILTERS.map((key) => [key, []])) };
}

function cleanString(value, maxLength = 300) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function cleanStringArray(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => cleanString(item, 120)).filter(Boolean))].slice(0, 50);
}

export function sanitizeFilters(value) {
  const input = value && typeof value === "object" ? value : {};
  const filters = freshFilters();
  filters.query = cleanString(input.query);
  filters.location = cleanString(input.location);
  ARRAY_FILTERS.forEach((key) => { filters[key] = cleanStringArray(input[key]); });
  filters.postedRange = ["1d", "3d", "7d"].includes(input.postedRange) ? input.postedRange : "7d";
  filters.sort = ["date_desc", "date_asc", "experience_asc", "experience_desc", "company_asc"].includes(input.sort)
    ? input.sort
    : "date_desc";
  return filters;
}

function sanitizeShortlist(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const shortlist = {};
  Object.entries(value).slice(0, 5000).forEach(([id, entry]) => {
    const cleanId = cleanString(id, 2000);
    if (!cleanId) return;
    const savedAt = cleanString(entry?.savedAt, 64);
    shortlist[cleanId] = { savedAt: savedAt || new Date().toISOString() };
  });
  return shortlist;
}

export function createStorageState(filters = freshFilters(), shortlist = {}) {
  return { schemaVersion: 1, filters: sanitizeFilters(filters), shortlist: sanitizeShortlist(shortlist) };
}

export function loadStorage() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { value: createStorageState(), warning: "" };
    const parsed = JSON.parse(raw);
    if (parsed?.schemaVersion !== 1) {
      return { value: createStorageState(), warning: "Saved preferences used an unsupported version and were reset." };
    }
    return { value: createStorageState(parsed.filters, parsed.shortlist), warning: "" };
  } catch {
    return { value: createStorageState(), warning: "Saved preferences could not be read. This session will continue normally." };
  }
}

export function saveStorage(value) {
  const cleanValue = createStorageState(value.filters, value.shortlist);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cleanValue));
    return { value: cleanValue, warning: "" };
  } catch {
    return { value: cleanValue, warning: "Preferences could not be saved in this browser." };
  }
}

export function pruneShortlist(shortlist, validIds) {
  const valid = validIds instanceof Set ? validIds : new Set(validIds);
  const next = {};
  let removed = 0;
  Object.entries(sanitizeShortlist(shortlist)).forEach(([id, value]) => {
    if (valid.has(id)) next[id] = value;
    else removed += 1;
  });
  return { shortlist: next, removed };
}

export function toggleShortlist(shortlist, id) {
  const next = { ...sanitizeShortlist(shortlist) };
  if (next[id]) delete next[id];
  else next[id] = { savedAt: new Date().toISOString() };
  return next;
}

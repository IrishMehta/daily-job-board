export const US_STATE_OPTIONS = Object.freeze([
  ["AL", "Alabama"], ["AK", "Alaska"], ["AZ", "Arizona"], ["AR", "Arkansas"],
  ["CA", "California"], ["CO", "Colorado"], ["CT", "Connecticut"], ["DE", "Delaware"],
  ["FL", "Florida"], ["GA", "Georgia"], ["HI", "Hawaii"], ["ID", "Idaho"],
  ["IL", "Illinois"], ["IN", "Indiana"], ["IA", "Iowa"], ["KS", "Kansas"],
  ["KY", "Kentucky"], ["LA", "Louisiana"], ["ME", "Maine"], ["MD", "Maryland"],
  ["MA", "Massachusetts"], ["MI", "Michigan"], ["MN", "Minnesota"], ["MS", "Mississippi"],
  ["MO", "Missouri"], ["MT", "Montana"], ["NE", "Nebraska"], ["NV", "Nevada"],
  ["NH", "New Hampshire"], ["NJ", "New Jersey"], ["NM", "New Mexico"], ["NY", "New York"],
  ["NC", "North Carolina"], ["ND", "North Dakota"], ["OH", "Ohio"], ["OK", "Oklahoma"],
  ["OR", "Oregon"], ["PA", "Pennsylvania"], ["RI", "Rhode Island"], ["SC", "South Carolina"],
  ["SD", "South Dakota"], ["TN", "Tennessee"], ["TX", "Texas"], ["UT", "Utah"],
  ["VT", "Vermont"], ["VA", "Virginia"], ["WA", "Washington"], ["WV", "West Virginia"],
  ["WI", "Wisconsin"], ["WY", "Wyoming"],
].map(([value, label]) => Object.freeze({ value, label })));

export const LOCATION_FILTER_OPTIONS = Object.freeze([
  ...US_STATE_OPTIONS,
  { value: "remote", label: "Remote" },
  { value: "hybrid", label: "Hybrid" },
  { value: "others", label: "Others" },
]);

const stateCodes = new Set(US_STATE_OPTIONS.map((item) => item.value));
const locationValues = new Map(LOCATION_FILTER_OPTIONS.flatMap(({ value, label }) => [
  [value.toLowerCase(), value],
  [label.toLowerCase(), value],
]));

export function sanitizeLocationFilterValues(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((item) => locationValues.get(String(item ?? "").trim().toLowerCase()))
    .filter(Boolean))].slice(0, LOCATION_FILTER_OPTIONS.length);
}

export function locationCategoriesForJob(job) {
  const profile = job.location_profile ?? {};
  const locationText = String(job.location || profile.display || profile.label || "");
  const categories = [];
  if (/\bremote\b/i.test(locationText)) categories.push("remote");
  if (/\bhybrid\b/i.test(locationText)) categories.push("hybrid");

  const displayedStateCodes = [...locationText.matchAll(/,\s*([A-Z]{2})(?=$|\W)/g)].map((match) => match[1]);
  const standaloneStateCode = locationText.trim().toUpperCase();
  [standaloneStateCode, ...displayedStateCodes].forEach((value) => {
    if (stateCodes.has(value) && !categories.includes(value)) categories.push(value);
  });
  if (!categories.length) categories.push("others");
  return categories;
}

export function locationFilterLabel(value) {
  return LOCATION_FILTER_OPTIONS.find((item) => item.value === value)?.label || value;
}

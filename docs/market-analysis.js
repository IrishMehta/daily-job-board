import { US_STATE_PATHS } from "./us-states-map.js";

const DATA_URL = "./data/market_analysis.json";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function number(value) {
  return Number(value) || 0;
}

function count(value) {
  return new Intl.NumberFormat("en-US", { notation: Number(value) >= 10000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(number(value));
}

function fullCount(value) {
  return new Intl.NumberFormat("en-US").format(number(value));
}

function money(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 0,
  }).format(number(value));
}

function percent(value, digits = 0) {
  return `${(number(value) * 100).toFixed(digits)}%`;
}

function shortDate(value) {
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function fullDate(value) {
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function isWeekend(value) {
  const day = new Date(`${value}T12:00:00`).getDay();
  return day === 0 || day === 6;
}

const TECHNICAL_SKILL_CATEGORIES = new Set([
  "ai_model_product", "business_productivity_tool", "cloud_platform_service",
  "devops_infrastructure", "engineering_design_tool", "framework_library",
  "operating_system", "programming_language", "protocol_standard",
  "technical_concept_method", "certification",
]);

function humanLabel(value) {
  return String(value || "")
    .replaceAll("_", " ")
    .replace(/\bOr\b/g, "or")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function movingAverage(values, windowSize = 7) {
  return values.map((_, index) => {
    const start = Math.max(0, index - windowSize + 1);
    const sample = values.slice(start, index + 1);
    return sample.reduce((sum, value) => sum + value, 0) / sample.length;
  });
}

function pathFrom(points) {
  return points.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
}

function pulseChart(points, label, missingDates = []) {
  if (!points?.length) return '<p class="market-empty">No daily observations are available for this view.</p>';
  const width = 1080;
  const height = 310;
  const left = 46;
  const right = 18;
  const top = 24;
  const bottom = 40;
  const values = points.map((point) => number(point.count));
  const maximum = Math.max(...values, 1);
  const averages = movingAverage(values);
  const x = (index) => left + (index / Math.max(points.length - 1, 1)) * (width - left - right);
  const y = (value) => height - bottom - (value / maximum) * (height - top - bottom);
  const coordinates = points.map((point, index) => ({ ...point, x: x(index), y: y(values[index]) }));
  const averageCoordinates = averages.map((value, index) => ({ x: x(index), y: y(value) }));
  const line = pathFrom(coordinates);
  const averageLine = pathFrom(averageCoordinates);
  const area = `${line} L${coordinates.at(-1).x.toFixed(1)},${height - bottom} L${coordinates[0].x.toFixed(1)},${height - bottom} Z`;
  const peakIndex = values.indexOf(maximum);
  const weekdayValues = values.filter((_, index) => !isWeekend(points[index].date));
  const weekdayAverage = weekdayValues.reduce((sum, value) => sum + value, 0) / Math.max(weekdayValues.length, 1);
  const average = (sample) => sample.reduce((sum, value) => sum + value, 0) / Math.max(sample.length, 1);
  const recentAverage = average(values.slice(-7));
  const previousAverage = average(values.slice(-14, -7));
  const change = previousAverage ? (recentAverage - previousAverage) / previousAverage : 0;
  const changeLabel = change > 0.04 ? `up ${Math.round(change * 100)}%` : change < -0.04 ? `down ${Math.round(Math.abs(change) * 100)}%` : `holding steady (${change >= 0 ? "+" : ""}${Math.round(change * 100)}%)`;
  const missing = new Set(missingDates);
  const step = (width - left - right) / Math.max(points.length - 1, 1);
  const ticks = [0, 0.25, 0.5, 0.75, 1];

  return `<div class="pulse-wrap">
    <div class="pulse-summary" aria-label="Demand chart summary">
    <span><b>${fullCount(maximum)}</b> peak observed on ${shortDate(points[peakIndex].date)}</span>
      <span><b>${fullCount(Math.round(weekdayAverage))}</b> average weekday clusters</span>
      <span><b>${fullCount(Math.round(recentAverage))}</b> average clusters in the last 7 days</span>
      <span class="pulse-key"><i></i> daily <i></i> 7-day signal</span>
    </div>
    <div class="pulse-reading"><strong>What this says</strong><span>The 7-day signal is <b>${changeLabel}</b> versus the previous 7 days. Daily spikes and dips are normal; use the smoothed line to judge direction.</span></div>
    <svg class="market-pulse" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(label)} daily observed job clusters over 30 days">
      <defs>
        <linearGradient id="pulse-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7fb4c2" stop-opacity=".28"/><stop offset="1" stop-color="#7fb4c2" stop-opacity=".03"/></linearGradient>
        <filter id="pulse-glow"><feGaussianBlur stdDeviation="4" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      </defs>
      ${coordinates.map((point, index) => isWeekend(point.date) ? `<rect class="pulse-weekend" x="${(point.x - step / 2).toFixed(1)}" y="${top}" width="${step.toFixed(1)}" height="${height - top - bottom}"/>` : "").join("")}
      ${coordinates.map((point) => missing.has(point.date) ? `<rect class="pulse-missing" x="${(point.x - step / 2).toFixed(1)}" y="${top}" width="${step.toFixed(1)}" height="${height - top - bottom}"><title>Coverage gap: ${escapeHtml(shortDate(point.date))}</title></rect>` : "").join("")}
      ${ticks.map((tick) => `<g class="pulse-grid"><line x1="${left}" y1="${y(maximum * tick).toFixed(1)}" x2="${width - right}" y2="${y(maximum * tick).toFixed(1)}"/><text x="${left - 8}" y="${(y(maximum * tick) + 3).toFixed(1)}" text-anchor="end">${fullCount(Math.round(maximum * tick))}</text></g>`).join("")}
      <path class="pulse-area" d="${area}"/>
      <path class="pulse-line" d="${line}"/>
      <path class="pulse-average" d="${averageLine}"/>
      ${coordinates.map((point, index) => `<circle class="pulse-point${index >= coordinates.length - 2 ? " is-latest" : ""}${missing.has(point.date) ? " is-missing" : ""}" cx="${point.x}" cy="${point.y}" r="4"><title>${escapeHtml(shortDate(point.date))}: ${fullCount(point.count)} observed clusters${missing.has(point.date) ? " · coverage gap" : ""}</title></circle>`).join("")}
      ${coordinates.filter((_, index) => index === 0 || index === coordinates.length - 1 || (index % 7 === 0 && index < coordinates.length - 2)).map((point, index, labels) => `<text class="pulse-date" x="${point.x}" y="${height - 12}" text-anchor="${index === 0 ? "start" : index === labels.length - 1 ? "end" : "middle"}">${escapeHtml(shortDate(point.date))}</text>`).join("")}
    </svg>
  </div>`;
}

function roleMap(items, activeKey = "", itemType = "domain", shareLabel = "Share of this view") {
  const ranked = (items || []).filter((item) => item.key !== "uncategorized");
  const visible = ranked.slice(0, 5);
  if (activeKey && !visible.some((item) => item.key === activeKey)) {
    const selected = ranked.find((item) => item.key === activeKey);
    if (selected) visible.push(selected);
  }
  if (!visible.length) return '<p class="market-empty">No role groups meet the reporting threshold.</p>';
  const maximum = Math.max(...visible.map((item) => number(item.count)), 1);
  const total = ranked.reduce((sum, item) => sum + number(item.count), 0);
  return `<div class="role-rank-list" aria-label="Role groups ranked by observed job clusters">
    <div class="role-rank-guide"><span>Top ${Math.min(5, ranked.length)}${ranked.length > 5 ? ` of ${ranked.length}` : ""}</span><span>${escapeHtml(shareLabel)} · click to focus</span></div>
    ${visible.map((item, index) => {
      const selected = activeKey && item.key === activeKey;
      const width = Math.max(4, number(item.count) / maximum * 100);
      const share = number(item.count) / Math.max(total, 1);
      return `<button class="role-rank-row tone-${index % 7}${selected ? " is-selected" : ""}" type="button" data-market-role="${escapeHtml(item.key)}" data-market-role-type="${itemType}" aria-pressed="${selected}" aria-label="Filter to ${escapeHtml(item.label)}, ${fullCount(item.count)} observed job clusters">
        <span class="role-rank-meta"><i>${String(index + 1).padStart(2, "0")}</i><b>${escapeHtml(item.label)}</b><em>${fullCount(item.count)} · ${percent(share, 1)}</em></span>
        <span class="role-rank-track"><i style="width:${width.toFixed(1)}%"></i></span>
      </button>`;
    }).join("")}
  </div>`;
}

function skillHeatmap(items) {
  const ranked = [...(items || [])].sort((left, right) => number(right.count) - number(left.count) || String(left.skill).localeCompare(String(right.skill)));
  const visible = ranked.slice(0, 10);
  if (!visible.length) return '<p class="market-empty">No skills meet the reporting threshold for this focus area.</p>';
  const categoryLabel = (value) => humanLabel(value || "unclassified");
  return `<div class="skill-board"><div class="skill-board-guide"><span>Top ${visible.length} skills</span><span>${ranked.length > visible.length ? `Showing ${visible.length} of ${ranked.length}` : "All reported skills"}</span></div><div class="skill-table" role="table" aria-label="Skills by category"><div class="skill-table-row skill-table-header" role="row"><span role="columnheader">#</span><span role="columnheader">Skill</span><span role="columnheader">Share</span><span role="columnheader">Clusters · 30d</span></div>${visible.map((item, index) => `<div class="skill-table-row" role="row"><span class="skill-rank" role="cell">${String(index + 1).padStart(2, "0")}</span><span class="skill-main" role="cell"><b>${escapeHtml(item.skill)}</b><small>${escapeHtml(categoryLabel(item.category))}</small></span><span class="skill-share" role="cell">${percent(item.share, 1)}</span><strong class="skill-count" role="cell">${count(item.count)}<span class="sr-only">${escapeHtml(item.skill)}: ${fullCount(item.count)} observed clusters in the rolling 30-day window</span></strong></div>`).join("")}</div>${ranked.length > visible.length ? '<p class="skill-board-more">Use the category filter above to explore a different slice.</p>' : ""}</div>`;
}

function salaryRails(items) {
  const ranked = (items || [])
    .filter((item) => item.p25 != null && item.p50 != null && item.p75 != null)
    .sort((left, right) => number(right.p50) - number(left.p50) || String(left.label).localeCompare(String(right.label)));
  const visible = ranked.slice(0, 6);
  if (!visible.length) return '<p class="market-empty">Not enough disclosed salaries meet the USD annual-base policy.</p>';
  const experienceKeys = new Set(["internship", "early_career_or_new_grad", "mid_career_or_senior", "managerial"]);
  const groupLabel = visible.some((item) => experienceKeys.has(item.key)) ? "Experience group" : "Role group";
  return `<div class="salary-simple"><div class="salary-guide"><span>Median = middle reported pay</span><span>Separate cohorts · do not average medians</span></div>
    <div class="salary-simple-table" role="table" aria-label="Salary comparison by ${groupLabel.toLowerCase()}">
      <div class="salary-simple-row salary-simple-header" role="row"><span role="columnheader">${groupLabel}</span><span role="columnheader">Typical range</span><span role="columnheader">Median</span><span role="columnheader">Sample</span></div>
      ${visible.map((item) => `<div class="salary-simple-row" role="row">
        <span class="salary-simple-role" role="cell"><b>${escapeHtml(item.label)}</b></span>
        <span class="salary-simple-range" role="cell">${money(item.p25)} – ${money(item.p75)}</span>
        <strong class="salary-simple-median" role="cell">${money(item.p50)}</strong>
        <span class="salary-simple-sample" role="cell">n=${fullCount(item.sample_size)}</span>
      </div>`).join("")}
    </div>
    <p class="salary-simple-note">Typical range means the middle 50% of disclosed base salaries. It is a guide, not a guarantee.</p>
  </div>`;
}

function pathCenter(path) {
  const coordinates = [...path.matchAll(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g)]
    .map((match) => [Number(match[1]), Number(match[2])]);
  if (!coordinates.length) return [0, 0];
  const xs = coordinates.map(([x]) => x);
  const ys = coordinates.map(([, y]) => y);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
}

function stateChoropleth(items) {
  const byState = new Map((items || []).map((item) => [String(item.key).toUpperCase(), item]));
  const maximum = Math.max(...[...byState.values()].map((item) => number(item.count)), 1);
  const leaders = (items || []).slice(0, 6);
  const leaderKeys = new Set(leaders.slice(0, 5).map((item) => String(item.key).toUpperCase()));
  return `<div class="state-choropleth">
    <svg class="us-state-map" viewBox="0 0 1050 620" role="img" aria-label="United States choropleth map; darker states have more observed technology job clusters">
      <g class="map-insets" aria-hidden="true"><rect x="10" y="414" width="270" height="194" rx="8"/><text x="24" y="436">ALASKA</text><rect x="294" y="516" width="220" height="91" rx="8"/><text x="308" y="538">HAWAII</text></g>
      <g class="map-states">
        ${US_STATE_PATHS.map((state) => {
          const item = byState.get(state.id);
          const strength = item ? Math.sqrt(number(item.count) / maximum) : 0;
          const opacity = item ? 0.16 + strength * 0.84 : 0;
          return `<path class="us-state-shape${item ? " has-data" : ""}" data-state="${state.id}" d="${state.d}" style="--heat:${strength.toFixed(3)};fill:rgba(255,194,75,${opacity.toFixed(3)})"><title>${escapeHtml(state.name)}: ${item ? `${fullCount(item.count)} observed clusters (${percent(item.share, 1)})` : "below the public reporting threshold"}</title></path>`;
        }).join("")}
      </g>
      <g class="map-state-labels" aria-hidden="true">${US_STATE_PATHS.filter((state) => leaderKeys.has(state.id)).map((state) => {
        const [x, y] = pathCenter(state.d);
        return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}">${state.id}</text>`;
      }).join("")}</g>
    </svg>
    <div class="map-scale" aria-hidden="true"><span>Lower signal</span><i></i><span>Higher signal</span></div>
    <div class="map-leaders" aria-label="States with the most observed job clusters">${leaders.map((item, index) => `<span><i>${String(index + 1).padStart(2, "0")}</i><b>${escapeHtml(String(item.key).toUpperCase())}</b><em>${fullCount(item.count)}</em></span>`).join("")}</div>
  </div>`;
}

function localityField(items, emptyMessage = "No city groups meet the reporting threshold.") {
  const visible = (items || []).slice(0, 8);
  if (!visible.length) return `<p class="market-empty">${escapeHtml(emptyMessage)}</p>`;
  const maximum = Math.max(...visible.map((item) => number(item.count)), 1);
  return `<div class="locality-list" aria-label="Leading city markets by observed job clusters"><div class="locality-list-guide"><span>City</span><span>Observed clusters</span></div>${visible.map((item, index) => {
    const width = Math.max(5, number(item.count) / maximum * 100);
    return `<div class="locality-row"><span class="locality-rank">${String(index + 1).padStart(2, "0")}</span><div><b>${escapeHtml(item.label.replace(/, [A-Za-z]{2}$/, ""))}</b><i><span style="width:${width.toFixed(1)}%"></span></i></div><strong>${fullCount(item.count)}</strong></div>`;
  }).join("")}</div>`;
}

function workModeRibbon(items) {
  const total = (items || []).reduce((sum, item) => sum + number(item.count), 0);
  if (!total) return '<p class="market-empty">Work-mode data is unavailable.</p>';
  const displayLabel = (item) => item.key === "onsite_or_unspecified" ? "Not marked remote" : item.label;
  return `<div class="mode-ribbon" role="img" aria-label="Work mode composition">
    <div>${items.map((item, index) => `<i class="tone-${index}" style="width:${(number(item.count) / total * 100).toFixed(2)}%"><span>${number(item.count) / total > 0.08 ? escapeHtml(displayLabel(item)) : ""}</span></i>`).join("")}</div>
    <ul>${items.map((item, index) => `<li><i class="tone-${index}"></i><span>${escapeHtml(displayLabel(item))}</span><b>${percent(number(item.count) / total, 1)}</b><small>${fullCount(item.count)} clusters</small></li>`).join("")}</ul>
  </div>`;
}

function careerLadder(items) {
  const rank = new Map([["internship", 0], ["early_career_or_new_grad", 1], ["mid_career_or_senior", 2], ["managerial", 3]]);
  const visible = [...(items || [])].sort((left, right) => (rank.get(left.key) ?? 99) - (rank.get(right.key) ?? 99));
  const maximum = Math.max(...visible.map((item) => number(item.count)), 1);
  return `<div class="career-ladder" aria-label="Demand by career level">${visible.map((item, index) => `<div class="career-row"><span>${String(index + 1).padStart(2, "0")}</span><i><b>${escapeHtml(item.label)}</b><small>${fullCount(item.count)} · ${percent(item.share, 1)}</small><em style="width:${Math.max(5, number(item.count) / maximum * 100).toFixed(1)}%"></em></i></div>`).join("")}</div>`;
}

function industryMosaic(items) {
  const visible = (items || []).slice(0, 6);
  const maximum = Math.max(...visible.map((item) => number(item.count)), 1);
  return `<div class="industry-list" aria-label="Leading industries">${visible.map((item, index) => `<div class="industry-row"><span>${String(index + 1).padStart(2, "0")}</span><div><b>${escapeHtml(item.label)}</b><i><span style="width:${Math.max(5, number(item.count) / maximum * 100).toFixed(1)}%"></span></i></div><strong>${percent(item.share, 1)}</strong></div>`).join("")}</div>`;
}

function skillNetwork(pairs, cohortCount = 0) {
  const visiblePairs = (pairs || []).slice(0, 6);
  if (!visiblePairs.length) return '<p class="market-empty">No skill pairs meet the reporting threshold.</p>';
  return `<div class="pair-list" aria-label="Most common skill combinations"><p class="pair-list-intro">These skills are frequently mentioned in the same job clusters. Use them as search or learning keywords; mentions do not prove that both are required.</p><div class="pair-grid">${visiblePairs.map((pair, index) => {
    const share = number(pair.count) / Math.max(number(cohortCount), 1);
    const query = encodeURIComponent(`${pair.skill_a} ${pair.skill_b}`);
    return `<div class="pair-card"><i>${String(index + 1).padStart(2, "0")}</i><div><b>${escapeHtml(pair.skill_a)}</b><span>+</span><b>${escapeHtml(pair.skill_b)}</b><small>${percent(share, 1)} of this view</small></div><strong>${fullCount(pair.count)}<small>job clusters</small></strong><a href="./?q=${query}">Browse related 7-day roles →</a></div>`;
  }).join("")}</div></div>`;
}

function option(value, label, selected = false) {
  return `<option value="${escapeHtml(value)}"${selected ? " selected" : ""}>${escapeHtml(label)}</option>`;
}

function panelHeader(kicker, title, note = "") {
  return `<header class="market-card-header"><div><span>${escapeHtml(kicker)}</span><h2>${escapeHtml(title)}</h2></div>${note ? `<small>${escapeHtml(note)}</small>` : ""}</header>`;
}

export function createMarketAnalysis() {
  const root = document.getElementById("market-analysis");
  const content = document.getElementById("market-content");
  const freshness = document.getElementById("market-freshness");
  const notice = document.getElementById("market-notice");
  const domainFilter = document.getElementById("market-domain-filter");
  const specializationFilter = document.getElementById("market-specialization-filter");
  const stateFilter = document.getElementById("market-state-filter");
  const careerFilter = document.getElementById("market-career-filter");
  const controls = document.getElementById("market-controls");
  const syncControlsDisclosure = () => {
    // Desktop has no visible summary trigger, so the filter fields must stay
    // open there. Mobile keeps the compact, user-controlled disclosure.
    controls.open = !window.matchMedia("(max-width: 640px)").matches;
  };
  syncControlsDisclosure();
  window.addEventListener("resize", syncControlsDisclosure);
  let payload = null;
  let loading = false;
  let loaded = false;
  let skillCategory = "technical";

  function loadingMarkup() {
    return `<div class="market-loading" aria-label="Preparing market data">
      <div class="market-skeleton market-skeleton-wide"></div>
      <div class="market-skeleton-row"><div class="market-skeleton"></div><div class="market-skeleton"></div><div class="market-skeleton"></div></div>
      <strong>Preparing the market view</strong><span>Coverage and freshness will appear when the aggregate data is ready.</span>
    </div>`;
  }

  function selectedContext() {
    const domain = domainFilter.value;
    const specialization = specializationFilter.value;
    const state = stateFilter.value;
    const career = careerFilter.value;
    const domainItem = payload.roles.domains.find((item) => item.key === domain);
    const specializationItem = payload.roles.specializations.find((item) => item.key === specialization);
    const selectedRole = specializationItem || domainItem;
    const roleLabel = [selectedRole?.label || "US technology hiring", state, career ? career.replaceAll("_", " ") : ""]
      .filter(Boolean).map((item) => item.replace(/^\w/, (letter) => letter.toUpperCase())).join(" · ");
    const cohortKey = specialization
      ? `specialization:${specialization}`
      : domain
        ? `domain:${domain}`
        : "all";
    const sliceKey = `${cohortKey}|state:${state || "all"}|career:${career || "all"}`;
    const scoped = Boolean(state || career);
    const cohortAvailable = !scoped || Boolean(payload.cohort_slices?.[sliceKey]);
    const cohort = scoped
      ? payload.cohort_slices?.[sliceKey] || {}
      : payload.cohorts?.[cohortKey] || {};
    const hasFilters = Boolean(domain || specialization || state || career);
    const daily = scoped && !cohortAvailable ? [] : selectedRole?.daily || payload.daily_demand;
    const pulseLabel = selectedRole?.label || "US technology hiring";
    const pulseNote = !cohortAvailable
      ? "No published time series for this filter combination"
      : scoped
      ? `Role-level trend · not narrowed by selected ${[state ? "state" : "", career ? "experience" : ""].filter(Boolean).join(" or ")}`
      : selectedRole ? "Selected role-level trend" : "Overall tracked trend";
    const skillDomain = specializationItem?.domain || domain || "all";
    const availableSkills = cohort.skills?.length
      ? cohort.skills
      : scoped ? [] : payload.skills.filter((item) => item.domain === skillDomain);
    const skills = availableSkills.filter((item) => skillCategory === "technical"
      ? TECHNICAL_SKILL_CATEGORIES.has(item.category)
      : !skillCategory || item.category === skillCategory);
    const peerRoles = scoped
      ? []
      : domain || specialization
      ? payload.roles.specializations.filter((item) => item.domain === skillDomain)
      : payload.roles.domains;
    const salarySpecialization = payload.salary.specializations.filter((item) => item.key === specialization);
    const salaryDomain = payload.salary.domains.filter((item) => item.key === domain);
    const salaryItems = scoped
      ? cohort.salary || []
      : selectedRole && cohort.salary?.length
      ? cohort.salary
      : specialization ? salarySpecialization : domain ? salaryDomain : payload.salary.domains.filter((item) => item.key !== "uncategorized");
    return { domain, specialization, state, career, skillCategory, domainItem, specializationItem, selectedRole, roleLabel, pulseLabel, pulseNote, daily, skills, peerRoles, salaryItems, cohort, cohortAvailable, scoped, hasFilters };
  }

  function salaryForBrief(context) {
    if (!context.cohortAvailable) return null;
    if (!context.hasFilters) return payload.salary.overall?.[0] || null;
    if (context.specialization) return payload.salary.specializations.find((item) => item.key === context.specialization) || null;
    if (context.domain && !context.scoped) return payload.salary.domains.find((item) => item.key === context.domain) || null;
    const rows = context.salaryItems || [];
    if (context.career) return rows.find((item) => item.key === context.career) || rows[0] || null;
    return [...rows].sort((left, right) => number(right.sample_size) - number(left.sample_size))[0] || null;
  }

  function salaryBriefLabel(context, salary) {
    if (!salary) return "Salary coverage";
    if (!context.hasFilters) return "Across all tracked postings";
    if (context.selectedRole && !context.scoped) return context.roleLabel;
    return `${humanLabel(salary.label)} cohort in this view`;
  }

  function marketBrief(context, overview) {
    if (!context.cohortAvailable) {
      return `No published aggregate is available for the selected ${context.state ? "state" : "experience"} combination. Clear a filter or choose another option to see the available market evidence.`;
    }
    const topSkill = context.skills[0];
    const cohortCount = context.scoped ? number(context.cohort.count) : number(context.cohort.count || overview.deduplicated_clusters);
    const experience = [...(context.cohort.career_levels || [])]
      .filter((item) => item.key !== "uncategorized")
      .sort((left, right) => number(right.count) - number(left.count))[0];
    const scope = context.hasFilters ? `In tracked ${escapeHtml(context.roleLabel)} postings,` : "In the postings we track,";
    const rolePhrase = experience
      ? `${scope} <strong>${escapeHtml(experience.label)}</strong> is the largest experience group at <strong>${percent(experience.share, 1)}</strong> (${fullCount(experience.count)} of ${fullCount(cohortCount)} observed clusters).`
      : context.scoped
        ? `${scope} this view contains <strong>${fullCount(cohortCount)}</strong> observed clusters; an experience breakdown is not available for this slice.`
      : context.selectedRole
        ? `<strong>${escapeHtml(context.roleLabel)}</strong> accounts for <strong>${percent(context.selectedRole.share, 1)}</strong> of observed classified clusters.`
        : `<strong>${escapeHtml(payload.roles.domains.find((item) => item.key !== "uncategorized")?.label || "Technology roles")}</strong> is the largest classified role family.`;
    const skillPhrase = topSkill ? `<strong>${escapeHtml(topSkill.skill)}</strong> appears in ${percent(topSkill.share, 1)} of matching clusters.` : "Skill coverage is below the reporting floor.";
    const salary = salaryForBrief(context);
    const salaryPhrase = salary
      ? context.hasFilters
        ? `${escapeHtml(salaryBriefLabel(context, salary))} report a median base pay of <strong>${money(salary.p50)}</strong> from ${fullCount(salary.sample_size)} disclosed ranges.`
        : `Across all tracked postings, the reported median base pay is <strong>${money(salary.p50)}</strong> from ${fullCount(salary.sample_size)} disclosed ranges.`
      : "Salary coverage is insufficient for this view.";
    return `${rolePhrase} ${skillPhrase} ${salaryPhrase}`;
  }

  function browseHref(context) {
    const query = context.selectedRole?.label || "software engineer";
    return `./?q=${encodeURIComponent(query)}`;
  }

  function filterSummary(context) {
    const parts = [];
    if (context.selectedRole) parts.push(context.selectedRole.label);
    if (context.state) parts.push(context.state);
    if (context.career) parts.push(humanLabel(context.career));
    return parts.length ? parts.join(" · ") : "All tracked postings";
  }

  function render() {
    if (!payload || payload.status !== "ready") {
      const message = payload?.message || "The 30-day aggregate is still being prepared.";
      freshness.textContent = "Coverage not available yet · aggregate window pending";
      content.innerHTML = `<div class="market-unavailable"><strong>Market coverage is not published yet</strong><p>${escapeHtml(message)}</p></div>`;
      controls.classList.add("hidden");
      root.setAttribute("aria-busy", "false");
      return;
    }

    controls.classList.remove("hidden");
    root.setAttribute("aria-busy", "false");
    const context = selectedContext();
    const overview = payload.overview;
    const coverage = payload.coverage || {};
    const gaps = coverage.missing_dates || [];
    const scopedSalarySamples = context.salaryItems.reduce((sum, item) => sum + number(item.sample_size), 0);
    const salarySamples = context.hasFilters ? scopedSalarySamples : number(overview.salary_samples);
    const salaryCoverage = context.hasFilters
      ? salarySamples / Math.max(number(context.cohort.count), 1)
      : number(overview.salary_coverage);
    const salaryVisibility = salarySamples ? percent(salaryCoverage, 1) : "—";
    const salaryVisibilityNote = salarySamples ? `${fullCount(salarySamples)} usable USD ranges` : "No disclosed ranges in this view";
    const hasLocalityRollup = Object.prototype.hasOwnProperty.call(context.cohort, "localities");
    const localities = hasLocalityRollup
      ? context.cohort.localities || []
      : context.hasFilters ? [] : payload.locations.localities;
    const topCity = localities[0];
    const workModes = context.cohort.work_modes?.length ? context.cohort.work_modes : context.scoped ? [] : payload.locations.work_modes;
    const selectedStateItem = context.state && payload.locations.states?.find((item) => item.key === context.state);
    const selectedCareerItem = context.career && payload.roles.career_levels?.find((item) => item.key === context.career);
    const states = context.cohort.states?.length
      ? context.cohort.states
      : selectedStateItem && context.cohort.count ? [{ ...selectedStateItem, count: context.cohort.count, share: 1 }]
      : context.scoped ? [] : payload.locations.states;
    const careerLevels = context.cohort.career_levels?.length
      ? context.cohort.career_levels
      : selectedCareerItem && context.cohort.count ? [{ ...selectedCareerItem, count: context.cohort.count, share: 1 }]
      : context.scoped ? [] : payload.roles.career_levels;
    const industries = context.cohort.industries?.length ? context.cohort.industries : context.scoped ? [] : payload.roles.industries;
    const allSkillPairs = context.cohort.skill_cooccurrence?.length ? context.cohort.skill_cooccurrence : context.scoped ? [] : payload.skill_cooccurrence;
    const skillPairs = allSkillPairs.filter((item) => context.skillCategory === "technical"
      ? TECHNICAL_SKILL_CATEGORIES.has(item.category_a) && TECHNICAL_SKILL_CATEGORIES.has(item.category_b)
      : !context.skillCategory || item.category_a === context.skillCategory || item.category_b === context.skillCategory);
    const remote = workModes.find((item) => item.key === "remote");
    const workModeTotal = workModes.reduce((sum, item) => sum + number(item.count), 0);
    const roleMapTitleBase = context.domain || context.specialization ? `${context.domainItem?.label || context.roleLabel} specializations` : "Most observed clusters by role family";
    const roleMapTitle = context.scoped ? `${roleMapTitleBase} · unavailable for this slice` : roleMapTitleBase;
    const roleMapNote = context.scoped
      ? "Role breakdown is not published for the selected state/experience slice"
      : "Counts are observed clusters · percentages use the displayed cohort";
    const experienceSalary = context.salaryItems.some((item) => ["internship", "early_career_or_new_grad", "mid_career_or_senior", "managerial"].includes(item.key));
    const salaryPanelNote = experienceSalary
      ? "USD annual base · grouped by experience · median and middle 50%"
      : "USD annual base · grouped by role family · median and middle 50%";
    const qualityNote = gaps.length
      ? `${gaps.length} archive ${gaps.length === 1 ? "day" : "days"} missing · observed counts only`
      : `${coverage.valid_snapshot_days || 0} valid snapshots · observed counts only`;
    freshness.textContent = `Through ${fullDate(payload.as_of_date)} · ${payload.window_days}-day observed window · ${coverage.valid_snapshot_days || 0} valid snapshots · tracked postings only`;
    notice.classList.toggle("hidden", !gaps.length && !coverage.quarantined_snapshot_days);
    notice.textContent = gaps.length
      ? `Coverage note: ${gaps.length} archive ${gaps.length === 1 ? "day is" : "days are"} missing (${gaps.map((date) => shortDate(date)).join(", ")}). Counts are observed, never interpolated; the newest posting dates may still be incomplete.`
      : coverage.quarantined_snapshot_days ? `${coverage.quarantined_snapshot_days} archive snapshot was quarantined by quality checks.` : "";
    const filterSummaryElement = document.getElementById("market-filter-summary");
    if (filterSummaryElement) filterSummaryElement.textContent = filterSummary(context);

    content.innerHTML = `
      <nav class="market-section-nav" aria-label="Market sections">
        <span>Explore this view</span>
        <a href="#market-overview">At a glance</a>
        <a href="#market-pulse">Hiring pulse</a>
        <a href="#market-role-terrain">Roles + skills</a>
        <a href="#market-compensation">Pay</a>
        <a href="#market-geography">Places</a>
        <a href="#market-skill-network">Skill combos</a>
      </nav>

      <section class="market-brief" id="market-overview" aria-label="Market briefing">
        <div class="market-brief-copy">
          <div class="market-brief-eyebrow"><span>30-day market brief</span><i></i><span>${escapeHtml(context.roleLabel)}</span></div>
          <p>${marketBrief(context, overview)}</p>
          <div class="market-brief-links"><a class="market-brief-action" href="${browseHref(context)}">Browse related 7-day roles <span>→</span></a><a href="#market-role-terrain">See the role mix <span>↓</span></a><a href="#market-geography">Find the hotspots <span>↓</span></a></div>
        </div>
        <div class="market-brief-stamp"><b>${escapeHtml(shortDate(payload.as_of_date))}</b><span>AS OF</span><small>${payload.window_days}d window</small></div>
      </section>

      <section class="market-kpis" aria-label="Market overview">
        <div class="market-kpi-primary"><span>Observed job clusters</span><strong>${fullCount(context.scoped ? context.cohort.count || 0 : context.cohort.count ?? overview.deduplicated_clusters)}</strong><small>rolling 30-day observations · not an open-role count</small></div>
        <div class="market-kpi-pay"><span>Salary visibility</span><strong>${salaryVisibility}</strong><small>${salaryVisibilityNote}</small></div>
        <div class="market-kpi-remote"><span>Remote signal</span><strong>${workModeTotal ? percent(number(remote?.count) / workModeTotal, 1) : "—"}</strong><small>${workModeTotal ? "explicitly remote clusters" : "work-mode data unavailable"}</small></div>
        <div class="market-kpi-city"><span>${context.hasFilters ? "Top city in this view" : "Largest city pulse"}</span><strong>${escapeHtml(topCity?.label?.replace(/, [A-Za-z]{2}$/, "") || "—")}</strong><small>${topCity ? `${fullCount(topCity.count)} observed clusters` : "No city aggregate for this view"}</small></div>
      </section>

      <section class="market-quality-strip" aria-label="Data quality">
        <div class="market-quality-label"><span>Data coverage · full sample</span><b>Know what you’re seeing</b></div>
        <div><strong>${percent(overview.duplicate_rate, 1)}</strong><span>duplicate listings removed</span></div>
        <div><strong>${percent(overview.taxonomy_coverage, 1)}</strong><span>taxonomy coverage · not accuracy</span></div>
        <div><strong>${coverage.valid_snapshot_days || 0}</strong><span>valid daily snapshots</span></div>
        <p>${escapeHtml(qualityNote)}</p>
      </section>

      <section class="market-card market-card-dark market-card-wide market-card-pulse" id="market-pulse">
        ${panelHeader("01 · Hiring pulse", `${context.pulseLabel}: observed job clusters over the last 30 days`, `${context.pulseNote} · shaded = weekend · gaps marked`)}
        ${pulseChart(context.daily, context.pulseLabel, gaps)}
      </section>

      <div class="market-story-grid" id="market-role-terrain">
        <section class="market-card market-card-role">
          ${panelHeader("02 · Role mix", roleMapTitle, roleMapNote)}
          ${roleMap(context.peerRoles, context.specialization || context.domain, context.domain || context.specialization ? "specialization" : "domain", context.domain || context.specialization ? "Share within this focus" : "Share of classified clusters")}
        </section>
        <section class="market-card market-card-skills">
          ${panelHeader("03 · Skill demand", "Technical skills mentioned most often", "Mentions in observed clusters · filter by category")}
          <div class="skill-panel-filter"><label for="market-skill-category-filter">Category</label><select id="market-skill-category-filter">${option("technical", "Technical skills", skillCategory === "technical")}${option("", "All skill categories", !skillCategory)}${(payload.skill_categories || []).map((item) => option(item.key, item.label, item.key === skillCategory)).join("")}</select></div>
          ${skillHeatmap(context.skills)}
          <p class="market-caveat">Exact O*NET and project-custom skill matches with curated aliases; categorized for dashboard use.</p>
        </section>
      </div>

      <section class="market-card market-card-wide market-card-salary" id="market-compensation">
        ${panelHeader("04 · Pay", "What can these roles pay?", salaryPanelNote)}
        ${salaryRails(context.salaryItems)}
      </section>

      <div class="market-story-grid market-geography-grid" id="market-geography">
        <section class="market-card market-card-map">
          ${panelHeader("05 · Places", "Where postings are clustering", "Darker states = more observed clusters")}
            ${stateChoropleth(states)}
        </section>
        <section class="market-card market-card-localities">
          ${panelHeader("City pulse", "The biggest local markets", context.hasFilters ? "Top cities in this filtered view" : "Ranked by job clusters")}
          ${localityField(localities, context.hasFilters && !hasLocalityRollup ? "Filtered city data will appear after the next market-data refresh." : undefined)}
        </section>
      </div>

      <div class="market-context-grid" id="market-context">
        <section class="market-card">
          ${panelHeader("Work setup", "How work setup is described", "Remote and hybrid are explicit; the rest may be onsite or unspecified")}
          ${workModeRibbon(workModes)}
        </section>
        <section class="market-card">
          ${panelHeader("Experience mix", "Who employers are hiring")}
          ${careerLadder(careerLevels)}
        </section>
        <section class="market-card market-card-context-wide">
          ${panelHeader("Industry mix", "Where the work is happening")}
          ${industryMosaic(industries)}
        </section>
      </div>

      <section class="market-card market-card-wide market-card-network" id="market-skill-network">
        ${panelHeader("06 · Skill combos", "Technical skills that show up together", "Useful bundles for search and learning")}
        ${skillNetwork(skillPairs, context.cohort.count || overview.deduplicated_clusters)}
      </section>

      <details class="market-methodology">
        <summary>About this data</summary>
        <div class="market-methodology-grid">
          <div><span>Window and scope</span><p>Deduplicated job clusters observed over a rolling ${payload.window_days}-day window in the tracked US technology-posting sample. The seven-day job board and this 30-day market view are different datasets.</p></div>
          <div><span>Classification</span><p>Role families and skills use the validated public-board taxonomy and curated aliases.</p></div>
          <div><span>Pay</span><p>USD annualized base pay; total compensation is excluded. Salary rows show sample size; subgroup medians should not be averaged.</p></div>
          <div><span>Coverage</span><p>${coverage.valid_snapshot_days || 0} valid daily snapshots. Missing dates are shown in the coverage note and marked on the hiring-pulse chart.</p></div>
        </div>
      </details>`;
    if (window.location.hash.startsWith("#market-")) {
      window.requestAnimationFrame(() => document.querySelector(window.location.hash)?.scrollIntoView());
    }
  }

  function populateFilters() {
    domainFilter.innerHTML = option("", "All focus areas") + payload.roles.domains.filter((item) => item.key !== "uncategorized").map((item) => option(item.key, item.label)).join("");
    populateSpecializations();
    stateFilter.innerHTML = option("", "All states") + (payload.locations.states || []).map((item) => option(item.key, item.label || item.key)).join("");
    careerFilter.innerHTML = option("", "All experience buckets") + (payload.roles.career_levels || []).map((item) => option(item.key, item.label)).join("");
  }

  function populateSpecializations() {
    const selected = specializationFilter.value;
    const available = payload.roles.specializations.filter(
      (item) => item.key !== "uncategorized" && (!domainFilter.value || item.domain === domainFilter.value)
    );
    specializationFilter.innerHTML = option("", "All specializations") + available.map((item) => option(item.key, item.label)).join("");
    specializationFilter.value = available.some((item) => item.key === selected) ? selected : "";
  }

  async function load() {
    if (loaded || loading) return;
    loading = true;
    root.setAttribute("aria-busy", "true");
    freshness.textContent = "Loading 30-day aggregate · coverage will appear when ready";
    content.innerHTML = loadingMarkup();
    try {
      const response = await fetch(DATA_URL);
      if (!response.ok) throw new Error(`Market data could not be loaded (${response.status}).`);
      payload = await response.json();
      if (payload.status === "ready") populateFilters();
      loaded = true;
      render();
    } catch (error) {
      content.innerHTML = `<div class="market-unavailable"><strong>Market data is unavailable</strong><p>${escapeHtml(error.message)}</p></div>`;
      freshness.textContent = "Unable to load aggregate coverage · try again later";
      root.setAttribute("aria-busy", "false");
    } finally {
      loading = false;
    }
  }

  domainFilter.addEventListener("change", () => { populateSpecializations(); render(); });
  specializationFilter.addEventListener("change", render);
  stateFilter.addEventListener("change", render);
  careerFilter.addEventListener("change", render);
  function activateRoleTile(tile) {
    if (tile.dataset.marketRoleType === "domain") {
      domainFilter.value = tile.dataset.marketRole;
      specializationFilter.value = "";
      populateSpecializations();
    } else {
      specializationFilter.value = tile.dataset.marketRole;
    }
    render();
    root.scrollTo({ top: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }
  content.addEventListener("change", (event) => {
    if (event.target?.id === "market-skill-category-filter") {
      skillCategory = event.target.value;
      render();
    }
  });
  content.addEventListener("click", (event) => {
    const tile = event.target.closest?.("[data-market-role]");
    if (tile) activateRoleTile(tile);
  });
  content.addEventListener("keydown", (event) => {
    const tile = event.target.closest?.("[data-market-role]");
    if (tile && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      activateRoleTile(tile);
    }
  });
  return {
    show() { root.classList.remove("hidden"); load(); },
    hide() { root.classList.add("hidden"); },
  };
}

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

function isWeekend(value) {
  const day = new Date(`${value}T12:00:00`).getDay();
  return day === 0 || day === 6;
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

function pulseChart(points, label) {
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
  const step = (width - left - right) / Math.max(points.length - 1, 1);
  const ticks = [0.25, 0.5, 0.75, 1];

  return `<div class="pulse-wrap">
    <div class="pulse-summary" aria-label="Demand chart summary">
      <span><b>${fullCount(maximum)}</b> peak on ${shortDate(points[peakIndex].date)}</span>
      <span><b>${fullCount(Math.round(weekdayAverage))}</b> average weekday intake</span>
      <span class="pulse-key"><i></i> daily <i></i> 7-day signal</span>
    </div>
    <svg class="market-pulse" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(label)} daily deduplicated demand over 30 days">
      <defs>
        <linearGradient id="pulse-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffc24b" stop-opacity=".48"/><stop offset="1" stop-color="#ffc24b" stop-opacity=".03"/></linearGradient>
        <filter id="pulse-glow"><feGaussianBlur stdDeviation="4" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      </defs>
      ${coordinates.map((point, index) => isWeekend(point.date) ? `<rect class="pulse-weekend" x="${(point.x - step / 2).toFixed(1)}" y="${top}" width="${step.toFixed(1)}" height="${height - top - bottom}"/>` : "").join("")}
      ${ticks.map((tick) => `<g class="pulse-grid"><line x1="${left}" y1="${y(maximum * tick).toFixed(1)}" x2="${width - right}" y2="${y(maximum * tick).toFixed(1)}"/><text x="${left - 8}" y="${(y(maximum * tick) + 3).toFixed(1)}" text-anchor="end">${count(maximum * tick)}</text></g>`).join("")}
      <path class="pulse-area" d="${area}"/>
      <path class="pulse-line" d="${line}"/>
      <path class="pulse-average" d="${averageLine}"/>
      ${coordinates.map((point, index) => `<circle class="pulse-point${index >= coordinates.length - 2 ? " is-latest" : ""}" cx="${point.x}" cy="${point.y}" r="4"><title>${escapeHtml(shortDate(point.date))}: ${fullCount(point.count)} postings</title></circle>`).join("")}
      ${coordinates.filter((_, index) => index === 0 || index === coordinates.length - 1 || index % 7 === 0).map((point) => `<text class="pulse-date" x="${point.x}" y="${height - 12}" text-anchor="middle">${escapeHtml(shortDate(point.date))}</text>`).join("")}
    </svg>
  </div>`;
}

function splitTreemap(items, x, y, width, height, depth = 0) {
  if (!items.length) return [];
  if (items.length === 1) return [{ ...items[0], x, y, width, height, depth }];
  const total = items.reduce((sum, item) => sum + number(item.count), 0);
  let running = 0;
  let split = 1;
  for (; split < items.length; split += 1) {
    running += number(items[split - 1].count);
    if (running >= total / 2) break;
  }
  const first = items.slice(0, split);
  const second = items.slice(split);
  const ratio = first.reduce((sum, item) => sum + number(item.count), 0) / Math.max(total, 1);
  const horizontal = width >= height;
  if (horizontal) {
    const firstWidth = width * ratio;
    return [...splitTreemap(first, x, y, firstWidth, height, depth + 1), ...splitTreemap(second, x + firstWidth, y, width - firstWidth, height, depth + 1)];
  }
  const firstHeight = height * ratio;
  return [...splitTreemap(first, x, y, width, firstHeight, depth + 1), ...splitTreemap(second, x, y + firstHeight, width, height - firstHeight, depth + 1)];
}

function roleMap(items, activeKey = "", itemType = "domain") {
  const visible = (items || []).filter((item) => item.key !== "uncategorized").slice(0, 18);
  if (!visible.length) return '<p class="market-empty">No role groups meet the reporting threshold.</p>';
  const width = 900;
  const height = 430;
  const layouts = splitTreemap(visible, 0, 0, width, height);
  return `<svg class="role-map" viewBox="0 0 ${width} ${height}" role="img" aria-label="Proportional role map; tile area represents deduplicated job demand">
    ${layouts.map((item, index) => {
      const inset = 3;
      const tileWidth = Math.max(0, item.width - inset * 2);
      const tileHeight = Math.max(0, item.height - inset * 2);
      const showLabel = tileWidth > 82 && tileHeight > 42;
      const showDetail = tileWidth > 115 && tileHeight > 72;
      const selected = activeKey && item.key === activeKey;
      return `<g class="role-tile tone-${index % 7}${selected ? " is-selected" : ""}" role="button" tabindex="0" data-market-role="${escapeHtml(item.key)}" data-market-role-type="${itemType}" aria-label="Filter to ${escapeHtml(item.label)}, ${fullCount(item.count)} jobs">
        <rect x="${(item.x + inset).toFixed(1)}" y="${(item.y + inset).toFixed(1)}" width="${tileWidth.toFixed(1)}" height="${tileHeight.toFixed(1)}" rx="8"><title>${escapeHtml(item.label)}: ${fullCount(item.count)} jobs, ${percent(item.share, 1)} of the market</title></rect>
        ${showLabel ? `<text class="role-tile-label" x="${(item.x + 14).toFixed(1)}" y="${(item.y + 24).toFixed(1)}">${escapeHtml(item.label.length > Math.max(10, tileWidth / 8) ? `${item.label.slice(0, Math.max(8, Math.floor(tileWidth / 8)))}…` : item.label)}</text>` : ""}
        ${showDetail ? `<text class="role-tile-count" x="${(item.x + 14).toFixed(1)}" y="${(item.y + 48).toFixed(1)}">${count(item.count)} · ${percent(item.share)}</text>` : ""}
      </g>`;
    }).join("")}
  </svg>`;
}

function fourWeekBuckets(daily) {
  const points = (daily || []).slice(-28);
  return [0, 1, 2, 3].map((week) => {
    const group = points.slice(week * 7, week * 7 + 7);
    return {
      value: group.reduce((sum, point) => sum + number(point.count), 0),
      label: group.length ? `${shortDate(group[0].date)}–${shortDate(group.at(-1).date)}` : `Week ${week + 1}`,
    };
  });
}

function skillHeatmap(items) {
  const visible = (items || []).slice(0, 14).map((item) => ({ ...item, weeks: fourWeekBuckets(item.daily) }));
  if (!visible.length) return '<p class="market-empty">No skills meet the reporting threshold for this focus area.</p>';
  const maximum = Math.max(...visible.flatMap((item) => item.weeks.map((week) => week.value)), 1);
  const weekLabels = visible[0].weeks.map((week) => week.label);
  return `<div class="skill-matrix" role="table" aria-label="Top skills by weekly job demand">
    <div class="skill-matrix-head" role="row"><span role="columnheader">Skill signal</span>${weekLabels.map((label) => `<span role="columnheader">${escapeHtml(label)}</span>`).join("")}<span role="columnheader">30d</span></div>
    ${visible.map((item) => `<div class="skill-matrix-row" role="row">
      <span class="skill-name" role="cell"><b>${escapeHtml(item.skill)}</b><small>${percent(item.share, 1)} of jobs</small></span>
      ${item.weeks.map((week) => {
        const strength = Math.sqrt(week.value / maximum);
        return `<span class="skill-heat" role="cell" style="--heat:${strength.toFixed(3)}"><i></i><em>${count(week.value)}</em><span class="sr-only">${escapeHtml(item.skill)}, ${escapeHtml(week.label)}: ${fullCount(week.value)} jobs</span></span>`;
      }).join("")}
      <strong role="cell">${count(item.count)}</strong>
    </div>`).join("")}
  </div>`;
}

function salaryRails(items) {
  const visible = (items || []).filter((item) => item.p25 != null && item.p50 != null && item.p75 != null).slice(0, 10);
  if (!visible.length) return '<p class="market-empty">Not enough disclosed salaries meet the USD annual-base policy.</p>';
  const floor = Math.floor(Math.min(...visible.map((item) => number(item.p25))) / 25000) * 25000;
  const ceiling = Math.ceil(Math.max(...visible.map((item) => number(item.p75))) / 25000) * 25000;
  const span = Math.max(ceiling - floor, 1);
  const position = (value) => Math.max(0, Math.min(100, ((number(value) - floor) / span) * 100));
  return `<div class="salary-rails">
    <div class="salary-axis"><span>${money(floor)}</span><span>${money(floor + span / 2)}</span><span>${money(ceiling)}</span></div>
    ${visible.map((item) => `<div class="salary-rail-row">
      <div><b>${escapeHtml(item.label)}</b><small>n=${fullCount(item.sample_size)}</small></div>
      <div class="salary-track" role="img" aria-label="${escapeHtml(item.label)} salary: ${money(item.p25)} at P25, ${money(item.p50)} median, ${money(item.p75)} at P75; ${fullCount(item.sample_size)} observations">
        <i style="left:${position(item.p25).toFixed(1)}%;width:${Math.max(1, position(item.p75) - position(item.p25)).toFixed(1)}%"></i>
        <b style="left:${position(item.p50).toFixed(1)}%"><span>${money(item.p50)}</span></b>
      </div>
    </div>`).join("")}
    <div class="salary-legend"><span><i></i>P25–P75 range</span><span><i></i>median</span></div>
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
    <svg class="us-state-map" viewBox="0 0 1050 620" role="img" aria-label="United States choropleth map; darker states have more deduplicated technology job demand">
      <g class="map-insets" aria-hidden="true"><rect x="10" y="414" width="270" height="194" rx="8"/><text x="24" y="436">ALASKA</text><rect x="294" y="516" width="220" height="91" rx="8"/><text x="308" y="538">HAWAII</text></g>
      <g class="map-states">
        ${US_STATE_PATHS.map((state) => {
          const item = byState.get(state.id);
          const strength = item ? Math.sqrt(number(item.count) / maximum) : 0;
          const opacity = item ? 0.16 + strength * 0.84 : 0;
          return `<path class="us-state-shape${item ? " has-data" : ""}" data-state="${state.id}" d="${state.d}" style="--heat:${strength.toFixed(3)};fill:rgba(255,194,75,${opacity.toFixed(3)})"><title>${escapeHtml(state.name)}: ${item ? `${fullCount(item.count)} jobs (${percent(item.share, 1)})` : "below the public reporting threshold"}</title></path>`;
        }).join("")}
      </g>
      <g class="map-state-labels" aria-hidden="true">${US_STATE_PATHS.filter((state) => leaderKeys.has(state.id)).map((state) => {
        const [x, y] = pathCenter(state.d);
        return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}">${state.id}</text>`;
      }).join("")}</g>
    </svg>
    <div class="map-scale" aria-hidden="true"><span>Lower signal</span><i></i><span>Higher signal</span></div>
    <div class="map-leaders" aria-label="States with the most deduplicated jobs">${leaders.map((item, index) => `<span><i>${String(index + 1).padStart(2, "0")}</i><b>${escapeHtml(String(item.key).toUpperCase())}</b><em>${fullCount(item.count)}</em></span>`).join("")}</div>
  </div>`;
}

function localityField(items) {
  const visible = (items || []).slice(0, 12);
  if (!visible.length) return "";
  const maximum = Math.max(...visible.map((item) => number(item.count)), 1);
  return `<div class="locality-field" aria-label="Leading city markets">${visible.map((item, index) => {
    const size = 46 + Math.sqrt(number(item.count) / maximum) * 62;
    return `<span class="locality-orb tone-${index % 7}" style="--orb:${size.toFixed(0)}px" title="${escapeHtml(item.label)}: ${fullCount(item.count)} jobs"><b>${escapeHtml(item.label.replace(/, [A-Za-z]{2}$/, ""))}</b><small>${count(item.count)}</small></span>`;
  }).join("")}</div>`;
}

function workModeRibbon(items) {
  const total = (items || []).reduce((sum, item) => sum + number(item.count), 0);
  if (!total) return '<p class="market-empty">Work-mode data is unavailable.</p>';
  return `<div class="mode-ribbon" role="img" aria-label="Work mode composition">
    <div>${items.map((item, index) => `<i class="tone-${index}" style="width:${(number(item.count) / total * 100).toFixed(2)}%"><span>${number(item.count) / total > 0.08 ? escapeHtml(item.label) : ""}</span></i>`).join("")}</div>
    <ul>${items.map((item, index) => `<li><i class="tone-${index}"></i><span>${escapeHtml(item.label)}</span><b>${percent(number(item.count) / total, 1)}</b><small>${fullCount(item.count)} jobs</small></li>`).join("")}</ul>
  </div>`;
}

function careerLadder(items) {
  const rank = new Map([["internship", 0], ["early_career_or_new_grad", 1], ["mid_career_or_senior", 2], ["managerial", 3]]);
  const visible = [...(items || [])].sort((left, right) => (rank.get(left.key) ?? 99) - (rank.get(right.key) ?? 99));
  const maximum = Math.max(...visible.map((item) => number(item.count)), 1);
  return `<div class="career-ladder" aria-label="Demand by career level">${visible.map((item, index) => `<div style="--ladder:${Math.max(26, number(item.count) / maximum * 100).toFixed(1)}%"><span>${String(index + 1).padStart(2, "0")}</span><i><b>${escapeHtml(item.label)}</b><small>${fullCount(item.count)} · ${percent(item.share, 1)}</small></i></div>`).join("")}</div>`;
}

function industryMosaic(items) {
  const visible = (items || []).slice(0, 10);
  const total = visible.reduce((sum, item) => sum + number(item.count), 0);
  return `<div class="industry-mosaic">${visible.map((item, index) => `<span class="tone-${index % 7}" style="--weight:${Math.max(1, Math.round(number(item.count) / Math.max(total, 1) * 40))}" title="${escapeHtml(item.label)}: ${fullCount(item.count)} jobs"><b>${escapeHtml(item.label)}</b><small>${percent(item.share, 1)}</small></span>`).join("")}</div>`;
}

function skillNetwork(pairs) {
  const visiblePairs = (pairs || []).slice(0, 45);
  if (!visiblePairs.length) return '<p class="market-empty">No skill pairs meet the reporting threshold.</p>';
  const degree = new Map();
  visiblePairs.forEach((pair) => {
    degree.set(pair.skill_a, (degree.get(pair.skill_a) || 0) + number(pair.count));
    degree.set(pair.skill_b, (degree.get(pair.skill_b) || 0) + number(pair.count));
  });
  const nodes = [...degree.entries()].sort((a, b) => b[1] - a[1]).slice(0, 13);
  const nodeNames = new Set(nodes.map(([name]) => name));
  const edges = visiblePairs.filter((pair) => nodeNames.has(pair.skill_a) && nodeNames.has(pair.skill_b));
  const width = 900;
  const height = 520;
  const centerX = width / 2;
  const centerY = height / 2;
  const radius = 185;
  const maxDegree = Math.max(...nodes.map(([, value]) => value), 1);
  const maxEdge = Math.max(...edges.map((edge) => number(edge.count)), 1);
  const positions = new Map(nodes.map(([name, value], index) => {
    const angle = -Math.PI / 2 + index / nodes.length * Math.PI * 2;
    return [name, { name, value, angle, x: centerX + Math.cos(angle) * radius, y: centerY + Math.sin(angle) * radius }];
  }));
  return `<div class="skill-network-wrap">
    <svg class="skill-network" viewBox="0 0 ${width} ${height}" role="img" aria-label="Network of frequently co-occurring skills; node size is connected demand and line strength is pair frequency">
      <circle class="network-orbit" cx="${centerX}" cy="${centerY}" r="${radius}"/>
      ${edges.map((edge) => {
        const from = positions.get(edge.skill_a);
        const to = positions.get(edge.skill_b);
        const strength = number(edge.count) / maxEdge;
        return `<path class="network-edge" d="M${from.x.toFixed(1)},${from.y.toFixed(1)} Q${centerX},${centerY} ${to.x.toFixed(1)},${to.y.toFixed(1)}" style="--edge:${strength.toFixed(3)}"><title>${escapeHtml(edge.skill_a)} + ${escapeHtml(edge.skill_b)}: ${fullCount(edge.count)} jobs</title></path>`;
      }).join("")}
      ${nodes.map(([name, value], index) => {
        const point = positions.get(name);
        const nodeRadius = 7 + Math.sqrt(value / maxDegree) * 13;
        const outward = 28;
        const labelX = point.x + Math.cos(point.angle) * outward;
        const labelY = point.y + Math.sin(point.angle) * outward;
        const anchor = Math.cos(point.angle) > 0.2 ? "start" : Math.cos(point.angle) < -0.2 ? "end" : "middle";
        return `<g class="network-node tone-${index % 7}"><circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="${nodeRadius.toFixed(1)}"><title>${escapeHtml(name)}: ${fullCount(value)} weighted connections</title></circle><text x="${labelX.toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="${anchor}">${escapeHtml(name)}</text></g>`;
      }).join("")}
      <g class="network-core"><circle cx="${centerX}" cy="${centerY}" r="42"/><text x="${centerX}" y="${centerY - 3}" text-anchor="middle">SKILL</text><text x="${centerX}" y="${centerY + 14}" text-anchor="middle">ECOSYSTEM</text></g>
    </svg>
    <div class="pair-ledger">${visiblePairs.slice(0, 6).map((pair, index) => `<span><i>${String(index + 1).padStart(2, "0")}</i><b>${escapeHtml(pair.skill_a)}</b><em>×</em><b>${escapeHtml(pair.skill_b)}</b><small>${fullCount(pair.count)}</small></span>`).join("")}</div>
  </div>`;
}

function option(value, label) {
  return `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`;
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
  const controls = document.getElementById("market-controls");
  let payload = null;
  let loading = false;
  let loaded = false;

  function selectedContext() {
    const domain = domainFilter.value;
    const specialization = specializationFilter.value;
    const domainItem = payload.roles.domains.find((item) => item.key === domain);
    const specializationItem = payload.roles.specializations.find((item) => item.key === specialization);
    const selectedRole = specializationItem || domainItem;
    const roleLabel = selectedRole?.label || "US technology hiring";
    const daily = selectedRole?.daily || payload.daily_demand;
    const skillDomain = domain || specializationItem?.domain || "all";
    const skills = payload.skills.filter((item) => item.domain === skillDomain);
    const peerRoles = domain || specialization
      ? payload.roles.specializations.filter((item) => item.domain === skillDomain)
      : payload.roles.domains;
    const salarySpecialization = payload.salary.specializations.filter((item) => item.key === specialization);
    const salaryDomain = payload.salary.domains.filter((item) => item.key === domain);
    const salaryItems = specialization ? salarySpecialization : domain ? salaryDomain : payload.salary.domains.filter((item) => item.key !== "uncategorized");
    return { domain, specialization, domainItem, specializationItem, selectedRole, roleLabel, daily, skills, peerRoles, salaryItems };
  }

  function marketBrief(context) {
    const topSkill = context.skills[0];
    const salary = context.selectedRole ? context.salaryItems[0] : payload.salary.overall[0];
    const rolePhrase = context.selectedRole
      ? `<strong>${escapeHtml(context.roleLabel)}</strong> accounts for <strong>${percent(context.selectedRole.share, 1)}</strong> of observed demand.`
      : `<strong>${escapeHtml(payload.roles.domains.find((item) => item.key !== "uncategorized")?.label || "Technology roles")}</strong> is the largest classified hiring field.`;
    const skillPhrase = topSkill ? `<strong>${escapeHtml(topSkill.skill)}</strong> appears in ${percent(topSkill.share, 1)} of matching clusters.` : "Skill coverage is below the reporting floor.";
    const salaryPhrase = salary ? `Reported median base pay is <strong>${money(salary.p50)}</strong> from ${fullCount(salary.sample_size)} disclosed ranges.` : "Salary coverage is insufficient.";
    return `${rolePhrase} ${skillPhrase} ${salaryPhrase}`;
  }

  function render() {
    if (!payload || payload.status !== "ready") {
      const message = payload?.message || "The first production Spark backfill has not completed.";
      freshness.textContent = message;
      content.innerHTML = `<div class="market-unavailable"><strong>Market data is not available yet</strong><p>${escapeHtml(message)}</p></div>`;
      controls.classList.add("hidden");
      return;
    }

    controls.classList.remove("hidden");
    const context = selectedContext();
    const overview = payload.overview;
    const coverage = payload.coverage || {};
    const gaps = coverage.missing_dates || [];
    const topCity = payload.locations.localities?.[0];
    const remote = payload.locations.work_modes.find((item) => item.key === "remote");
    const workModeTotal = payload.locations.work_modes.reduce((sum, item) => sum + number(item.count), 0);
    const roleMapTitle = context.domain || context.specialization ? `${context.domainItem?.label || context.roleLabel} specializations` : "Where the market is concentrated";
    const skillNote = context.specialization ? "Skills shown at focus-area level" : "Weekly persistence, not keyword volume";

    freshness.textContent = `Through ${payload.as_of_date} · rolling ${payload.window_days} days · ${coverage.valid_snapshot_days || 0} valid snapshots`;
    notice.classList.toggle("hidden", !gaps.length && !coverage.quarantined_snapshot_days);
    notice.textContent = gaps.length
      ? `Coverage note: ${gaps.length} archive ${gaps.length === 1 ? "day is" : "days are"} missing. Counts are observed, never interpolated; the newest posting dates may still be incomplete.`
      : coverage.quarantined_snapshot_days ? `${coverage.quarantined_snapshot_days} archive snapshot was quarantined by quality checks.` : "";

    content.innerHTML = `
      <section class="market-brief" aria-label="Market briefing">
        <div class="market-brief-copy"><span>30-day market brief · ${escapeHtml(context.roleLabel)}</span><p>${marketBrief(context)}</p></div>
        <div class="market-brief-stamp"><b>${escapeHtml(payload.as_of_date.slice(5).replace("-", "."))}</b><span>AS OF</span></div>
      </section>

      <section class="market-kpis" aria-label="Market overview">
        <div class="market-kpi-primary"><span>Visible opportunities</span><strong>${fullCount(overview.deduplicated_clusters)}</strong><small>unique job clusters · rolling 30 days</small></div>
        <div><span>Signal cleaned</span><strong>${percent(overview.duplicate_rate, 1)}</strong><small>${fullCount(overview.duplicate_members)} duplicate listings removed</small></div>
        <div><span>Taxonomy coverage</span><strong>${percent(overview.taxonomy_coverage, 1)}</strong><small>classified into Qwen role families</small></div>
        <div><span>Salary visibility</span><strong>${percent(overview.salary_coverage, 1)}</strong><small>${fullCount(overview.salary_samples)} usable USD ranges</small></div>
        <div><span>Remote signal</span><strong>${percent(number(remote?.count) / Math.max(workModeTotal, 1), 1)}</strong><small>explicitly remote listings</small></div>
        <div><span>Largest city pulse</span><strong>${escapeHtml(topCity?.label?.replace(/, [A-Za-z]{2}$/, "") || "—")}</strong><small>${fullCount(topCity?.count)} deduplicated jobs</small></div>
      </section>

      <section class="market-card market-card-dark market-card-wide">
        ${panelHeader("Hiring pulse", `${context.roleLabel}: observed posting rhythm`, "Faint columns mark weekends · last dates may be partial")}
        ${pulseChart(context.daily, context.roleLabel)}
      </section>

      <div class="market-story-grid" id="market-role-terrain">
        <section class="market-card market-card-role">
          ${panelHeader("Role terrain", roleMapTitle, "Area = share of deduplicated demand")}
          ${roleMap(context.peerRoles, context.specialization || context.domain, context.domain || context.specialization ? "specialization" : "domain")}
        </section>
        <section class="market-card market-card-skills">
          ${panelHeader("Skill persistence", "What employers repeatedly ask for", skillNote)}
          ${skillHeatmap(context.skills)}
          <p class="market-caveat">Exact O*NET and project-custom skill matches with curated aliases.</p>
        </section>
      </div>

      <section class="market-card market-card-wide market-card-salary" id="market-compensation">
        ${panelHeader("Compensation signal", "The salary corridor", "USD annual base · median dot inside P25–P75 range")}
        ${salaryRails(context.salaryItems)}
      </section>

      <div class="market-story-grid market-geography-grid" id="market-geography">
        <section class="market-card market-card-map">
          ${panelHeader("Geographic gravity", "Where opportunity accumulates", "Color intensity = 30-day demand")}
          ${stateChoropleth(payload.locations.states)}
        </section>
        <section class="market-card market-card-localities">
          ${panelHeader("City field", "Leading local hiring centers", "Orb size = job clusters")}
          ${localityField(payload.locations.localities)}
        </section>
      </div>

      <div class="market-context-grid">
        <section class="market-card">
          ${panelHeader("Workplace shape", "Where work happens")}
          ${workModeRibbon(payload.locations.work_modes)}
        </section>
        <section class="market-card">
          ${panelHeader("Career ladder", "Who the market is hiring")}
          ${careerLadder(payload.roles.career_levels)}
        </section>
        <section class="market-card market-card-context-wide">
          ${panelHeader("Industry exposure", "The contexts shaping demand")}
          ${industryMosaic(payload.roles.industries)}
        </section>
      </div>

      <section class="market-card market-card-wide market-card-network" id="market-skill-network">
        ${panelHeader("Skill ecosystem", "Technologies that travel together", "Top public pairs · each pair counted once per cluster")}
        ${skillNetwork(payload.skill_cooccurrence)}
      </section>

      <footer class="market-methodology">
        <div><span>How to read this</span><p>Counts represent deduplicated job clusters in a rolling ${payload.window_days}-day window. Daily values are posting-date observations, so weekends and the newest dates naturally run lower.</p></div>
        <div><span>Classification</span><p>Validated Qwen primary taxonomy path · O*NET and project-custom skill aliases · cohorts below ${payload.methodology.minimum_group_size} jobs suppressed.</p></div>
        <div><span>Compensation</span><p>USD annualized salary; base or unspecified scope included, total compensation excluded. Salary charts always show their sample size.</p></div>
        <div><span>Deduplication</span><p>Exact identity plus MinHash similarity ≥ ${payload.methodology.duplicate_similarity}; one posting cluster contributes one count.</p></div>
      </footer>`;
    if (window.location.hash.startsWith("#market-")) {
      window.requestAnimationFrame(() => document.querySelector(window.location.hash)?.scrollIntoView());
    }
  }

  function populateFilters() {
    domainFilter.innerHTML = option("", "All focus areas") + payload.roles.domains.filter((item) => item.key !== "uncategorized").map((item) => option(item.key, item.label)).join("");
    populateSpecializations();
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
    content.innerHTML = '<div class="market-loading"><i></i><strong>Reading the market</strong><span>Loading aggregate hiring signals…</span></div>';
    try {
      const response = await fetch(DATA_URL);
      if (!response.ok) throw new Error(`Market data could not be loaded (${response.status}).`);
      payload = await response.json();
      if (payload.status === "ready") populateFilters();
      loaded = true;
      render();
    } catch (error) {
      content.innerHTML = `<div class="market-unavailable"><strong>Market data is unavailable</strong><p>${escapeHtml(error.message)}</p></div>`;
      freshness.textContent = "Unable to load the aggregate dataset.";
    } finally {
      loading = false;
    }
  }

  domainFilter.addEventListener("change", () => { populateSpecializations(); render(); });
  specializationFilter.addEventListener("change", render);
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

const DATA_URL = "./data/market_analysis.json";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function count(value) {
  return new Intl.NumberFormat("en-US").format(Number(value) || 0);
}

function money(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", maximumFractionDigits: 0,
  }).format(Number(value) || 0);
}

function lineChart(points) {
  if (!points?.length) return '<p class="market-empty">No daily observations are available.</p>';
  const width = 760;
  const height = 210;
  const padding = 28;
  const maximum = Math.max(...points.map((point) => Number(point.count) || 0), 1);
  const coordinates = points.map((point, index) => {
    const x = padding + (index / Math.max(points.length - 1, 1)) * (width - padding * 2);
    const y = height - padding - ((Number(point.count) || 0) / maximum) * (height - padding * 2);
    return { ...point, x, y };
  });
  const path = coordinates.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  const first = coordinates[0];
  const last = coordinates.at(-1);
  return `<svg class="market-line-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Daily deduplicated job demand over 30 days">
    <path class="market-gridline" d="M${padding},${height - padding}H${width - padding}" />
    <path class="market-trend-line" d="${path}" />
    ${coordinates.map((point) => `<circle cx="${point.x}" cy="${point.y}" r="3"><title>${escapeHtml(point.date)}: ${count(point.count)} jobs</title></circle>`).join("")}
    <text x="${padding}" y="${height - 6}">${escapeHtml(first.date.slice(5))}</text>
    <text x="${width - padding}" y="${height - 6}" text-anchor="end">${escapeHtml(last.date.slice(5))}</text>
    <text x="${padding}" y="18">${count(maximum)}</text>
  </svg>`;
}

function bars(items, empty = "No groups meet the reporting threshold.") {
  if (!items?.length) return `<p class="market-empty">${escapeHtml(empty)}</p>`;
  const maximum = Math.max(...items.map((item) => Number(item.count) || 0), 1);
  return `<div class="market-bars">${items.slice(0, 12).map((item) => `
    <div class="market-bar-row">
      <span title="${escapeHtml(item.label)}">${escapeHtml(item.label)}</span>
      <div><i style="width:${Math.max(2, (Number(item.count) / maximum) * 100).toFixed(1)}%"></i></div>
      <strong>${count(item.count)}</strong>
    </div>`).join("")}</div>`;
}

function salaryPanel(items) {
  if (!items?.length) return '<p class="market-empty">Not enough disclosed salaries meet the USD base-salary policy.</p>';
  const floor = Math.min(...items.map((item) => Number(item.p25) || 0));
  const ceiling = Math.max(...items.map((item) => Number(item.p75) || 0), floor + 1);
  const position = (value) => Math.max(0, Math.min(100, ((Number(value) - floor) / (ceiling - floor)) * 100));
  return `<div class="salary-list">${items.slice(0, 8).map((item) => `
    <div class="salary-row">
      <div><strong>${escapeHtml(item.label)}</strong><small>${count(item.sample_size)} salaries</small></div>
      <div class="salary-visual">
        <div class="salary-plot" role="img" aria-label="${escapeHtml(item.label)} salary: ${money(item.p25)} at the 25th percentile, ${money(item.p50)} median, ${money(item.p75)} at the 75th percentile">
          <i style="left:${position(item.p25).toFixed(1)}%;width:${Math.max(1, position(item.p75) - position(item.p25)).toFixed(1)}%"></i>
          <b style="left:${position(item.p50).toFixed(1)}%"></b>
        </div>
        <div class="salary-range"><span>${money(item.p25)}</span><b>${money(item.p50)}</b><span>${money(item.p75)}</span></div>
      </div>
    </div>`).join("")}</div>`;
}

function skillTable(items) {
  if (!items?.length) return '<p class="market-empty">No skills meet the reporting threshold for this focus area.</p>';
  return `<div class="market-table-wrap"><table class="market-table">
    <thead><tr><th>Skill</th><th>Jobs</th><th>Share</th></tr></thead>
    <tbody>${items.slice(0, 20).map((item) => `<tr><td>${escapeHtml(item.skill)}</td><td>${count(item.count)}</td><td>${Math.round(Number(item.share) * 100)}%</td></tr>`).join("")}</tbody>
  </table></div>`;
}

function pairTable(items) {
  if (!items?.length) return '<p class="market-empty">No skill pairs meet the reporting threshold.</p>';
  return `<div class="market-table-wrap"><table class="market-table">
    <thead><tr><th>Skills seen together</th><th>Jobs</th></tr></thead>
    <tbody>${items.slice(0, 15).map((item) => `<tr><td>${escapeHtml(item.skill_a)} + ${escapeHtml(item.skill_b)}</td><td>${count(item.count)}</td></tr>`).join("")}</tbody>
  </table></div>`;
}

function option(value, label) {
  return `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`;
}

export function createMarketAnalysis() {
  const root = document.getElementById("market-analysis");
  const content = document.getElementById("market-content");
  const freshness = document.getElementById("market-freshness");
  const notice = document.getElementById("market-notice");
  const domainFilter = document.getElementById("market-domain-filter");
  const specializationFilter = document.getElementById("market-specialization-filter");
  let payload = null;
  let loading = false;
  let loaded = false;

  function render() {
    if (!payload || payload.status !== "ready") {
      const message = payload?.message || "The first production Spark backfill has not completed.";
      freshness.textContent = message;
      content.innerHTML = `<div class="market-unavailable"><strong>Market data is not available yet</strong><p>${escapeHtml(message)}</p></div>`;
      document.getElementById("market-controls").classList.add("hidden");
      return;
    }
    document.getElementById("market-controls").classList.remove("hidden");
    const domain = domainFilter.value;
    const specialization = specializationFilter.value;
    const roleItems = specialization
      ? payload.roles.specializations.filter((item) => item.key === specialization)
      : domain ? payload.roles.domains.filter((item) => item.key === domain) : payload.roles.domains;
    const skillDomain = domain || "all";
    const skills = payload.skills.filter((item) => item.domain === skillDomain);
    const salaries = specialization
      ? payload.salary.specializations.filter((item) => item.key === specialization)
      : domain ? payload.salary.domains.filter((item) => item.key === domain) : payload.salary.overall;
    const overview = payload.overview;
    const coverage = payload.coverage || {};
    freshness.textContent = `Through ${payload.as_of_date} · rolling ${payload.window_days} days · ${coverage.valid_snapshot_days || 0} valid snapshots`;
    const gaps = coverage.missing_dates || [];
    notice.classList.toggle("hidden", !gaps.length && !coverage.quarantined_snapshot_days);
    notice.textContent = gaps.length
      ? `Partial archive coverage: ${gaps.length} snapshot ${gaps.length === 1 ? "day is" : "days are"} missing. Counts are not interpolated.`
      : coverage.quarantined_snapshot_days ? `${coverage.quarantined_snapshot_days} archive snapshot was quarantined by quality checks.` : "";
    content.innerHTML = `
      <section class="market-kpis" aria-label="Market overview">
        <div><span>Deduplicated jobs</span><strong>${count(overview.deduplicated_clusters)}</strong></div>
        <div><span>Duplicate postings removed</span><strong>${count(overview.duplicate_members)}</strong></div>
        <div><span>Salary coverage</span><strong>${Math.round(Number(overview.salary_coverage) * 100)}%</strong></div>
        <div><span>Reporting floor</span><strong>${count(payload.methodology.minimum_group_size)}</strong><small>jobs per public group</small></div>
      </section>
      <section class="market-card market-card-wide"><header><div><span>Demand</span><h2>Daily job postings</h2></div><small>One count per duplicate cluster</small></header>${lineChart(payload.daily_demand)}</section>
      <div class="market-grid">
        <section class="market-card"><header><div><span>Qwen taxonomy</span><h2>${domain || specialization ? "Selected role demand" : "Role demand"}</h2></div></header>${bars(roleItems)}</section>
        <section class="market-card"><header><div><span>O*NET extraction</span><h2>Skills in demand</h2></div></header>${skillTable(skills)}</section>
        <section class="market-card"><header><div><span>Annual base salary</span><h2>Salary percentiles</h2></div><small>P25 · median · P75</small></header>${salaryPanel(salaries)}</section>
        <section class="market-card"><header><div><span>Geography</span><h2>States</h2></div></header>${bars(payload.locations.states)}</section>
        <section class="market-card"><header><div><span>Locality</span><h2>Cities</h2></div></header>${bars(payload.locations.localities)}</section>
        <section class="market-card"><header><div><span>Work mode</span><h2>Remote, hybrid and onsite</h2></div></header>${bars(payload.locations.work_modes)}</section>
        <section class="market-card market-card-wide"><header><div><span>Skill graph</span><h2>Common skill combinations</h2></div></header>${pairTable(payload.skill_cooccurrence)}</section>
      </div>
      <footer class="market-methodology">Qwen primary taxonomy path · O*NET exact/curated skill aliases · USD annualized base salary only · MinHash similarity ${payload.methodology.duplicate_similarity}</footer>`;
  }

  function populateFilters() {
    domainFilter.innerHTML = option("", "All focus areas") + payload.roles.domains.map((item) => option(item.key, item.label)).join("");
    populateSpecializations();
  }

  function populateSpecializations() {
    const selected = specializationFilter.value;
    const available = payload.roles.specializations.filter(
      (item) => !domainFilter.value || item.domain === domainFilter.value
    );
    specializationFilter.innerHTML = option("", "All specializations") + available.map((item) => option(item.key, item.label)).join("");
    specializationFilter.value = available.some((item) => item.key === selected) ? selected : "";
  }

  async function load() {
    if (loaded || loading) return;
    loading = true;
    content.innerHTML = '<div class="market-loading">Loading aggregate market data…</div>';
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
  return {
    show() { root.classList.remove("hidden"); load(); },
    hide() { root.classList.add("hidden"); },
  };
}

const DATA_URL = "./data/hiring_posts.json";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

function label(value) {
  return String(value || "unknown").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(date);
}

function option(value, text) {
  return `<option value="${escapeHtml(value)}">${escapeHtml(text)}</option>`;
}

export function createHiringPosts() {
  const root = document.getElementById("hiring-posts");
  const content = document.getElementById("hiring-posts-content");
  const freshness = document.getElementById("hiring-posts-freshness");
  const countBadge = document.getElementById("hiring-posts-count");
  const search = document.getElementById("hiring-posts-search");
  const roleFilter = document.getElementById("hiring-posts-role-filter");
  const contactFilter = document.getElementById("hiring-posts-contact-filter");
  const posterFilter = document.getElementById("hiring-posts-poster-filter");
  let payload = null;
  let loading = false;

  function populateFilters() {
    const roleFamilies = [...new Set(payload.posts.flatMap((post) => post.role_families || []))].sort();
    const contacts = [...new Set(payload.posts.flatMap((post) => post.contact_methods || []))].sort();
    const posters = [...new Set(payload.posts.map((post) => post.poster_relationship).filter(Boolean))].sort();
    roleFilter.innerHTML = option("", "All role families") + roleFamilies.map((item) => option(item, item)).join("");
    contactFilter.innerHTML = option("", "Any contact method") + contacts.map((item) => option(item, label(item))).join("");
    posterFilter.innerHTML = option("", "Any poster type") + posters.map((item) => option(item, label(item))).join("");
  }

  function filteredPosts() {
    const query = search.value.trim().toLocaleLowerCase();
    return payload.posts.filter((post) => {
      if (roleFilter.value && !(post.role_families || []).includes(roleFilter.value)) return false;
      if (contactFilter.value && !(post.contact_methods || []).includes(contactFilter.value)) return false;
      if (posterFilter.value && post.poster_relationship !== posterFilter.value) return false;
      if (!query) return true;
      return [post.author_name, post.company, post.summary, ...(post.roles || []), ...(post.locations || [])]
        .join(" ").toLocaleLowerCase().includes(query);
    });
  }

  function postCard(post) {
    const linkedinUrl = safeUrl(post.linkedin_url);
    const applicationLinks = (post.application_links || []).map(safeUrl).filter(Boolean).slice(0, 4);
    const roleLabel = (post.roles || []).join(" · ") || (post.role_families || []).join(" · ") || "AI and data hiring";
    const location = (post.locations || []).join(" · ");
    const direct = ["hiring_manager", "team_member", "recruiter", "company_page"].includes(post.poster_relationship);
    return `<article class="hiring-card">
      <div class="hiring-card-topline">
        <span class="hiring-signal${direct ? " is-direct" : ""}">${escapeHtml(label(post.poster_relationship))}</span>
        <time datetime="${escapeHtml(post.published_at)}">${escapeHtml(formatDate(post.published_at))}</time>
      </div>
      <h2>${escapeHtml(roleLabel)}</h2>
      <p class="hiring-byline"><strong>${escapeHtml(post.author_name)}</strong>${post.company ? ` · ${escapeHtml(post.company)}` : ""}</p>
      <p class="hiring-summary">${escapeHtml(post.summary)}</p>
      <div class="hiring-tags">
        ${(post.role_families || []).map((item) => `<span>${escapeHtml(item)}</span>`).join("")}
        ${location ? `<span>${escapeHtml(location)}</span>` : ""}
        ${post.work_arrangement && post.work_arrangement !== "Unspecified" ? `<span>${escapeHtml(post.work_arrangement)}</span>` : ""}
        ${(post.contact_methods || []).includes("dm") ? '<span class="is-dm">DM invited</span>' : ""}
      </div>
      <div class="hiring-actions">
        ${applicationLinks.map((url, index) => `<a class="button button-primary" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${applicationLinks.length > 1 ? `Apply ${index + 1}` : "Apply"}</a>`).join("")}
        ${linkedinUrl ? `<a class="button button-secondary" href="${escapeHtml(linkedinUrl)}" target="_blank" rel="noopener noreferrer">View LinkedIn post</a>` : ""}
      </div>
    </article>`;
  }

  function render() {
    if (!payload) return;
    const posts = filteredPosts();
    if (!posts.length) {
      content.innerHTML = `<div class="hiring-empty"><strong>No hiring posts match</strong><p>Try clearing a filter or check again after the next daily refresh.</p></div>`;
      return;
    }
    content.innerHTML = `<div class="hiring-results-note">Showing ${posts.length} of ${payload.posts.length} current hiring ${payload.posts.length === 1 ? "signal" : "signals"}</div><div class="hiring-grid">${posts.map(postCard).join("")}</div>`;
  }

  async function load() {
    if (payload || loading) return;
    loading = true;
    root.setAttribute("aria-busy", "true");
    try {
      const response = await fetch(DATA_URL);
      if (!response.ok) throw new Error(`Hiring posts could not be loaded (${response.status}).`);
      payload = await response.json();
      if (payload.schema_version !== "hiring-posts-public-v1" || !Array.isArray(payload.posts)) {
        throw new Error("The published hiring-post dataset has an unsupported format.");
      }
      countBadge.textContent = payload.posts.length ? String(payload.posts.length) : "";
      freshness.textContent = `${payload.posts.length} current signals · ${payload.retention_days}-day window · summaries link to original posts`;
      populateFilters();
      render();
    } catch (error) {
      content.innerHTML = `<div class="hiring-empty"><strong>Hiring posts are unavailable</strong><p>${escapeHtml(error.message)}</p></div>`;
      freshness.textContent = "Unable to load hiring signals · try again later";
    } finally {
      loading = false;
      root.setAttribute("aria-busy", "false");
    }
  }

  [search, roleFilter, contactFilter, posterFilter].forEach((control) => control.addEventListener("input", render));
  return {
    show() { root.classList.remove("hidden"); load(); },
    hide() { root.classList.add("hidden"); },
  };
}

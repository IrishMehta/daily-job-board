"""Static contract checks for the zero-build public dashboard."""

import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"


class FrontendContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.payload_path = DOCS / "data" / "public_jobs.json"
        cls.payload = json.loads(cls.payload_path.read_text(encoding="utf-8"))

    def test_main_payload_budget_and_schema(self):
        self.assertEqual("public-job-board-site-v3", self.payload["schema_version"])
        # Budget, not a platform limit: the site fetches this whole file before
        # it can render, so the number is a first-load cost the board is willing
        # to pay. Raised from 15MB on 2026-08-21, when ~4.9k jobs took the
        # payload to 15.18MB. GitHub itself only warns at 50MB and blocks at
        # 100MB, so the constraint here is the visitor's download, not the push.
        self.assertLess(self.payload_path.stat().st_size, 30 * 1024 * 1024)
        self.assertTrue(self.payload["jobs"])
        for job in self.payload["jobs"]:
            self.assertNotIn("job_description", job)
            self.assertTrue(job["description_excerpt"])
            self.assertLessEqual(len(job["match_terms"]), 24)

    def test_company_logo_manifest_is_optional_and_keeps_initials_fallback(self):
        manifest = json.loads((DOCS / "data" / "company_brands.json").read_text(encoding="utf-8"))
        app_source = (DOCS / "app.js").read_text(encoding="utf-8")
        styles = (DOCS / "styles.css").read_text(encoding="utf-8")

        self.assertEqual("public-company-brands-v1", manifest["schema_version"])
        self.assertIn("companies", manifest)
        self.assertIn('fetch("./data/company_brands.json").catch(() => null)', app_source)
        self.assertIn("companyInitials(company)", app_source)
        self.assertIn('companyAvatar(job.company, "row")', app_source)
        self.assertIn("company-avatar-row", styles)
        self.assertIn(".company-avatar.has-logo { border-color: transparent; background: transparent; }", styles)
        self.assertIn("width: 44px; height: 44px", styles)
        self.assertIn("width: 28px; height: 28px", styles)
        self.assertIn('loading="lazy"', app_source)
        self.assertIn("object-fit: contain", styles)

    def test_mobile_job_date_places_month_on_second_line(self):
        app_source = (DOCS / "app.js").read_text(encoding="utf-8")
        styles = (DOCS / "styles.css").read_text(encoding="utf-8")

        self.assertIn('class="job-age-date"', app_source)
        self.assertIn('class="job-age-month"', app_source)
        self.assertIn('class="job-age-day"', app_source)
        self.assertIn(".job-age-date { flex-direction: column-reverse", styles)

    def test_first_visit_guide_has_six_steps_and_no_shortlist_step(self):
        html = (DOCS / "index.html").read_text(encoding="utf-8")
        tour_source = (DOCS / "product-tour.js").read_text(encoding="utf-8")
        self.assertIn('id="product-tour"', html)
        self.assertIn('data-tour-launch', html)
        self.assertIn('id="tour-skip"', html)
        self.assertIn('id="tour-next"', html)
        self.assertIn('id="tour-back"', html)
        self.assertIn('import { createProductTour } from "./product-tour.js";', (DOCS / "app.js").read_text(encoding="utf-8"))
        self.assertEqual(tour_source.count("title:"), 6)
        self.assertNotIn("shortlist", tour_source.casefold())

    def test_local_storage_contract_excludes_private_resume_data_and_cookies(self):
        storage_source = (DOCS / "storage.js").read_text(encoding="utf-8")
        app_source = (DOCS / "app.js").read_text(encoding="utf-8")
        self.assertIn('STORAGE_KEY = "jobDiscoveryBoard:v1"', storage_source)
        self.assertIn("schemaVersion: 1", storage_source)
        self.assertNotIn("resume", storage_source.casefold())
        self.assertNotIn("document.cookie", storage_source + app_source)

    def test_search_first_shell_and_modules_are_wired(self):
        html = (DOCS / "index.html").read_text(encoding="utf-8")
        self.assertIn('id="search-input"', html)
        self.assertIn('id="job-list"', html)
        self.assertIn('id="detail-pane"', html)
        self.assertIn('data-view="shortlist"', html)
        self.assertIn('class="button button-board observatory-link"', html)
        self.assertIn('href="https://irishmehta.github.io/JobAutomation/"', html)
        self.assertIn('aria-label="Open Pipeline Observatory"', html)
        self.assertIn('class="button button-board api-docs-link"', html)
        self.assertIn('href="https://job-api.irishmehta.workers.dev/docs"', html)
        self.assertIn('aria-label="Open API documentation"', html)
        self.assertIn('class="button button-board market-action"', html)
        self.assertIn('class="view-tab resume-tab" id="resume-open"', html)
        self.assertLess(html.index('data-view="all"'), html.index('id="resume-open"'))
        self.assertLess(html.index('id="resume-open"'), html.index('data-view="shortlist"'))
        self.assertIn('class="github-mark"', html)
        self.assertIn('aria-label="View this project on GitHub"', html)
        self.assertIn('type="module" src="./app.js"', html)

    def test_market_trends_tab_is_lazy_and_aggregate_only(self):
        html = (DOCS / "index.html").read_text(encoding="utf-8")
        app_source = (DOCS / "app.js").read_text(encoding="utf-8")
        market_source = (DOCS / "market-analysis.js").read_text(encoding="utf-8")
        payload_path = DOCS / "data" / "market_analysis.json"
        payload = json.loads(payload_path.read_text(encoding="utf-8"))

        self.assertIn('data-view="market"', html)
        self.assertIn('id="market-analysis"', html)
        self.assertIn('id="market-domain-filter"', html)
        self.assertIn('id="market-specialization-filter"', html)
        self.assertIn('id="market-state-filter"', html)
        self.assertIn('id="market-career-filter"', html)
        self.assertIn('from "./market-analysis.js"', app_source)
        self.assertIn('fetch(DATA_URL)', market_source)
        self.assertIn('aria-label="Skills by category"', market_source)
        self.assertIn('Clusters · 30d', market_source)
        self.assertNotIn('weekly job demand', market_source)
        self.assertEqual("market-analysis-public-v2", payload["schema_version"])
        self.assertIn("cohorts", payload)
        self.assertIn("all", payload["cohorts"])
        self.assertIn("cohort_slices", payload)
        self.assertIn("skill_categories", payload)
        self.assertIn("market-skill-category-filter", market_source)
        self.assertIn('option(value, label, selected = false)', market_source)
        self.assertIn('item.key === skillCategory', market_source)
        self.assertTrue(all("category" in item for item in payload.get("skills", [])))
        serialized = json.dumps(payload).casefold()
        for forbidden in ("job_description", "evidence_snippet", "/scratch/", "https://"):
            self.assertNotIn(forbidden, serialized)

    def test_hiring_posts_tab_is_lazy_and_keeps_raw_post_text_private(self):
        html = (DOCS / "index.html").read_text(encoding="utf-8")
        app_source = (DOCS / "app.js").read_text(encoding="utf-8")
        hiring_source = (DOCS / "hiring-posts.js").read_text(encoding="utf-8")
        payload = json.loads((DOCS / "data" / "hiring_posts.json").read_text(encoding="utf-8"))

        self.assertIn('data-view="hiring"', html)
        self.assertIn('id="hiring-posts"', html)
        self.assertIn('id="hiring-posts-search"', html)
        self.assertIn('id="hiring-posts-sort"', html)
        self.assertIn('<option value="newest">Newest first</option>', html)
        self.assertIn('<option value="oldest">Oldest first</option>', html)
        self.assertIn('from "./hiring-posts.js"', app_source)
        self.assertIn('fetch(DATA_URL)', hiring_source)
        self.assertIn('rel="noopener noreferrer"', hiring_source)
        self.assertIn("compareHiringPostDates(left, right, sortControl.value)", hiring_source)
        self.assertIn('order === "oldest"', hiring_source)
        self.assertIn('post.hiring_manager_name', hiring_source)
        self.assertEqual("hiring-posts-public-v1", payload["schema_version"])
        self.assertEqual(14, payload["retention_days"])
        serialized = json.dumps(payload).casefold()
        for forbidden in ("post_text", "author_comments", "evidence", "alert_subject", "/scratch/"):
            self.assertNotIn(forbidden, serialized)

    def test_market_trends_uses_explanatory_visual_system(self):
        market_source = (DOCS / "market-analysis.js").read_text(encoding="utf-8")
        styles = (DOCS / "styles.css").read_text(encoding="utf-8")

        for visual in (
            "pulseChart", "roleMap", "skillHeatmap", "salaryRails",
            "stateChoropleth", "industryMosaic", "skillNetwork",
        ):
            self.assertIn(f"function {visual}", market_source)
        self.assertIn('from "./us-states-map.js"', market_source)
        map_source = (DOCS / "us-states-map.js").read_text(encoding="utf-8")
        self.assertEqual(51, map_source.count('{"id":"'))
        self.assertIn("US Census Bureau", map_source)
        self.assertIn('data-market-role=', market_source)
        self.assertIn("market-brief", styles)
        self.assertIn("prefers-reduced-motion", styles)


if __name__ == "__main__":
    unittest.main()

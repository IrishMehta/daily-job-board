"""Static contract checks for search-first taxonomy filtering and navigation."""

import unittest
from pathlib import Path


BOARD_DIR = Path(__file__).resolve().parents[1]


class TaxonomyNavigationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = (BOARD_DIR / "docs" / "app.js").read_text(encoding="utf-8")
        cls.matching = (BOARD_DIR / "docs" / "matching.js").read_text(encoding="utf-8")
        cls.index = (BOARD_DIR / "docs" / "index.html").read_text(encoding="utf-8")
        cls.styles = (BOARD_DIR / "docs" / "styles.css").read_text(encoding="utf-8")

    def test_taxonomy_is_immediately_available_as_facets(self):
        self.assertIn('id="domain-filter"', self.index)
        self.assertIn('id="specialization-filter"', self.index)
        self.assertIn('id="industry-filter"', self.index)
        self.assertIn("function updateSpecializationOptions()", self.app)
        self.assertIn("hasAny(job._domains, filters.domains)", self.matching)

    def test_filters_are_shareable_in_url_state(self):
        self.assertIn('domains: "domain"', self.app)
        self.assertIn('specializations: "specialization"', self.app)
        self.assertIn('industries: "industry"', self.app)
        self.assertIn("function readUrlState(filters)", self.app)
        self.assertIn("function writeUrlState()", self.app)

    def test_search_results_are_visible_without_taxonomy_selection(self):
        self.assertIn('id="job-list"', self.index)
        self.assertIn("filterAndSortJobs(state.jobs, state.filters", self.app)
        self.assertNotIn("Choose a domain", self.index)

    def test_experience_filter_uses_minimum_only(self):
        self.assertIn(
            "yearsActive && job.yoe_min != null && job.yoe_min > years",
            self.matching,
        )
        self.assertNotIn("job.yoe_max < years", self.matching)

    def test_mobile_filters_use_a_bottom_sheet(self):
        self.assertIn("function openFilters()", self.app)
        self.assertIn("function closeFilters()", self.app)
        self.assertIn('id="mobile-filter-close"', self.index)
        self.assertIn(".filter-panel.is-open", self.styles)

    def test_resume_matcher_is_modal_and_private(self):
        self.assertIn('id="resume-dialog"', self.index)
        self.assertIn("showModal()", self.app)
        self.assertIn("Your resume stays in this tab", self.index)
        self.assertIn("Semantic similarity only—verify", self.app)


if __name__ == "__main__":
    unittest.main()

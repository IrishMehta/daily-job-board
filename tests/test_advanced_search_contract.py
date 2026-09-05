"""Static contracts for the browser-only advanced search implementation."""

import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"


class AdvancedSearchContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = (DOCS / "app.js").read_text(encoding="utf-8")
        cls.html = (DOCS / "index.html").read_text(encoding="utf-8")
        cls.matching = (DOCS / "matching.js").read_text(encoding="utf-8")
        cls.search = (DOCS / "search.js").read_text(encoding="utf-8")
        cls.worker = (DOCS / "search-worker.js").read_text(encoding="utf-8")
        cls.config = json.loads((DOCS / "search-config.json").read_text(encoding="utf-8"))

    def test_search_is_browser_only_and_worker_backed(self):
        self.assertIn('new Worker("./search-worker.js", { type: "module" })', self.app)
        self.assertIn("class SearchIndex", self.search)
        self.assertIn("isCurrentSearchResponse", self.app)
        self.assertIn('fetch("./search-config.json")', self.worker)
        self.assertNotIn("job_embeddings", self.search + self.worker)

    def test_accessible_guided_search_contract(self):
        self.assertIn('role="combobox"', self.html)
        self.assertIn('aria-autocomplete="list"', self.html)
        self.assertIn('id="search-suggestions" role="listbox"', self.html)
        self.assertIn('id="search-assist"', self.html)
        self.assertIn("data-corrected-query", self.app)
        self.assertIn("aria-activedescendant", self.app)

    def test_relevance_sort_and_safe_highlighting_are_wired(self):
        self.assertIn('<option value="relevance">Best match</option>', self.html)
        self.assertIn('filters.sort === "relevance"', self.matching)
        self.assertIn("function highlightText", self.app)
        self.assertIn("escapeHtml(text.slice(start, end))", self.app)
        self.assertIn("searchScores.has(job.id)", self.matching)

    def test_config_pins_search_policy(self):
        self.assertEqual("public-job-board-search-v1", self.config["schema_version"])
        self.assertEqual(10, self.config["field_weights"]["title"])
        self.assertEqual(1, self.config["field_weights"]["excerpt"])
        self.assertEqual(8, self.config["suggestion_limit"])
        self.assertIn("c++", self.config["protected_terms"])
        self.assertIn(".net", self.config["protected_terms"])
        aliases = {alias for group in self.config["synonym_groups"] for alias in group["aliases"]}
        self.assertTrue({"ml", "ai", "mle", "nlp", "llm", "swe", "sde", "sre", "qa"}.issubset(aliases))

    def test_worker_failure_preserves_basic_search(self):
        self.assertIn("function failAdvancedSearch()", self.app)
        self.assertIn("queryTokens.every", self.matching)
        self.assertIn("searchFailed", self.app)


if __name__ == "__main__":
    unittest.main()

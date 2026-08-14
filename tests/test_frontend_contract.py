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
        self.assertLess(self.payload_path.stat().st_size, 8 * 1024 * 1024)
        self.assertTrue(self.payload["jobs"])
        for job in self.payload["jobs"]:
            self.assertNotIn("job_description", job)
            self.assertTrue(job["description_excerpt"])
            self.assertLessEqual(len(job["match_terms"]), 24)
            self.assertRegex(job["details_shard"], r"^[0-1][0-9a-f]$")

    def test_detail_shards_cover_every_published_job_once_and_meet_budget(self):
        detail_dir = DOCS / "data" / "job-details"
        shard_files = sorted(detail_dir.glob("*.json"))
        self.assertEqual(32, len(shard_files))
        detail_ids = set()
        for path in shard_files:
            self.assertLess(path.stat().st_size, 1024 * 1024)
            payload = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual("public-job-board-detail-v1", payload["schema_version"])
            self.assertEqual(path.stem, payload["shard"])
            self.assertTrue(detail_ids.isdisjoint(payload["jobs"]))
            detail_ids.update(payload["jobs"])
        self.assertEqual({job["id"] for job in self.payload["jobs"]}, detail_ids)

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
        self.assertIn('type="module" src="./app.js"', html)


if __name__ == "__main__":
    unittest.main()

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from scripts.build_d1_import import ValidationError, build_import


SERVICE_ROOT = Path(__file__).resolve().parents[1]
MIGRATION = SERVICE_ROOT / "migrations" / "0001_initial.sql"


def sample_payload():
    return {
        "schema_version": "3",
        "taxonomy_version": "test-taxonomy",
        "generated_at": "2026-08-19T08:00:00Z",
        "total_openings": 1,
        "posted_within_days": 30,
        "taxonomy": {"domains": []},
        "career_buckets": [{"value": "early_career", "label": "Early career"}],
        "authorization_categories": [],
        "sponsorship_statuses": [],
        "jobs": [
            {
                "id": "https://example.com/jobs/1",
                "posted_on": "2026-08-18",
                "company": "O'Brien AI",
                "title": "ML Engineer",
                "location": "Tempe, AZ",
                "location_profile": {
                    "label": "Tempe, AZ",
                    "city": "Tempe",
                    "region": "Arizona",
                    "region_code": "AZ",
                    "country": "United States",
                    "country_code": "US",
                    "search_terms": ["Tempe", "Arizona"],
                },
                "career_bucket": "early_career",
                "career_bucket_label": "Early Career",
                "experience_level": "entry_level",
                "experience_level_label": "Entry level",
                "yoe_min": 0,
                "yoe_max": 2,
                "experience_display": "0-2 years",
                "authorization_category": "open_or_not_specified",
                "authorization_category_label": "Open / Not specified",
                "sponsorship_status": "not_stated",
                "work_authorization_display": "Not stated",
                "classification_paths": [
                    {
                        "domain": "machine_learning_ai",
                        "specializations": ["ml_engineering"],
                        "industry": "technology",
                        "confidence": "high",
                    }
                ],
                "summary": "Build production ML systems.",
                "description_excerpt": "A concise public excerpt.",
                "match_terms": ["machine", "learning"],
                "job_link": "https://example.com/jobs/1",
            }
        ],
    }


class BuildD1ImportTests(unittest.TestCase):
    def test_builds_load_and_guarded_activation_sql(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            source = root / "public_jobs.json"
            output = root / "generated"
            source.write_text(json.dumps(sample_payload()), encoding="utf-8")

            manifest = build_import(source, output)

            self.assertEqual(manifest["expected_counts"]["jobs"], 1)
            self.assertEqual(manifest["expected_counts"]["classifications"], 1)
            self.assertEqual(manifest["expected_counts"]["specializations"], 1)
            self.assertIn("O''Brien AI", (output / "load.sql").read_text(encoding="utf-8"))

            connection = sqlite3.connect(":memory:")
            connection.executescript(MIGRATION.read_text(encoding="utf-8"))
            connection.executescript((output / "load.sql").read_text(encoding="utf-8"))
            connection.executescript((output / "activate.sql").read_text(encoding="utf-8"))
            active_version = connection.execute(
                "SELECT active_dataset_version FROM api_state WHERE singleton = 1"
            ).fetchone()[0]
            self.assertEqual(active_version, manifest["dataset_version"])

    def test_incomplete_dataset_is_not_activated(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            source = root / "public_jobs.json"
            output = root / "generated"
            source.write_text(json.dumps(sample_payload()), encoding="utf-8")
            build_import(source, output)

            connection = sqlite3.connect(":memory:")
            connection.executescript(MIGRATION.read_text(encoding="utf-8"))
            connection.executescript((output / "load.sql").read_text(encoding="utf-8"))
            connection.execute("DELETE FROM jobs")
            connection.executescript((output / "activate.sql").read_text(encoding="utf-8"))
            active_version = connection.execute(
                "SELECT active_dataset_version FROM api_state WHERE singleton = 1"
            ).fetchone()[0]
            self.assertIsNone(active_version)

    def test_rejects_mismatched_total(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            source = root / "public_jobs.json"
            payload = sample_payload()
            payload["total_openings"] = 2
            source.write_text(json.dumps(payload), encoding="utf-8")
            with self.assertRaisesRegex(ValidationError, "total_openings"):
                build_import(source, root / "generated")


if __name__ == "__main__":
    unittest.main()

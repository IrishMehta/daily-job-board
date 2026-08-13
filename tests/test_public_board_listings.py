"""Offline tests for the deterministic public-board listings builder."""

import importlib.util
import json
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "build_public_job_board_listings.py"
SPEC = importlib.util.spec_from_file_location("public_board_listings_tests", SCRIPT_PATH)
B = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(B)


def write_jsonl(path: Path, records):
    path.write_text("".join(json.dumps(record) + "\n" for record in records), encoding="utf-8")


class PublicBoardListingsTests(unittest.TestCase):
    def test_title_classifier_includes_broad_tech_groups_and_excludes_recruiting(self):
        families = B.compile_title_families(None)
        exclusions = B.compile_patterns(B.DEFAULT_EXCLUDE_PATTERNS)
        self.assertIn("product_management", B.classify_title("Senior Product Manager", families, exclusions))
        self.assertIn("business_systems_analysis", B.classify_title("Business Systems Analyst", families, exclusions))
        self.assertIn("cybersecurity", B.classify_title("Security Engineer", families, exclusions))
        self.assertEqual([], B.classify_title("Technical Recruiter", families, exclusions))

    def test_builder_filters_and_deduplicates_before_using_description_cache(self):
        today = date(2026, 8, 13)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            prefilter_path = root / "prefilter.jsonl"
            filtered_path = root / "filtered.jsonl"
            common = {
                "family": "greenhouse",
                "company": "Example",
                "source_endpoint": "https://boards.example.test/v1/jobs",
                "location_raw": "Austin, TX",
                "location_normalized": "austin, tx",
                "location_status": "usa",
                "location_in_usa": True,
            }
            write_jsonl(
                prefilter_path,
                [
                    {
                        **common,
                        "title_raw": "Senior Product Manager",
                        "posted_on_normalized": today.isoformat(),
                        "posted_on_raw": today.isoformat(),
                        "absolute_url": "https://example.test/apply/product-1",
                        "job_id": "product-1",
                        "raw_listing": {},
                    },
                    {
                        **common,
                        "title_raw": "Business Systems Analyst",
                        "posted_on_normalized": today.isoformat(),
                        "posted_on_raw": today.isoformat(),
                        "absolute_url": "https://example.test/jobs/analyst-1",
                        "job_id": "analyst-1",
                        "raw_listing": {"descriptionHtml": "<p>Analyze enterprise systems and product data.</p>"},
                    },
                    {
                        **common,
                        "title_raw": "Technical Recruiter",
                        "posted_on_normalized": today.isoformat(),
                        "posted_on_raw": today.isoformat(),
                        "absolute_url": "https://example.test/jobs/recruiter-1",
                        "job_id": "recruiter-1",
                        "raw_listing": {"description": "Recruit technical candidates."},
                    },
                    {
                        **common,
                        "title_raw": "Security Engineer",
                        "posted_on_normalized": (today - timedelta(days=8)).isoformat(),
                        "posted_on_raw": (today - timedelta(days=8)).isoformat(),
                        "absolute_url": "https://example.test/jobs/old-1",
                        "job_id": "old-1",
                        "raw_listing": {"description": "Secure production services."},
                    },
                    {
                        **common,
                        "title_raw": "Software Engineer",
                        "posted_on_normalized": today.isoformat(),
                        "posted_on_raw": today.isoformat(),
                        "absolute_url": "https://example.test/jobs/no-description",
                        "job_id": "missing-1",
                        "raw_listing": {},
                    },
                    {
                        **common,
                        "title_raw": "Software Engineer",
                        "posted_on_normalized": today.isoformat(),
                        "posted_on_raw": today.isoformat(),
                        "absolute_url": "https://example.test/jobs/analyst-1",
                        "job_id": "duplicate-url",
                        "raw_listing": {"description": "Short duplicate description."},
                    },
                    {
                        **common,
                        "title_raw": "Data Engineer",
                        "posted_on_normalized": today.isoformat(),
                        "posted_on_raw": today.isoformat(),
                        "absolute_url": "https://example.test/jobs/foreign-1",
                        "job_id": "foreign-1",
                        "location_raw": "London, United Kingdom",
                        "location_status": "non_usa",
                        "location_in_usa": False,
                        "raw_listing": {"description": "Build data pipelines."},
                    },
                ],
            )
            write_jsonl(
                filtered_path,
                [
                    {
                        **common,
                        "title": "Senior Product Manager",
                        "posted_on": today.isoformat(),
                        "absolute_url": "https://example.test/jobs/product-1",
                        "job_id": "product-1",
                        "job_description": "Own a technical product roadmap for developer tools.",
                        "raw_listing": {},
                        "raw_detail": {"description": "Own a technical product roadmap for developer tools."},
                    }
                ],
            )

            records, summary = B.build_public_board_listings(
                prefilter_path,
                filtered_cache_path=filtered_path,
                posted_within_days=7,
                reference_date=today,
            )

        self.assertEqual(2, len(records))
        by_url = {record["absolute_url"]: record for record in records}
        self.assertEqual("filtered_cache", by_url["https://example.test/apply/product-1"]["description_source"])
        self.assertEqual("Business Systems Analyst", by_url["https://example.test/jobs/analyst-1"]["title"])
        self.assertEqual(1, summary["counts"]["duplicate_candidates"])
        self.assertEqual(1, summary["counts"]["excluded_missing_usable_description"])
        self.assertEqual(1, summary["counts"]["excluded_non_us_or_ambiguous_location"])


if __name__ == "__main__":
    unittest.main()

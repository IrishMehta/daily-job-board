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
    def test_workday_url_gets_career_site_slug_from_cxs_endpoint(self):
        record = {
            "family": "workday",
            "source_endpoint": "https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/Acme/jobs",
            "absolute_url": "https://acme.wd1.myworkdayjobs.com/job/Austin/Software-Engineer_R-1",
            "raw_listing": {"externalPath": "/job/Austin/Software-Engineer_R-1"},
        }
        self.assertEqual(
            "https://acme.wd1.myworkdayjobs.com/Acme/job/Austin/Software-Engineer_R-1",
            B.canonical_public_job_url(record),
        )
    def test_workday_url_is_not_double_prefixed(self):
        record = {
            "family": "workday",
            "source_endpoint": "https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/Acme/jobs",
            "absolute_url": "https://acme.wd1.myworkdayjobs.com/Acme/job/Austin/Software-Engineer_R-1",
            "raw_listing": {"externalPath": "/job/Austin/Software-Engineer_R-1"},
        }
        self.assertEqual(record["absolute_url"], B.canonical_public_job_url(record))

    def test_live_config_title_policy_covers_tech_groups_and_excludes_recruiting(self):
        families = B.compile_title_families(B.LISTINGS_CONFIG.get("title_families"))
        exclusions = B.compile_patterns(B.LISTINGS_CONFIG.get("title_exclude_patterns") or [])
        self.assertIn("product_management", B.classify_title("Senior Product Manager", families, exclusions))
        self.assertIn("business_systems_analysis", B.classify_title("Business Systems Analyst", families, exclusions))
        self.assertIn("cybersecurity", B.classify_title("Security Engineer", families, exclusions))
        self.assertIn("internships", B.classify_title("Software Engineering Intern", families, exclusions))
        self.assertEqual([], B.classify_title("Technical Recruiter", families, exclusions))
        self.assertEqual([], B.classify_title("Marketing Intern", families, exclusions))

    def test_missing_title_policy_fails_loudly_instead_of_falling_back(self):
        with self.assertRaises(ValueError):
            B.compile_title_families(None)
        with self.assertRaises(ValueError):
            B.compile_title_families([])
        with self.assertRaises(ValueError):
            B.compile_title_families([{"id": "", "patterns": []}])

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


class PublicDescriptionFetchTests(unittest.TestCase):
    def _prefilter_record(self, family, title, job_id, source, external_path=None):
        record = {
            "family": family,
            "company": "Example",
            "source_endpoint": source,
            "title_raw": title,
            "posted_on_normalized": date(2026, 8, 13).isoformat(),
            "location_raw": "Austin, TX",
            "location_status": "usa",
            "location_in_usa": True,
            "absolute_url": f"https://example.test/apply/{job_id}",
            "job_id": job_id,
            "raw_listing": {"externalPath": external_path} if external_path else {},
        }
        return record

    def test_fetch_rescues_descriptionless_candidates_and_caches_results(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            prefilter_path = root / "prefilter.jsonl"
            cache_path = root / "public_cache.jsonl"
            write_jsonl(
                prefilter_path,
                [
                    self._prefilter_record(
                        "workday", "Software Engineering Intern", "R-1",
                        "https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/intern/jobs",
                        external_path="/job/Austin/Software-Engineering-Intern_R-1",
                    ),
                    self._prefilter_record(
                        "greenhouse", "Machine Learning Intern", "77",
                        "https://boards-api.greenhouse.io/v1/boards/acme/jobs",
                    ),
                    self._prefilter_record(
                        "greenhouse", "Data Science Intern", "88",
                        "https://boards-api.greenhouse.io/v1/boards/acme/jobs",
                    ),
                ],
            )
            calls = []

            def fake_http_get(url):
                calls.append(url)
                if url.endswith("R-1"):
                    return {"jobPostingInfo": {"jobDescription": "<p>Build intern tooling with Python.</p>"}}
                if url.endswith("/77"):
                    return {"content": "&lt;p&gt;Train models. Requires Python.&lt;/p&gt;"}
                return {"content": ""}

            records, summary = B.build_public_board_listings(
                prefilter_path,
                filtered_cache_path=None,
                posted_within_days=7,
                reference_date=date(2026, 8, 13),
                public_description_cache_path=cache_path,
                max_description_fetches=10,
                http_get=fake_http_get,
            )
            self.assertEqual(summary["counts"]["description_fetch_attempted"], 3)
            self.assertEqual(summary["counts"]["description_fetch_succeeded"], 2)
            self.assertEqual(summary["counts"]["description_fetch_unusable"], 1)
            self.assertEqual(summary["counts"]["records_selected"], 2)
            descriptions = {record["job_id"]: record["job_description"] for record in records}
            self.assertIn("Build intern tooling with Python.", descriptions["R-1"])
            self.assertIn("Train models. Requires Python.", descriptions["77"])
            self.assertTrue(all(record["description_source"] == "public_fetch" for record in records))

            # Second run: successes come from the cache, the unusable one is
            # negative-cached, so no HTTP requests happen at all.
            calls.clear()
            records_again, summary_again = B.build_public_board_listings(
                prefilter_path,
                filtered_cache_path=None,
                posted_within_days=7,
                reference_date=date(2026, 8, 13),
                public_description_cache_path=cache_path,
                max_description_fetches=10,
                http_get=fake_http_get,
            )
            self.assertEqual(calls, [])
            self.assertEqual(len(records_again), 2)
            self.assertEqual(summary_again["counts"].get("description_fetch_attempted", 0), 0)
            self.assertTrue(all(record["description_source"] == "public_fetch_cache" for record in records_again))

    def test_fetch_budget_and_transient_errors_do_not_poison_the_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            prefilter_path = root / "prefilter.jsonl"
            cache_path = root / "public_cache.jsonl"
            write_jsonl(
                prefilter_path,
                [
                    self._prefilter_record(
                        "greenhouse", "Software Engineer Intern", "1",
                        "https://boards-api.greenhouse.io/v1/boards/acme/jobs",
                    ),
                    self._prefilter_record(
                        "greenhouse", "Data Engineer Intern", "2",
                        "https://boards-api.greenhouse.io/v1/boards/acme/jobs",
                    ),
                ],
            )

            def failing_http_get(url):
                raise RuntimeError("boom")

            records, summary = B.build_public_board_listings(
                prefilter_path,
                filtered_cache_path=None,
                posted_within_days=7,
                reference_date=date(2026, 8, 13),
                public_description_cache_path=cache_path,
                max_description_fetches=1,
                http_get=failing_http_get,
            )
            self.assertEqual(records, [])
            self.assertEqual(summary["counts"]["description_fetch_attempted"], 1)
            self.assertEqual(summary["counts"]["description_fetch_failed"], 1)
            self.assertEqual(summary["counts"]["description_fetch_skipped_budget"], 1)
            self.assertEqual(summary["counts"]["excluded_missing_usable_description"], 2)
            self.assertFalse(cache_path.exists())

#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_ENRICHED_PATH = PROJECT_ROOT / "temp" / "PublicJobBoard" / "public_jobs_enriched.jsonl"
DEFAULT_SUMMARY_PATH = PROJECT_ROOT / "temp" / "PublicJobBoard" / "public_jobs_summary.json"
DEFAULT_OUTPUT_PATH = PROJECT_ROOT / "PublicJobBoard" / "docs" / "data" / "public_jobs.json"

REPO_URL = "https://github.com/IrishMehta/daily-job-board"

CAREER_BUCKET_ORDER = [
    "early_career_or_new_grad",
    "mid_career_or_senior",
    "managerial",
]
CAREER_BUCKET_LABELS = {
    "early_career_or_new_grad": "Early Career / New Grad",
    "mid_career_or_senior": "Mid-Career / Senior",
    "managerial": "Managerial",
}

EXPERIENCE_LEVEL_LABELS = {
    "entry_level": "Entry Level",
    "early_career": "Early Career",
    "mid_level": "Mid-Level",
    "senior_individual_contributor": "Senior IC",
    "managerial_or_leadership": "Managerial / Leadership",
    "not_stated": "Not stated",
    "unclear": "Unclear",
}

AUTHORIZATION_ORDER = [
    "country_specific_work_authorization",
    "independent_contractor_only",
    "no_sponsorship",
    "open_or_not_specified",
    "requires_permanent_residency_or_green_card",
    "requires_security_clearance_or_public_trust",
    "requires_unrestricted_us_work_authorization",
    "requires_us_citizenship",
    "requires_us_person_status",
]
AUTHORIZATION_LABELS = {
    "country_specific_work_authorization": "Country-specific work authorization",
    "independent_contractor_only": "Independent contractor only",
    "no_sponsorship": "No sponsorship",
    "open_or_not_specified": "Open / Not specified",
    "requires_permanent_residency_or_green_card": "Requires green card / permanent residency",
    "requires_security_clearance_or_public_trust": "Requires clearance / public trust",
    "requires_unrestricted_us_work_authorization": "Requires unrestricted US work authorization",
    "requires_us_citizenship": "Requires US citizenship",
    "requires_us_person_status": "Requires US person status",
}

SPONSORSHIP_ORDER = [
    "supports_sponsorship",
    "no_sponsorship",
    "not_specified",
]
SPONSORSHIP_LABELS = {
    "supports_sponsorship": "Supports sponsorship",
    "no_sponsorship": "No sponsorship",
    "not_specified": "Not specified",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build the publishable public job board JSON payload.")
    parser.add_argument("--enriched-path", type=Path, default=DEFAULT_ENRICHED_PATH)
    parser.add_argument("--summary-path", type=Path, default=DEFAULT_SUMMARY_PATH)
    parser.add_argument("--output-path", type=Path, default=DEFAULT_OUTPUT_PATH)
    return parser.parse_args()


def load_json(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def iter_jsonl(path: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            stripped = line.strip()
            if not stripped:
                continue
            records.append(json.loads(stripped))
    return records


def build_location_profile(location: str) -> dict[str, Any]:
    normalized = str(location or "").strip() or "Unknown"
    search_terms = [normalized]
    upper = normalized.upper()
    if "UNITED STATES" in upper or " USA" in upper or upper.startswith("USA") or "US-" in upper or " US" in upper:
        search_terms.extend(["United States", "US", "USA"])
    return {
        "display": normalized,
        "label": normalized,
        "city": "",
        "region": "",
        "region_code": "",
        "country": "United States" if "United States" in search_terms else "",
        "country_code": "US" if "United States" in search_terms else "",
        "search_terms": search_terms,
    }


def format_experience_display(assessment: dict[str, Any], public_card: dict[str, Any]) -> str:
    public_display = str(public_card.get("experience_display") or "").strip()
    if public_display:
        return public_display

    yoe_min = assessment.get("yoe_min")
    yoe_max = assessment.get("yoe_max")
    if isinstance(yoe_min, int) and isinstance(yoe_max, int):
        return f"{yoe_min}-{yoe_max} yrs"
    if isinstance(yoe_min, int):
        return f"{yoe_min}+ yrs"
    if isinstance(yoe_max, int):
        return f"Up to {yoe_max} yrs"
    return "Not stated"


def infer_authorization_category(assessment: dict[str, Any]) -> str:
    primary = str(assessment.get("primary_category") or "").strip()
    if primary:
        return primary
    categories = assessment.get("authorization_categories") or []
    for value in categories:
        text = str(value or "").strip()
        if text:
            return text
    return "open_or_not_specified"


def build_job(record: dict[str, Any]) -> dict[str, Any]:
    job = record.get("job") or {}
    public_card = record.get("public_card") or {}
    experience = record.get("experience_assessment") or {}
    work_auth = record.get("work_authorization_assessment") or {}

    job_link = str(public_card.get("job_link") or job.get("absolute_url") or "").strip()
    posted_on = str(public_card.get("date") or job.get("posted_on") or "").strip()
    company = str(public_card.get("company") or record.get("display_company") or job.get("company") or "").strip() or "Unknown"
    title = str(public_card.get("title") or job.get("title") or "").strip() or "Untitled role"
    location = str(public_card.get("location") or job.get("location") or "").strip() or "Unknown"

    career_bucket = str(record.get("career_bucket") or "").strip() or "mid_career_or_senior"
    experience_level = str(experience.get("experience_level") or "").strip() or "not_stated"
    authorization_category = infer_authorization_category(work_auth)
    sponsorship_status = str(work_auth.get("sponsorship_status") or "").strip() or "not_specified"

    return {
        "id": job_link or str(record.get("job_identity_key") or "").strip() or title,
        "posted_on": posted_on,
        "company": company,
        "title": title,
        "location": location,
        "location_profile": build_location_profile(location),
        "career_bucket": career_bucket,
        "career_bucket_label": CAREER_BUCKET_LABELS.get(career_bucket, career_bucket.replace("_", " ").title()),
        "experience_level": experience_level,
        "experience_level_label": EXPERIENCE_LEVEL_LABELS.get(
            experience_level, experience_level.replace("_", " ").title()
        ),
        "yoe_min": experience.get("yoe_min"),
        "yoe_max": experience.get("yoe_max"),
        "experience_display": format_experience_display(experience, public_card),
        "authorization_category": authorization_category,
        "authorization_category_label": AUTHORIZATION_LABELS.get(
            authorization_category, authorization_category.replace("_", " ").title()
        ),
        "sponsorship_status": sponsorship_status,
        "work_authorization_display": str(
            public_card.get("work_authorization_display")
            or work_auth.get("work_authorization_text")
            or "No explicit work authorization or sponsorship requirements stated"
        ).strip(),
        "job_link": job_link,
        "job_description": job.get("job_description"),
    }


def build_locations(jobs: list[dict[str, Any]], limit: int = 200) -> list[dict[str, Any]]:
    counts = Counter(str(job.get("location") or "").strip() or "Unknown" for job in jobs)
    ordered = sorted(counts.items(), key=lambda item: (-item[1], item[0].lower()))
    return [
        {
            "value": location,
            "label": location,
            "count": count,
        }
        for location, count in ordered[:limit]
    ]


def ordered_count_items(
    counts: Counter[str],
    order: list[str],
    labels: dict[str, str],
) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    seen: set[str] = set()
    for value in order:
        if value in counts:
            items.append({"value": value, "label": labels.get(value, value), "count": counts[value]})
            seen.add(value)
    extras = sorted((value for value in counts if value not in seen), key=str.lower)
    for value in extras:
        items.append({"value": value, "label": labels.get(value, value), "count": counts[value]})
    return items


def build_sponsorship_items(jobs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    counts = Counter(str(job.get("sponsorship_status") or "").strip() or "not_specified" for job in jobs)
    items = []
    for value in SPONSORSHIP_ORDER:
        if value in counts:
            items.append({"value": value, "label": SPONSORSHIP_LABELS[value]})
    for value in sorted((key for key in counts if key not in SPONSORSHIP_ORDER), key=str.lower):
        items.append({"value": value, "label": value.replace("_", " ").title()})
    return items


def build_payload(records: list[dict[str, Any]], summary: dict[str, Any]) -> dict[str, Any]:
    posted_within_days = int(summary.get("posted_within_days") or 7)

    jobs = [build_job(record) for record in records]
    jobs.sort(key=lambda job: (str(job.get("company") or "").lower(), str(job.get("title") or "").lower()))
    jobs.sort(key=lambda job: str(job.get("posted_on") or ""), reverse=True)

    career_counts = Counter(str(job.get("career_bucket") or "").strip() or "mid_career_or_senior" for job in jobs)
    auth_counts = Counter(
        str(job.get("authorization_category") or "").strip() or "open_or_not_specified" for job in jobs
    )

    return {
        "generated_at": summary.get("generated_at") or datetime.utcnow().isoformat() + "Z",
        "total_openings": len(jobs),
        "posted_within_days": posted_within_days,
        "repo_url": REPO_URL,
        "career_buckets": ordered_count_items(career_counts, CAREER_BUCKET_ORDER, CAREER_BUCKET_LABELS),
        "authorization_categories": ordered_count_items(auth_counts, AUTHORIZATION_ORDER, AUTHORIZATION_LABELS),
        "sponsorship_statuses": build_sponsorship_items(jobs),
        "locations": build_locations(jobs),
        "jobs": jobs,
    }


def main() -> None:
    args = parse_args()
    summary = load_json(args.summary_path)
    records = iter_jsonl(args.enriched_path)
    payload = build_payload(records, summary)

    args.output_path.parent.mkdir(parents=True, exist_ok=True)
    with args.output_path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, ensure_ascii=False)
        handle.write("\n")

    print(f"Wrote {len(payload['jobs'])} jobs to {args.output_path}")


if __name__ == "__main__":
    main()

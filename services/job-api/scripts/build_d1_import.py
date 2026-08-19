#!/usr/bin/env python3
"""Validate the published board payload and build a two-phase D1 import."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit


class ValidationError(ValueError):
    """Raised when the public payload violates the API import contract."""


def _mapping(value: Any, path: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValidationError(f"{path} must be an object")
    return value


def _array(value: Any, path: str) -> list[Any]:
    if not isinstance(value, list):
        raise ValidationError(f"{path} must be an array")
    return value


def _string(value: Any, path: str, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str):
        raise ValidationError(f"{path} must be a string")
    if "\x00" in value:
        raise ValidationError(f"{path} must not contain a NUL character")
    if not allow_empty and not value.strip():
        raise ValidationError(f"{path} must not be empty")
    return value


def _string_array(value: Any, path: str) -> list[str]:
    return [_string(item, f"{path}[{index}]") for index, item in enumerate(_array(value, path))]


def _integer(value: Any, path: str, *, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise ValidationError(f"{path} must be an integer >= {minimum}")
    return value


def _nullable_number(value: Any, path: str) -> int | float | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0:
        raise ValidationError(f"{path} must be null or a non-negative number")
    return value


def _iso_date(value: Any, path: str) -> str:
    text = _string(value, path)
    try:
        date.fromisoformat(text)
    except ValueError as exc:
        raise ValidationError(f"{path} must be an ISO 8601 date") from exc
    return text


def _iso_datetime(value: Any, path: str) -> str:
    text = _string(value, path)
    try:
        datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValidationError(f"{path} must be an ISO 8601 timestamp") from exc
    return text


def _http_url(value: Any, path: str) -> str:
    text = _string(value, path)
    parsed = urlsplit(text)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValidationError(f"{path} must be an HTTP(S) URL")
    return text


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _sql(value: Any) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, float)):
        return str(value)
    if not isinstance(value, str):
        raise TypeError(f"Unsupported SQL literal type: {type(value).__name__}")
    return "'" + value.replace("'", "''") + "'"


def _insert(table: str, columns: list[str], values: list[Any]) -> str:
    rendered = ", ".join(_sql(value) for value in values)
    return f"INSERT OR IGNORE INTO {table} ({', '.join(columns)}) VALUES ({rendered});"


def _validate_payload(payload: Any) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    root = _mapping(payload, "payload")
    jobs = [_mapping(job, f"jobs[{index}]") for index, job in enumerate(_array(root.get("jobs"), "jobs"))]
    total_openings = _integer(root.get("total_openings"), "total_openings")
    if total_openings != len(jobs):
        raise ValidationError(
            f"total_openings is {total_openings}, but jobs contains {len(jobs)} records"
        )

    _string(root.get("schema_version"), "schema_version")
    _string(root.get("taxonomy_version"), "taxonomy_version")
    _iso_datetime(root.get("generated_at"), "generated_at")
    _integer(root.get("posted_within_days"), "posted_within_days")
    _mapping(root.get("taxonomy"), "taxonomy")
    _array(root.get("career_buckets"), "career_buckets")
    _array(root.get("authorization_categories"), "authorization_categories")
    _array(root.get("sponsorship_statuses"), "sponsorship_statuses")
    return root, jobs


def _validated_job(job: dict[str, Any], index: int) -> dict[str, Any]:
    path = f"jobs[{index}]"
    profile = _mapping(job.get("location_profile"), f"{path}.location_profile")
    classifications = _array(job.get("classification_paths"), f"{path}.classification_paths")

    normalized_paths: list[dict[str, Any]] = []
    for path_index, raw_classification in enumerate(classifications):
        class_path = f"{path}.classification_paths[{path_index}]"
        classification = _mapping(raw_classification, class_path)
        specializations = _string_array(
            classification.get("specializations"), f"{class_path}.specializations"
        )
        if len(set(specializations)) != len(specializations):
            raise ValidationError(f"{class_path}.specializations contains duplicates")
        normalized_paths.append(
            {
                "domain": _string(classification.get("domain"), f"{class_path}.domain"),
                "specializations": specializations,
                "industry": _string(classification.get("industry"), f"{class_path}.industry"),
                "confidence": _string(classification.get("confidence"), f"{class_path}.confidence"),
            }
        )

    yoe_min = _nullable_number(job.get("yoe_min"), f"{path}.yoe_min")
    yoe_max = _nullable_number(job.get("yoe_max"), f"{path}.yoe_max")
    if yoe_min is not None and yoe_max is not None and yoe_max < yoe_min:
        raise ValidationError(f"{path}.yoe_max must be greater than or equal to yoe_min")

    job_id = _http_url(job.get("id"), f"{path}.id")
    job_link = _http_url(job.get("job_link"), f"{path}.job_link")
    match_terms = _string_array(job.get("match_terms"), f"{path}.match_terms")
    title = _string(job.get("title"), f"{path}.title")
    company = _string(job.get("company"), f"{path}.company")
    location = _string(job.get("location"), f"{path}.location")
    summary = _string(job.get("summary"), f"{path}.summary", allow_empty=True)

    search_parts = [title, company, location, summary, *match_terms]
    for classification in normalized_paths:
        search_parts.extend(
            [classification["domain"], classification["industry"], *classification["specializations"]]
        )
    search_text = re.sub(r"\s+", " ", " ".join(search_parts)).strip().lower()

    return {
        "job_id": job_id,
        "posted_on": _iso_date(job.get("posted_on"), f"{path}.posted_on"),
        "company": company,
        "title": title,
        "location": location,
        "location_label": _string(profile.get("label"), f"{path}.location_profile.label"),
        "city": _string(profile.get("city"), f"{path}.location_profile.city", allow_empty=True),
        "region": _string(profile.get("region"), f"{path}.location_profile.region", allow_empty=True),
        "region_code": _string(
            profile.get("region_code"), f"{path}.location_profile.region_code", allow_empty=True
        ),
        "country": _string(profile.get("country"), f"{path}.location_profile.country"),
        "country_code": _string(profile.get("country_code"), f"{path}.location_profile.country_code"),
        "location_search_terms_json": _json(
            _string_array(profile.get("search_terms"), f"{path}.location_profile.search_terms")
        ),
        "career_bucket": _string(job.get("career_bucket"), f"{path}.career_bucket"),
        "career_bucket_label": _string(
            job.get("career_bucket_label"), f"{path}.career_bucket_label"
        ),
        "experience_level": _string(job.get("experience_level"), f"{path}.experience_level"),
        "experience_level_label": _string(
            job.get("experience_level_label"), f"{path}.experience_level_label"
        ),
        "yoe_min": yoe_min,
        "yoe_max": yoe_max,
        "experience_display": _string(job.get("experience_display"), f"{path}.experience_display"),
        "authorization_category": _string(
            job.get("authorization_category"), f"{path}.authorization_category"
        ),
        "authorization_category_label": _string(
            job.get("authorization_category_label"), f"{path}.authorization_category_label"
        ),
        "sponsorship_status": _string(job.get("sponsorship_status"), f"{path}.sponsorship_status"),
        "work_authorization_display": _string(
            job.get("work_authorization_display"), f"{path}.work_authorization_display"
        ),
        "summary": summary,
        "description_excerpt": _string(
            job.get("description_excerpt"), f"{path}.description_excerpt", allow_empty=True
        ),
        "match_terms_json": _json(match_terms),
        "classification_paths_json": _json(classifications),
        "job_link": job_link,
        "search_text": search_text,
        "classifications": normalized_paths,
    }


def build_import(input_path: Path, output_dir: Path) -> dict[str, Any]:
    source_bytes = input_path.read_bytes()
    source_sha256 = hashlib.sha256(source_bytes).hexdigest()
    try:
        payload = json.loads(source_bytes)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValidationError(f"{input_path} is not valid UTF-8 JSON") from exc

    root, raw_jobs = _validate_payload(payload)
    jobs = [_validated_job(job, index) for index, job in enumerate(raw_jobs)]
    ids = [job["job_id"] for job in jobs]
    links = [job["job_link"] for job in jobs]
    if len(set(ids)) != len(ids):
        raise ValidationError("jobs contains duplicate id values")
    if len(set(links)) != len(links):
        raise ValidationError("jobs contains duplicate job_link values")

    version = source_sha256
    job_columns = [
        "dataset_version", "job_id", "posted_on", "company", "title", "location",
        "location_label", "city", "region", "region_code", "country", "country_code",
        "location_search_terms_json", "career_bucket", "career_bucket_label",
        "experience_level", "experience_level_label", "yoe_min", "yoe_max",
        "experience_display", "authorization_category", "authorization_category_label",
        "sponsorship_status", "work_authorization_display", "summary",
        "description_excerpt", "match_terms_json", "classification_paths_json", "job_link",
        "search_text",
    ]

    load_lines = [
        "PRAGMA foreign_keys = ON;",
        f"-- Dataset version: {version}",
        (
            "DELETE FROM dataset_versions "
            f"WHERE version = {_sql(version)} "
            "AND NOT EXISTS (SELECT 1 FROM api_state WHERE active_dataset_version = "
            f"{_sql(version)});"
        ),
        _insert(
            "dataset_versions",
            [
                "version", "source_sha256", "source_schema_version", "taxonomy_version",
                "generated_at", "total_openings", "posted_within_days", "taxonomy_json",
                "career_buckets_json", "authorization_categories_json",
                "sponsorship_statuses_json",
            ],
            [
                version, source_sha256, root["schema_version"], root["taxonomy_version"],
                root["generated_at"], root["total_openings"], root["posted_within_days"],
                _json(root["taxonomy"]), _json(root["career_buckets"]),
                _json(root["authorization_categories"]), _json(root["sponsorship_statuses"]),
            ],
        ),
    ]

    classification_count = 0
    specialization_count = 0
    for job in jobs:
        load_lines.append(
            _insert("jobs", job_columns, [version, *[job[column] for column in job_columns[1:]]])
        )
        for path_index, classification in enumerate(job["classifications"]):
            classification_count += 1
            load_lines.append(
                _insert(
                    "job_classifications",
                    ["dataset_version", "job_id", "path_index", "domain", "industry", "confidence"],
                    [
                        version, job["job_id"], path_index, classification["domain"],
                        classification["industry"], classification["confidence"],
                    ],
                )
            )
            for specialization in classification["specializations"]:
                specialization_count += 1
                load_lines.append(
                    _insert(
                        "job_specializations",
                        ["dataset_version", "job_id", "path_index", "specialization"],
                        [version, job["job_id"], path_index, specialization],
                    )
                )

    expected_jobs = len(jobs)
    activation_conditions = "\n  AND ".join(
        [
            f"(SELECT COUNT(*) FROM jobs WHERE dataset_version = {_sql(version)}) = {expected_jobs}",
            (
                "(SELECT COUNT(*) FROM job_classifications WHERE dataset_version = "
                f"{_sql(version)}) = {classification_count}"
            ),
            (
                "(SELECT COUNT(*) FROM job_specializations WHERE dataset_version = "
                f"{_sql(version)}) = {specialization_count}"
            ),
        ]
    )
    activate_lines = [
        "PRAGMA foreign_keys = ON;",
        f"-- Activate only if every expected row for {version} is present.",
        "UPDATE api_state",
        f"SET active_dataset_version = {_sql(version)},",
        "    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
        "WHERE singleton = 1",
        f"  AND {activation_conditions};",
        "SELECT active_dataset_version, updated_at FROM api_state WHERE singleton = 1;",
    ]

    manifest = {
        "dataset_version": version,
        "source_file": input_path.name,
        "source_sha256": source_sha256,
        "source_generated_at": root["generated_at"],
        "built_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "expected_counts": {
            "jobs": expected_jobs,
            "classifications": classification_count,
            "specializations": specialization_count,
        },
    }

    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "load.sql").write_text("\n".join(load_lines) + "\n", encoding="utf-8")
    (output_dir / "activate.sql").write_text("\n".join(activate_lines) + "\n", encoding="utf-8")
    (output_dir / "import-manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    manifest = build_import(args.input, args.output_dir)
    print(json.dumps(manifest, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

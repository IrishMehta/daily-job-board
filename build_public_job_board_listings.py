#!/usr/bin/env python3
"""Build the deterministic public-board handoff from extractor prefilter data.

This is intentionally separate from ``jobs_filtered.jsonl``.  The latter is
the candidate-specific handoff for relevancy assessment; this builder applies
the broader, public-board-only title taxonomy to ``jobs_prefilter.jsonl`` and
never calls an LLM.
"""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
import tempfile
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple
from urllib.parse import urlsplit, urlunsplit


SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from config_utils import load_project_config, resolve_project_path


PROJECT_CONFIG = load_project_config()
BOARD_CONFIG = PROJECT_CONFIG["public_job_board"]
LISTINGS_CONFIG = BOARD_CONFIG.get("listings") or {}

LISTINGS_VERSION = "public-board-listings-v1"
PLACEHOLDER_DESCRIPTIONS = {
    "-",
    "--",
    "...",
    "coming soon",
    "description",
    "description not available",
    "job description",
    "job description not available",
    "n a",
    "na",
    "none",
    "not available",
    "not provided",
    "null",
    "placeholder",
    "tbd",
    "unknown",
}
DESCRIPTION_KEYS = (
    "descriptionHtml",
    "descriptionPlain",
    "full_description",
    "fullDescription",
    "description",
    "opening",
    "openingHtml",
    "descriptionBody",
    "descriptionBodyPlain",
    "_corporate_description",
    "_career_site_description",
)
NESTED_DESCRIPTION_KEYS = ("_detail", "_corporate_detail", "_career_site_detail", "detail")

# These defaults keep the script usable with an older config.  The live policy
# belongs in config.yaml under public_job_board.listings.title_families.
DEFAULT_TITLE_FAMILIES = (
    {
        "id": "software_engineering",
        "patterns": (
            r"\b(?:software|application|web|full[- ]?stack|front[- ]?end|back[- ]?end|mobile|ios|android|platform|cloud|infrastructure|site reliability|devops|systems?|network|database|build|release)\s+(?:engineer|developer|architect)\b",
            r"\b(?:sre|sdet)\b",
        ),
    },
    {
        "id": "ai_data_analytics",
        "patterns": (
            r"\b(?:machine learning|ml|artificial intelligence|ai|data|analytics|business intelligence|bi|research|applied)\s+(?:engineer|scientist|analyst|developer|researcher)\b",
            r"\bdata (?:architect|manager)\b",
        ),
    },
    {
        "id": "cybersecurity",
        "patterns": (
            r"\b(?:cybersecurity|cyber security|information security|security|application security|cloud security)\s+(?:engineer|analyst|architect|researcher|specialist)\b",
            r"\b(?:penetration tester|security operations|soc analyst)\b",
        ),
    },
    {
        "id": "quality_assurance_testing",
        "patterns": (
            r"\b(?:qa|quality assurance|quality|test|automation)\s+(?:engineer|analyst|developer|architect)\b",
            r"\b(?:software test|test automation)\b",
        ),
    },
    {
        "id": "hardware_embedded_robotics",
        "patterns": (
            r"\b(?:embedded|firmware|hardware|electrical|electronics|robotics|controls|autonomy|semiconductor|fpga|asic|vlsi)\s+(?:engineer|developer|architect|designer)\b",
        ),
    },
    {
        "id": "product_management",
        "patterns": (
            r"\b(?:product manager|product owner|product analyst|product operations|technical product manager)\b",
        ),
    },
    {
        "id": "business_systems_analysis",
        "patterns": (
            r"\b(?:business|business systems|systems?|technical|operations?|data|security)\s+analyst\b",
        ),
    },
    {
        "id": "technical_program_management",
        "patterns": (
            r"\b(?:technical|technology|engineering|it|information technology)\s+(?:program|project)\s+manager\b",
            r"\b(?:technical program manager|technical project manager|engineering program manager|scrum master|agile coach)\b",
        ),
    },
    {
        "id": "it_operations_support",
        "patterns": (
            r"\b(?:systems administrator|network administrator|database administrator|it support|information technology support|desktop support|help desk|support engineer)\b",
        ),
    },
    {
        "id": "product_design",
        "patterns": (
            r"\b(?:ux|ui|user experience|user interface|interaction|product)\s+designer\b",
            r"\bux researcher\b",
        ),
    },
)
DEFAULT_EXCLUDE_PATTERNS = (
    r"\b(?:recruiter|recruiting|talent acquisition|account executive|sales representative|business development|human resources|people operations|marketing|communications|legal|accounting)\b",
)


def normalize_text(value: Any) -> str:
    text = str(value or "").replace("\x00", " ")
    return re.sub(r"\s+", " ", text).strip()


def clean_html(value: Any) -> str:
    text = html.unescape(str(value or ""))
    text = re.sub(r"(?is)<(script|style).*?>.*?</\1>", " ", text)
    text = re.sub(r"(?s)<[^>]+>", " ", text)
    return normalize_text(text)


def comparison_text(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", " ", clean_html(value).casefold()).strip()


def is_usable_description(description: Any, title: Any) -> bool:
    text = clean_html(description)
    if not text:
        return False
    normalized = comparison_text(text)
    if normalized in PLACEHOLDER_DESCRIPTIONS:
        return False
    title_normalized = comparison_text(title)
    return not title_normalized or normalized != title_normalized


def iter_jsonl(path: Path) -> Iterable[Dict[str, Any]]:
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict):
                yield value


def parse_iso_date(value: Any) -> Optional[date]:
    text = normalize_text(value)
    if not text:
        return None
    try:
        return datetime.strptime(text, "%Y-%m-%d").date()
    except ValueError:
        return None


def compile_patterns(patterns: Sequence[Any]) -> Tuple[re.Pattern[str], ...]:
    compiled = []
    for value in patterns:
        pattern = normalize_text(value)
        if pattern:
            compiled.append(re.compile(pattern, re.IGNORECASE))
    return tuple(compiled)


def compile_title_families(entries: Any) -> Tuple[Tuple[str, Tuple[re.Pattern[str], ...]], ...]:
    configured_entries = entries if isinstance(entries, list) else list(DEFAULT_TITLE_FAMILIES)
    families = []
    for entry in configured_entries:
        if not isinstance(entry, Mapping):
            continue
        family_id = normalize_text(entry.get("id"))
        patterns = compile_patterns(entry.get("patterns") or [])
        if family_id and patterns:
            families.append((family_id, patterns))
    if not families and configured_entries is not DEFAULT_TITLE_FAMILIES:
        return compile_title_families(list(DEFAULT_TITLE_FAMILIES))
    return tuple(families)


def classify_title(
    title: Any,
    title_families: Sequence[Tuple[str, Sequence[re.Pattern[str]]]],
    exclusion_patterns: Sequence[re.Pattern[str]],
) -> List[str]:
    text = normalize_text(title)
    if not text or any(pattern.search(text) for pattern in exclusion_patterns):
        return []
    return [family_id for family_id, patterns in title_families if any(pattern.search(text) for pattern in patterns)]


def is_explicit_us_record(record: Mapping[str, Any]) -> bool:
    return bool(record.get("location_in_usa")) or normalize_text(record.get("location_status")).casefold() == "usa"


def canonical_url(value: Any) -> str:
    raw_url = normalize_text(value)
    if not raw_url:
        return ""
    parsed = urlsplit(raw_url)
    if not parsed.scheme or not parsed.netloc:
        return raw_url.rstrip("/")
    path = parsed.path.rstrip("/") or "/"
    return urlunsplit((parsed.scheme.casefold(), parsed.netloc.casefold(), path, parsed.query, ""))


def record_identity_keys(record: Mapping[str, Any]) -> Tuple[str, ...]:
    """Return URL and extractor-ID keys for cache reuse and deduplication.

    Workday and several corporate adapters replace a listing URL with a detail
    URL after fetching a description.  Matching on URL alone would therefore
    miss a perfectly good cached description, even though the family/source/job
    ID still identify the same posting.
    """
    keys = []
    url = canonical_url(record.get("absolute_url") or record.get("url"))
    if url:
        keys.append("url:" + url)
    family = normalize_text(record.get("family"))
    source = normalize_text(record.get("source_endpoint"))
    job_id = normalize_text(record.get("job_id"))
    if job_id:
        keys.append("job:" + "|".join((family, source, job_id)))
    keys.append(
        "fallback:"
        + "|".join(
            (
                family,
                normalize_text(record.get("company")),
                normalize_text(record.get("title") or record.get("title_raw")).casefold(),
                normalize_text(record.get("posted_on") or record.get("posted_on_normalized")),
                normalize_text(record.get("location") or record.get("location_raw")).casefold(),
            )
        )
    )
    return tuple(dict.fromkeys(keys))


def record_identity(record: Mapping[str, Any]) -> str:
    return record_identity_keys(record)[0]


def _raw_description_candidates(raw_listing: Any) -> Iterable[Any]:
    if not isinstance(raw_listing, Mapping):
        return
    for key in DESCRIPTION_KEYS:
        value = raw_listing.get(key)
        if isinstance(value, str):
            yield value
    for key in NESTED_DESCRIPTION_KEYS:
        nested = raw_listing.get(key)
        if isinstance(nested, Mapping):
            for description_key in DESCRIPTION_KEYS:
                value = nested.get(description_key)
                if isinstance(value, str):
                    yield value


def description_from_raw_listing(record: Mapping[str, Any]) -> Optional[str]:
    title = record.get("title_raw") or record.get("title")
    candidates = [clean_html(value) for value in _raw_description_candidates(record.get("raw_listing"))]
    usable = [value for value in candidates if is_usable_description(value, title)]
    return max(usable, key=len) if usable else None


def build_description_cache(filtered_cache_path: Optional[Path]) -> Dict[str, Dict[str, Any]]:
    if filtered_cache_path is None or not filtered_cache_path.exists():
        return {}
    cache: Dict[str, Dict[str, Any]] = {}
    for record in iter_jsonl(filtered_cache_path):
        description = clean_html(record.get("job_description"))
        if not is_usable_description(description, record.get("title") or record.get("title_raw")):
            continue
        cached_value = {
            "job_description": description,
            "raw_detail": record.get("raw_detail"),
            "raw_listing": record.get("raw_listing"),
        }
        for identity in record_identity_keys(record):
            existing = cache.get(identity)
            if existing is None or len(description) > len(existing["job_description"]):
                cache[identity] = cached_value
    return cache


def resolve_description(record: Mapping[str, Any], description_cache: Mapping[str, Mapping[str, Any]]) -> Tuple[Optional[str], str, Any]:
    for identity in record_identity_keys(record):
        cached = description_cache.get(identity)
        if cached:
            return str(cached["job_description"]), "filtered_cache", cached.get("raw_detail")
    raw_description = description_from_raw_listing(record)
    if raw_description:
        return raw_description, "raw_listing", None
    return None, "", None


def public_record_from_prefilter(
    record: Mapping[str, Any],
    posted_on: date,
    title_families: Sequence[str],
    description: str,
    description_source: str,
    raw_detail: Any,
) -> Dict[str, Any]:
    title = normalize_text(record.get("title_raw") or record.get("title"))
    location = record.get("location_raw") if record.get("location_raw") is not None else record.get("location")
    raw_listing = record.get("raw_listing") if isinstance(record.get("raw_listing"), dict) else {}
    return {
        "family": record.get("family"),
        "company": record.get("company"),
        "source_endpoint": record.get("source_endpoint"),
        "scraped_at": record.get("scraped_at"),
        "title": title,
        "posted_on": posted_on.isoformat(),
        "location": location,
        "job_description": description,
        "description_status": "usable",
        "description_source": description_source,
        "absolute_url": record.get("absolute_url") or record.get("url"),
        "job_id": record.get("job_id"),
        "title_raw": record.get("title_raw") or title,
        "title_normalized": normalize_text(record.get("title_normalized")) or title.casefold(),
        "title_filter_match": " | ".join(title_families),
        "title_status": "matched",
        "public_title_families": list(title_families),
        "public_listing_version": LISTINGS_VERSION,
        "posted_on_raw": record.get("posted_on_raw"),
        "posted_on_normalized": posted_on.isoformat(),
        "date_status": "matched",
        "location_raw": record.get("location_raw"),
        "location_normalized": record.get("location_normalized"),
        "location_status": "usa",
        "location_in_usa": True,
        "filter_pass_pre_detail": True,
        "raw_listing": raw_listing,
        "raw_detail": raw_detail,
    }


def prefer_record(current: Mapping[str, Any], candidate: Mapping[str, Any]) -> bool:
    """Return whether candidate is a better representative for a duplicate identity."""
    current_source = normalize_text(current.get("description_source"))
    candidate_source = normalize_text(candidate.get("description_source"))
    if current_source != candidate_source:
        return candidate_source == "filtered_cache"
    return len(str(candidate.get("job_description") or "")) > len(str(current.get("job_description") or ""))


def build_public_board_listings(
    prefilter_path: Path,
    *,
    filtered_cache_path: Optional[Path],
    posted_within_days: int,
    title_family_entries: Any = None,
    exclusion_pattern_entries: Any = None,
    reference_date: Optional[date] = None,
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """Return broad, US-only, description-complete board candidates and audit stats."""
    if posted_within_days < 0:
        raise ValueError("posted_within_days must be non-negative")
    today = reference_date or datetime.now(timezone.utc).date()
    cutoff = today - timedelta(days=posted_within_days)
    title_families = compile_title_families(title_family_entries if title_family_entries is not None else LISTINGS_CONFIG.get("title_families"))
    exclude_entries = exclusion_pattern_entries if exclusion_pattern_entries is not None else LISTINGS_CONFIG.get("title_exclude_patterns")
    exclusion_patterns = compile_patterns(exclude_entries if isinstance(exclude_entries, list) else DEFAULT_EXCLUDE_PATTERNS)
    description_cache = build_description_cache(filtered_cache_path)

    counts: Counter[str] = Counter()
    per_source_family: Counter[str] = Counter()
    per_title_family: Counter[str] = Counter()
    selected: Dict[str, Dict[str, Any]] = {}
    aliases_to_primary: Dict[str, str] = {}

    for record in iter_jsonl(prefilter_path):
        counts["records_scanned"] += 1
        posted_on = parse_iso_date(record.get("posted_on_normalized"))
        if posted_on is None:
            counts["excluded_missing_or_invalid_date"] += 1
            continue
        if posted_on < cutoff or posted_on > today:
            counts["excluded_outside_date_window"] += 1
            continue
        if not is_explicit_us_record(record):
            counts["excluded_non_us_or_ambiguous_location"] += 1
            continue
        title_matches = classify_title(record.get("title_raw") or record.get("title"), title_families, exclusion_patterns)
        if not title_matches:
            counts["excluded_title"] += 1
            continue
        description, description_source, raw_detail = resolve_description(record, description_cache)
        if not description:
            counts["excluded_missing_usable_description"] += 1
            continue

        candidate = public_record_from_prefilter(
            record,
            posted_on,
            title_matches,
            description,
            description_source,
            raw_detail,
        )
        identity_keys = record_identity_keys(candidate)
        existing_primary = next((aliases_to_primary[key] for key in identity_keys if key in aliases_to_primary), None)
        current = selected.get(existing_primary) if existing_primary else None
        if current is not None:
            counts["duplicate_candidates"] += 1
            if prefer_record(current, candidate):
                selected[existing_primary] = candidate
            for key in identity_keys:
                aliases_to_primary[key] = existing_primary
            continue

        primary_identity = identity_keys[0]
        selected[primary_identity] = candidate
        for key in identity_keys:
            aliases_to_primary[key] = primary_identity
        counts["records_selected"] += 1
        per_source_family[normalize_text(candidate.get("family")) or "unknown"] += 1
        for title_family in title_matches:
            per_title_family[title_family] += 1

    records = sorted(
        selected.values(),
        key=lambda record: (
            normalize_text(record.get("posted_on")),
            normalize_text(record.get("company")).casefold(),
            normalize_text(record.get("title")).casefold(),
        ),
        reverse=True,
    )
    counts["records_written"] = len(records)
    summary = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "listings_version": LISTINGS_VERSION,
        "prefilter_path": str(prefilter_path),
        "filtered_cache_path": str(filtered_cache_path) if filtered_cache_path else None,
        "posted_within_days": posted_within_days,
        "cutoff_date": cutoff.isoformat(),
        "reference_date": today.isoformat(),
        "description_cache_records": len(description_cache),
        "counts": dict(sorted(counts.items())),
        "source_family_counts": dict(sorted(per_source_family.items())),
        "public_title_family_counts": dict(sorted(per_title_family.items())),
    }
    return records, summary


def write_jsonl(path: Path, records: Sequence[Mapping[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        temporary_path = Path(handle.name)
        for record in records:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    temporary_path.chmod(0o640)
    temporary_path.replace(path)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Create broad, US-only, description-complete public-board listings from jobs_prefilter.jsonl without LLM calls."
    )
    parser.add_argument(
        "--prefilter-path",
        default=str(LISTINGS_CONFIG.get("prefilter_path", "JobTailoring/JobExtractor/jobs_prefilter.jsonl")),
        help="Project-root-relative raw extractor JSONL.",
    )
    parser.add_argument(
        "--filtered-cache-path",
        default=str(LISTINGS_CONFIG.get("filtered_cache_path", "JobTailoring/JobExtractor/jobs_filtered.jsonl")),
        help="Optional candidate filtered cache used only to reuse existing descriptions.",
    )
    parser.add_argument(
        "--output-path",
        default=str(LISTINGS_CONFIG.get("output_path", "JobDiscoveryBoard/jobs_public_board.jsonl")),
        help="Project-root-relative public-board JSONL output.",
    )
    parser.add_argument(
        "--summary-path",
        default=str(LISTINGS_CONFIG.get("summary_path", "JobDiscoveryBoard/output/public_board_listings_summary.json")),
        help="Project-root-relative JSON summary output.",
    )
    parser.add_argument(
        "--posted-within-days",
        type=int,
        default=int(LISTINGS_CONFIG.get("posted_within_days", 7)),
        help="Keep listings posted within this many days, inclusive.",
    )
    parser.add_argument("--dry-run", action="store_true", help="Report counts without writing output files.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.posted_within_days < 0:
        raise SystemExit("--posted-within-days must be non-negative")

    prefilter_path = resolve_project_path(args.prefilter_path)
    filtered_cache_path = resolve_project_path(args.filtered_cache_path) if normalize_text(args.filtered_cache_path) else None
    output_path = resolve_project_path(args.output_path)
    summary_path = resolve_project_path(args.summary_path)
    if not prefilter_path.exists():
        raise SystemExit(f"Prefilter input not found: {prefilter_path}")

    records, summary = build_public_board_listings(
        prefilter_path,
        filtered_cache_path=filtered_cache_path,
        posted_within_days=args.posted_within_days,
    )
    summary["output_path"] = str(output_path)
    if not args.dry_run:
        write_jsonl(output_path, records)
        summary_path.parent.mkdir(parents=True, exist_ok=True)
        summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

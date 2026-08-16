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
import time
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple
from urllib.parse import urlsplit, urlunsplit

try:
    import requests
except ImportError:  # pragma: no cover - fetch step degrades to cache-only
    requests = None


SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from config_utils import load_project_config, resolve_project_path


PROJECT_CONFIG = load_project_config()
BOARD_CONFIG = PROJECT_CONFIG["public_job_board"]
LISTINGS_CONFIG = BOARD_CONFIG.get("listings") or {}

LISTINGS_VERSION = "public-board-listings-v1"
DESCRIPTION_FETCH_CONFIG = LISTINGS_CONFIG.get("description_fetch") or {}
# Public-board-only description fetching. The personal pipeline only downloads
# detail pages for titles it wants (role_targeting.yaml), so categories that the
# public board admits but the personal filter rejects (internships) would never
# get a description. This bounded fetcher fills exactly that gap and keeps its
# own cache so relevancy assessment inputs stay untouched.
DESCRIPTION_FETCH_FAMILIES = tuple(
    normalize
    for normalize in (str(value).strip().lower() for value in (DESCRIPTION_FETCH_CONFIG.get("families") or ["workday", "greenhouse"]))
    if normalize
)
# Only fetch for these PUBLIC title families (empty list = fetch for all).
# Scoped to internships on purpose: ~1,700 other in-window jobs also lack
# descriptions, and rescuing all of them is a deliberate board-size/GPU-cost
# decision, not a default.
DESCRIPTION_FETCH_TITLE_FAMILIES = tuple(
    str(value).strip().lower()
    for value in (DESCRIPTION_FETCH_CONFIG.get("only_title_families") if DESCRIPTION_FETCH_CONFIG.get("only_title_families") is not None else ["internships"])
    if str(value).strip()
)
FETCH_HEADERS = {
    "Accept": "application/json",
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0",
}
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

# The title policy has no in-code fallback ON PURPOSE. It lives only in
# config.yaml (public_job_board.listings.title_families / title_exclude_patterns);
# a missing or malformed policy fails the run loudly instead of silently
# reverting the board to a stale snapshot of the rules.


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
    if not isinstance(entries, list) or not entries:
        raise ValueError(
            "public_job_board.listings.title_families is missing or invalid in config.yaml; "
            "the title policy deliberately has no in-code fallback."
        )
    families = []
    for entry in entries:
        if not isinstance(entry, Mapping):
            continue
        family_id = normalize_text(entry.get("id"))
        patterns = compile_patterns(entry.get("patterns") or [])
        if family_id and patterns:
            families.append((family_id, patterns))
    if not families:
        raise ValueError("public_job_board.listings.title_families compiled to zero usable families.")
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


def resolve_description(
    record: Mapping[str, Any],
    description_cache: Mapping[str, Mapping[str, Any]],
    public_description_cache: Optional[Mapping[str, Mapping[str, Any]]] = None,
) -> Tuple[Optional[str], str, Any]:
    for identity in record_identity_keys(record):
        cached = description_cache.get(identity)
        if cached:
            return str(cached["job_description"]), "filtered_cache", cached.get("raw_detail")
    if public_description_cache:
        for identity in record_identity_keys(record):
            cached = public_description_cache.get(identity)
            if cached:
                return str(cached["job_description"]), "public_fetch_cache", cached.get("raw_detail")
    raw_description = description_from_raw_listing(record)
    if raw_description:
        return raw_description, "raw_listing", None
    return None, "", None


def load_public_description_cache(path: Optional[Path]) -> Tuple[Dict[str, Dict[str, Any]], set]:
    """Load the board's own fetched-description cache.

    Returns (positive, negative): positive maps identity keys to usable
    descriptions; negative is the set of identities whose detail page was
    fetched successfully but had no usable description (permanent skip, so a
    posting with an empty detail page is not re-fetched every run). Transient
    fetch errors are never cached, so they retry on the next run.
    """
    positive: Dict[str, Dict[str, Any]] = {}
    negative: set = set()
    if path is None or not path.exists():
        return positive, negative
    for record in iter_jsonl(path):
        identities = record_identity_keys(record)
        if normalize_text(record.get("description_status")) == "unusable":
            negative.update(identities)
            continue
        description = clean_html(record.get("job_description"))
        if not is_usable_description(description, record.get("title") or record.get("title_raw")):
            continue
        cached_value = {"job_description": description, "raw_detail": record.get("raw_detail")}
        for identity in identities:
            existing = positive.get(identity)
            if existing is None or len(description) > len(existing["job_description"]):
                positive[identity] = cached_value
    return positive, negative


def fetch_workday_description(record: Mapping[str, Any], http_get: Callable[[str], Any]) -> Optional[str]:
    """Workday CXS detail: swap the list endpoint's trailing /jobs for externalPath."""
    source = normalize_text(record.get("source_endpoint"))
    raw_listing = record.get("raw_listing") if isinstance(record.get("raw_listing"), Mapping) else {}
    external_path = normalize_text(raw_listing.get("externalPath"))
    if not source.endswith("/jobs") or not external_path.startswith("/"):
        return None
    payload = http_get(source[: -len("/jobs")] + external_path)
    if not isinstance(payload, Mapping):
        return None
    info = payload.get("jobPostingInfo")
    if not isinstance(info, Mapping):
        return None
    return clean_html(info.get("jobDescription"))


def fetch_greenhouse_description(record: Mapping[str, Any], http_get: Callable[[str], Any]) -> Optional[str]:
    """Greenhouse boards API detail: {list endpoint}/{job_id} -> content."""
    source = normalize_text(record.get("source_endpoint"))
    job_id = normalize_text(record.get("job_id"))
    if not source or not job_id:
        return None
    payload = http_get(f"{source.rstrip('/')}/{job_id}")
    if not isinstance(payload, Mapping):
        return None
    return clean_html(payload.get("content"))


DESCRIPTION_FETCHERS: Dict[str, Callable[[Mapping[str, Any], Callable[[str], Any]], Optional[str]]] = {
    "workday": fetch_workday_description,
    "greenhouse": fetch_greenhouse_description,
}


def make_http_get(timeout_seconds: float, delay_seconds: float) -> Callable[[str], Any]:
    if requests is None:
        raise RuntimeError("The requests library is required for description fetching.")
    session = requests.Session()
    session.headers.update(FETCH_HEADERS)

    def http_get(url: str) -> Any:
        if delay_seconds > 0:
            time.sleep(delay_seconds)
        response = session.get(url, timeout=timeout_seconds)
        response.raise_for_status()
        return response.json()

    return http_get


def public_cache_entry(record: Mapping[str, Any], description: str, detail_url_family: str, status: str) -> Dict[str, Any]:
    return {
        "family": record.get("family"),
        "company": record.get("company"),
        "source_endpoint": record.get("source_endpoint"),
        "absolute_url": record.get("absolute_url") or record.get("url"),
        "job_id": record.get("job_id"),
        "title": normalize_text(record.get("title_raw") or record.get("title")),
        "title_raw": record.get("title_raw"),
        "posted_on": record.get("posted_on_normalized"),
        "location": record.get("location_raw"),
        "job_description": description,
        "description_status": status,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "fetch_family": detail_url_family,
    }


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
    public_description_cache_path: Optional[Path] = None,
    max_description_fetches: int = 0,
    fetch_timeout_seconds: float = 20.0,
    fetch_delay_seconds: float = 0.5,
    http_get: Optional[Callable[[str], Any]] = None,
    write_description_cache: bool = True,
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """Return broad, US-only, description-complete board candidates and audit stats."""
    if posted_within_days < 0:
        raise ValueError("posted_within_days must be non-negative")
    today = reference_date or datetime.now(timezone.utc).date()
    cutoff = today - timedelta(days=posted_within_days)
    title_families = compile_title_families(title_family_entries if title_family_entries is not None else LISTINGS_CONFIG.get("title_families"))
    exclude_entries = exclusion_pattern_entries if exclusion_pattern_entries is not None else LISTINGS_CONFIG.get("title_exclude_patterns")
    if not isinstance(exclude_entries, list):
        raise ValueError(
            "public_job_board.listings.title_exclude_patterns is missing or invalid in config.yaml; "
            "use an explicit empty list to run without exclusions."
        )
    exclusion_patterns = compile_patterns(exclude_entries)
    description_cache = build_description_cache(filtered_cache_path)
    public_positive, public_negative = load_public_description_cache(public_description_cache_path)

    counts: Counter[str] = Counter()
    per_source_family: Counter[str] = Counter()
    per_title_family: Counter[str] = Counter()
    selected: Dict[str, Dict[str, Any]] = {}
    aliases_to_primary: Dict[str, str] = {}
    fetch_candidates: List[Tuple[Dict[str, Any], date, List[str]]] = []
    fetch_seen: set = set()

    def insert_candidate(candidate: Dict[str, Any], title_matches: Sequence[str]) -> None:
        identity_keys = record_identity_keys(candidate)
        existing_primary = next((aliases_to_primary[key] for key in identity_keys if key in aliases_to_primary), None)
        current = selected.get(existing_primary) if existing_primary else None
        if current is not None:
            counts["duplicate_candidates"] += 1
            if prefer_record(current, candidate):
                selected[existing_primary] = candidate
            for key in identity_keys:
                aliases_to_primary[key] = existing_primary
            return
        primary_identity = identity_keys[0]
        selected[primary_identity] = candidate
        for key in identity_keys:
            aliases_to_primary[key] = primary_identity
        counts["records_selected"] += 1
        per_source_family[normalize_text(candidate.get("family")) or "unknown"] += 1
        for title_family in title_matches:
            per_title_family[title_family] += 1

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
        description, description_source, raw_detail = resolve_description(record, description_cache, public_positive)
        if not description:
            family = normalize_text(record.get("family")).casefold()
            identities = record_identity_keys(record)
            fetchable = (
                max_description_fetches > 0
                and family in DESCRIPTION_FETCHERS
                and family in DESCRIPTION_FETCH_FAMILIES
                and (
                    not DESCRIPTION_FETCH_TITLE_FAMILIES
                    or any(title_family in DESCRIPTION_FETCH_TITLE_FAMILIES for title_family in title_matches)
                )
                and not any(key in public_negative for key in identities)
                and not any(key in fetch_seen for key in identities)
            )
            if fetchable:
                fetch_candidates.append((record, posted_on, title_matches))
                fetch_seen.update(identities)
            else:
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
        insert_candidate(candidate, title_matches)

    new_cache_entries: List[Dict[str, Any]] = []
    if fetch_candidates:
        if http_get is None and requests is None:
            counts["description_fetch_unavailable"] += len(fetch_candidates)
            counts["excluded_missing_usable_description"] += len(fetch_candidates)
            fetch_candidates = []
        budget = fetch_candidates[:max_description_fetches]
        overflow = len(fetch_candidates) - len(budget)
        if overflow:
            counts["description_fetch_skipped_budget"] += overflow
            counts["excluded_missing_usable_description"] += overflow
        getter = http_get or (make_http_get(fetch_timeout_seconds, fetch_delay_seconds) if budget else None)
        for record, posted_on, title_matches in budget:
            family = normalize_text(record.get("family")).casefold()
            counts["description_fetch_attempted"] += 1
            try:
                description = DESCRIPTION_FETCHERS[family](record, getter)
            except Exception as error:
                status_code = getattr(getattr(error, "response", None), "status_code", None)
                if status_code in (404, 410):
                    # The posting is gone; never try again.
                    counts["description_fetch_gone"] += 1
                    new_cache_entries.append(public_cache_entry(record, "", family, "unusable"))
                else:
                    # Transient (network/HTTP) failures are not cached; retried next run.
                    counts["description_fetch_failed"] += 1
                counts["excluded_missing_usable_description"] += 1
                continue
            if description and is_usable_description(description, record.get("title_raw") or record.get("title")):
                counts["description_fetch_succeeded"] += 1
                new_cache_entries.append(public_cache_entry(record, description, family, "usable"))
                insert_candidate(
                    public_record_from_prefilter(record, posted_on, title_matches, description, "public_fetch", None),
                    title_matches,
                )
            else:
                counts["description_fetch_unusable"] += 1
                counts["excluded_missing_usable_description"] += 1
                new_cache_entries.append(public_cache_entry(record, "", family, "unusable"))

    if new_cache_entries and write_description_cache and public_description_cache_path is not None:
        public_description_cache_path.parent.mkdir(parents=True, exist_ok=True)
        with public_description_cache_path.open("a", encoding="utf-8") as handle:
            for entry in new_cache_entries:
                handle.write(json.dumps(entry, ensure_ascii=False) + "\n")

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
        "public_description_cache_path": str(public_description_cache_path) if public_description_cache_path else None,
        "public_description_cache_records": len(public_positive),
        "max_description_fetches": max_description_fetches,
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
    parser.add_argument(
        "--public-description-cache-path",
        default=str(DESCRIPTION_FETCH_CONFIG.get("cache_path", "JobDiscoveryBoard/output/public_descriptions_cache.jsonl")),
        help="Board-only fetched-description cache. Kept separate from jobs_filtered.jsonl on purpose.",
    )
    parser.add_argument(
        "--max-description-fetches",
        type=int,
        default=int(DESCRIPTION_FETCH_CONFIG.get("max_fetches_per_run", 150)),
        help="Detail pages fetched per run for selected-but-descriptionless candidates. 0 disables fetching.",
    )
    parser.add_argument(
        "--fetch-timeout-seconds",
        type=float,
        default=float(DESCRIPTION_FETCH_CONFIG.get("timeout_seconds", 20)),
        help="Per-request timeout for description fetches.",
    )
    parser.add_argument(
        "--fetch-delay-seconds",
        type=float,
        default=float(DESCRIPTION_FETCH_CONFIG.get("delay_seconds", 0.5)),
        help="Politeness delay between description fetches.",
    )
    parser.add_argument("--dry-run", action="store_true", help="Report counts without writing output files or fetching.")
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
        public_description_cache_path=resolve_project_path(args.public_description_cache_path)
        if normalize_text(args.public_description_cache_path)
        else None,
        max_description_fetches=0 if args.dry_run else max(0, args.max_description_fetches),
        fetch_timeout_seconds=args.fetch_timeout_seconds,
        fetch_delay_seconds=args.fetch_delay_seconds,
        write_description_cache=not args.dry_run,
    )
    summary["output_path"] = str(output_path)
    if not args.dry_run:
        write_jsonl(output_path, records)
        summary_path.parent.mkdir(parents=True, exist_ok=True)
        summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

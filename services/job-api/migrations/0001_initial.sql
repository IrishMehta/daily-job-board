PRAGMA foreign_keys = ON;

-- Every publication is imported as an immutable dataset. The API switches the
-- active version only after an import has been validated, so readers never see
-- a partially refreshed board.
CREATE TABLE dataset_versions (
    version TEXT PRIMARY KEY,
    source_sha256 TEXT NOT NULL UNIQUE,
    source_schema_version TEXT NOT NULL,
    taxonomy_version TEXT NOT NULL,
    generated_at TEXT NOT NULL,
    imported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    total_openings INTEGER NOT NULL CHECK (total_openings >= 0),
    posted_within_days INTEGER NOT NULL CHECK (posted_within_days >= 0),
    taxonomy_json TEXT NOT NULL,
    career_buckets_json TEXT NOT NULL,
    authorization_categories_json TEXT NOT NULL,
    sponsorship_statuses_json TEXT NOT NULL
);

-- This singleton pointer is the atomic publication boundary.
CREATE TABLE api_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    active_dataset_version TEXT,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (active_dataset_version)
        REFERENCES dataset_versions(version)
        ON DELETE RESTRICT
);

INSERT INTO api_state (singleton, active_dataset_version) VALUES (1, NULL);

CREATE TABLE jobs (
    dataset_version TEXT NOT NULL,
    job_id TEXT NOT NULL,
    posted_on TEXT NOT NULL,
    company TEXT NOT NULL COLLATE NOCASE,
    title TEXT NOT NULL COLLATE NOCASE,
    location TEXT NOT NULL COLLATE NOCASE,
    location_label TEXT,
    city TEXT COLLATE NOCASE,
    region TEXT COLLATE NOCASE,
    region_code TEXT COLLATE NOCASE,
    country TEXT COLLATE NOCASE,
    country_code TEXT COLLATE NOCASE,
    location_search_terms_json TEXT NOT NULL,
    career_bucket TEXT NOT NULL,
    career_bucket_label TEXT NOT NULL,
    experience_level TEXT NOT NULL,
    experience_level_label TEXT NOT NULL,
    yoe_min REAL,
    yoe_max REAL,
    experience_display TEXT NOT NULL,
    authorization_category TEXT NOT NULL,
    authorization_category_label TEXT NOT NULL,
    sponsorship_status TEXT NOT NULL,
    work_authorization_display TEXT NOT NULL,
    summary TEXT NOT NULL,
    description_excerpt TEXT NOT NULL,
    match_terms_json TEXT NOT NULL,
    classification_paths_json TEXT NOT NULL,
    job_link TEXT NOT NULL,
    search_text TEXT NOT NULL,
    PRIMARY KEY (dataset_version, job_id),
    UNIQUE (dataset_version, job_link),
    FOREIGN KEY (dataset_version)
        REFERENCES dataset_versions(version)
        ON DELETE CASCADE,
    CHECK (yoe_min IS NULL OR yoe_min >= 0),
    CHECK (yoe_max IS NULL OR yoe_max >= 0),
    CHECK (yoe_min IS NULL OR yoe_max IS NULL OR yoe_max >= yoe_min)
);

-- A job can have multiple domain/industry paths. Keeping these paths normalized
-- makes filtering deterministic without parsing JSON during every request.
CREATE TABLE job_classifications (
    dataset_version TEXT NOT NULL,
    job_id TEXT NOT NULL,
    path_index INTEGER NOT NULL CHECK (path_index >= 0),
    domain TEXT NOT NULL,
    industry TEXT,
    confidence TEXT NOT NULL,
    PRIMARY KEY (dataset_version, job_id, path_index),
    FOREIGN KEY (dataset_version, job_id)
        REFERENCES jobs(dataset_version, job_id)
        ON DELETE CASCADE
);

CREATE TABLE job_specializations (
    dataset_version TEXT NOT NULL,
    job_id TEXT NOT NULL,
    path_index INTEGER NOT NULL,
    specialization TEXT NOT NULL,
    PRIMARY KEY (dataset_version, job_id, path_index, specialization),
    FOREIGN KEY (dataset_version, job_id, path_index)
        REFERENCES job_classifications(dataset_version, job_id, path_index)
        ON DELETE CASCADE
);

CREATE INDEX idx_jobs_posted
    ON jobs(dataset_version, posted_on DESC, job_id);
CREATE INDEX idx_jobs_career_bucket
    ON jobs(dataset_version, career_bucket, posted_on DESC);
CREATE INDEX idx_jobs_experience_level
    ON jobs(dataset_version, experience_level, posted_on DESC);
CREATE INDEX idx_jobs_authorization
    ON jobs(dataset_version, authorization_category, posted_on DESC);
CREATE INDEX idx_jobs_sponsorship
    ON jobs(dataset_version, sponsorship_status, posted_on DESC);
CREATE INDEX idx_jobs_region
    ON jobs(dataset_version, region_code, posted_on DESC);
CREATE INDEX idx_jobs_company
    ON jobs(dataset_version, company, posted_on DESC);
CREATE INDEX idx_classifications_domain
    ON job_classifications(dataset_version, domain, job_id);
CREATE INDEX idx_classifications_industry
    ON job_classifications(dataset_version, industry, job_id);
CREATE INDEX idx_specializations_value
    ON job_specializations(dataset_version, specialization, job_id);

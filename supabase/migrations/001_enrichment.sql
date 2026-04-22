-- Migration 001 — enrichment foundation
-- Run in Supabase SQL editor against the existing prod database.
-- Idempotent: safe to re-run.

-- 1. Cache table for firm-level enrichment
CREATE TABLE IF NOT EXISTS enriched_organizations (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  normalized_name TEXT NOT NULL UNIQUE,
  display_name    TEXT NOT NULL,
  org_type        TEXT,

  apollo_id       TEXT,
  website         TEXT,
  hq_city         TEXT,
  hq_state        TEXT,
  employee_count  INTEGER,
  industry        TEXT,
  founded_year    INTEGER,
  linkedin_url    TEXT,

  recent_projects JSONB,
  decision_makers JSONB,
  notes           TEXT,

  source          TEXT DEFAULT 'apollo',
  raw_payload     JSONB,
  enriched_at     TIMESTAMPTZ DEFAULT NOW(),
  expires_at      TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '30 days'),

  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_enriched_orgs_normalized ON enriched_organizations(normalized_name);
CREATE INDEX IF NOT EXISTS idx_enriched_orgs_expires ON enriched_organizations(expires_at);

-- 2. Link contacts back to their cached org
ALTER TABLE lead_contacts ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES enriched_organizations(id) ON DELETE SET NULL;

-- 3. Per-lead enrichment status so the agent doesn't re-enrich on every run
ALTER TABLE leads ADD COLUMN IF NOT EXISTS enriched_at TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS enrichment_status TEXT;  -- 'pending' | 'done' | 'skipped' | 'failed'

-- 4. Auto-update updated_at on the new table
CREATE TRIGGER enriched_orgs_updated_at
  BEFORE UPDATE ON enriched_organizations
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

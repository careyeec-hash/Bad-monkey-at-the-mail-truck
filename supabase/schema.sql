-- supabase/schema.sql
-- Bad Monkey At The Mail Truck — database schema
-- Run this in the Supabase SQL editor to create all tables and indexes.

-- ============================================
-- LEADS — core lead records
-- ============================================
CREATE TABLE leads (
  id            TEXT PRIMARY KEY,           -- "lead-2026-03-12-001"
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  first_seen_at TIMESTAMPTZ DEFAULT NOW(), -- when agent first discovered this lead (for accumulation tracking)

  -- Project info
  project_name  TEXT NOT NULL,
  address       TEXT NOT NULL,
  normalized_address TEXT NOT NULL,         -- for dedup matching
  project_type  TEXT,                       -- multifamily, commercial, etc.
  estimated_value TEXT,                     -- "$25M-35M" (freeform)
  stage         TEXT,                       -- planning, entitled, permitted, etc.
  gc_assigned   BOOLEAN DEFAULT FALSE,
  gc_name       TEXT,
  permit_number TEXT,

  -- Source info
  source_type   TEXT NOT NULL,              -- agent, manual, referral
  source_name   TEXT,                       -- "City of Phoenix Permits"
  source_category TEXT,                     -- permit, rfp, project, news, etc.
  source_url    TEXT,
  briefing_date DATE,
  referral_from TEXT,                       -- Client Advocate name if referral

  -- Scoring (from Opus evaluation)
  actionability_score INTEGER,              -- 1-10
  bristlecone_fit TEXT,                     -- strong-fit, possible-fit, etc.
  fit_type      TEXT,                       -- gc-scope, concrete-scope, both
  action_item   TEXT,
  why_it_matters TEXT,
  enrichment_needed TEXT[],                 -- array of needed enrichment types

  -- Pursuit tracking
  status        TEXT DEFAULT 'new',         -- new, tracking, pursuing, won, lost, no-bid, dismissed, stale
  assigned_to   TEXT DEFAULT 'Tom Keilty',
  priority      TEXT DEFAULT 'medium',      -- high, medium, low
  next_action   TEXT,
  next_action_date DATE,
  bid_due_date  DATE,
  estimated_start_date DATE,               -- Tom's estimate for cash flow forecasting
  contract_value TEXT,
  lost_to       TEXT,                       -- competitor name
  lost_reason   TEXT,

  -- Metadata
  profile       TEXT DEFAULT 'bristlecone',
  tags          TEXT[]
);

-- Index for common queries
CREATE INDEX idx_leads_status ON leads(status);
CREATE INDEX idx_leads_profile ON leads(profile);
CREATE INDEX idx_leads_normalized_address ON leads(normalized_address);
CREATE INDEX idx_leads_score ON leads(actionability_score DESC);
CREATE INDEX idx_leads_created ON leads(created_at DESC);
CREATE INDEX idx_leads_updated ON leads(updated_at DESC);

-- ============================================
-- LEAD_CONTACTS — people associated with leads
-- ============================================
CREATE TABLE lead_contacts (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  lead_id       TEXT REFERENCES leads(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  company       TEXT,
  role          TEXT,                       -- Developer, Architect, GC, Owner, etc.
  phone         TEXT,
  email         TEXT,
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_contacts_lead ON lead_contacts(lead_id);

-- ============================================
-- LEAD_NOTES — activity log / notes on leads
-- ============================================
CREATE TABLE lead_notes (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  lead_id       TEXT REFERENCES leads(id) ON DELETE CASCADE,
  author        TEXT NOT NULL,              -- "agent", "Tom Keilty", etc.
  text          TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_notes_lead ON lead_notes(lead_id);
CREATE INDEX idx_notes_created ON lead_notes(created_at DESC);

-- ============================================
-- AGENT_UPDATES — when the agent finds new info about an existing lead
-- ============================================
CREATE TABLE agent_updates (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  lead_id       TEXT REFERENCES leads(id) ON DELETE CASCADE,
  briefing_date DATE,
  update_text   TEXT NOT NULL,
  source_url    TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_updates_lead ON agent_updates(lead_id);

-- ============================================
-- SEEN_ITEMS — dedup tracking
-- ============================================
CREATE TABLE seen_items (
  url           TEXT PRIMARY KEY,
  first_seen    TIMESTAMPTZ DEFAULT NOW(),
  source_name   TEXT
);

-- ============================================
-- AGENT_RUNS — run history
-- ============================================
CREATE TABLE agent_runs (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  run_date        TIMESTAMPTZ DEFAULT NOW(),
  profile         TEXT,
  items_ingested  INTEGER,
  items_filtered  INTEGER,
  items_evaluated INTEGER,
  hot_leads       INTEGER,
  watch_list      INTEGER,
  leads_created   INTEGER,
  leads_updated   INTEGER,
  publish_success BOOLEAN,
  email_sent      TEXT,                     -- "weekly", "urgent", "none"
  sources_checked INTEGER,
  sources_failed  INTEGER,
  failures        JSONB,                    -- [{ source, error }]
  abp_status      JSONB,                    -- per-city success/failure
  estimated_cost  DECIMAL(6,4)
);

-- ============================================
-- SOURCE_HEALTH — per-source tracking
-- ============================================
CREATE TABLE source_health (
  source_name          TEXT PRIMARY KEY,
  last_success         TIMESTAMPTZ,
  consecutive_failures INTEGER DEFAULT 0,
  last_error           TEXT,
  items_last_returned  INTEGER,
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- Auto-update updated_at on leads
-- ============================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER leads_updated_at
  BEFORE UPDATE ON leads
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- ============================================
-- MIGRATION: Add first_seen_at to existing databases
-- Run this if upgrading from a schema that predates lead accumulation tracking:
--
--   ALTER TABLE leads ADD COLUMN first_seen_at TIMESTAMPTZ DEFAULT NOW();
--   UPDATE leads SET first_seen_at = created_at WHERE first_seen_at IS NULL;
-- ============================================

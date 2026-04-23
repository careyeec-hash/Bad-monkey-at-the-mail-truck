-- Migration 002 — lead_contacts entity_type
-- Adds a column so a single lead_contacts row can represent either a
-- person or an organization (firm tracked without a specific person).
-- Run in Supabase SQL editor. Idempotent.

ALTER TABLE lead_contacts
  ADD COLUMN IF NOT EXISTS entity_type TEXT DEFAULT 'person';

-- Backfill anything currently NULL to 'person' (existing rows were all people).
UPDATE lead_contacts SET entity_type = 'person' WHERE entity_type IS NULL;

CREATE INDEX IF NOT EXISTS idx_contacts_entity_type ON lead_contacts(entity_type);

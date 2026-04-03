# Lessons Learned — ConXtech Project Finder

> A reference document for carrying hard-won knowledge into the next lead finder project.
> Generated 2026-04-03 from git history analysis, codebase review, and operational experience.

---

## Table of Contents

1. [Mistakes to Never Repeat](#part-1-mistakes-to-never-repeat)
2. [Patterns That Worked](#part-2-patterns-that-worked)
3. [How to Apply This to Your Next Project](#part-3-how-to-apply-this-to-your-next-project)
4. [Quick Reference: Error Patterns](#quick-reference-error-patterns-to-watch-for)

---

## Part 1: Mistakes to Never Repeat

### 1. Dedup Logic Must Understand Source Behavior

| | |
|---|---|
| **What happened** | Applied uniform URL-based dedup with TTL to all sources. Snapshot sources (HCAI healthcare DB, university capital plans) return the *same projects every query* — the 30-day TTL blocked them after the first scan, producing **zero healthcare leads for a full week** before anyone noticed. |
| **Fix** | Bypass dedup entirely for snapshot-type sources; re-score every run. (`agent/ingest.js` — snapshot category pass-through) |
| **Rule** | Classify every data source as **time-series** (new items appear over time) vs **snapshot** (same dataset refreshed). Apply dedup only to time-series. Tag this in source config from day one. |

### 2. Every Scraper Will Have Unique Field-Mapping Bugs

| | |
|---|---|
| **What happened** | SF `estimated_cost` is a text field (not numeric). Boston `declared_valuation` has `$` and `,`. Philly has no valuation field at all. NYC changed its entire dataset mid-project. Each city's API broke in a different, unpredictable way. Multiple separate commits fixed field-name mapping for SF, Seattle, Austin, and NYC. |
| **Fix** | Per-source mappers with explicit field handling, `parseCurrency()` utility for Boston. |
| **Rule** | Never assume two APIs share a schema. Build a **per-source integration test** that hits the live API and validates field names + types. Run these tests before the first real pipeline run *and* on a weekly health-check schedule. |

### 3. External I/O Without Timeouts = Pipeline Death

| | |
|---|---|
| **What happened** | Sequentially fetching 100+ RSS articles caused CI timeouts. The entire pipeline hung waiting for one slow feed. |
| **Fix** | Parallelized fetching with `Promise.allSettled()`, added 30s per-feed hard timeout, capped to 10 articles per feed. |
| **Rule** | Every external HTTP call needs: (a) an explicit timeout (30s max), (b) parallel execution via `Promise.allSettled()` — not `Promise.all`, because one failure shouldn't kill the batch, (c) a cap on items fetched per source. |

### 4. Don't Mix Git Publishing Mechanisms

| | |
|---|---|
| **What happened** | `publish.js` used the GitHub API to create commits. GitHub Actions *also* committed. This caused local/remote divergence — the repo got into a state where local and remote had different commit histories. |
| **Fix** | Detect CI environment → skip API-based publish → let the workflow handle git. |
| **Rule** | Pick ONE publishing mechanism. If using CI (GitHub Actions), let the workflow do all git operations. Never have application code AND CI both committing. |

### 5. State Files Grow Unbounded

| | |
|---|---|
| **What happened** | `seen-items.json` accumulates every URL ever seen, with no cleanup. Over months this slows JSON parsing and bloats the repo. |
| **Rule** | Every state file needs an expiration policy from day one. Archive entries older than 90 days to a separate file, or use a lightweight DB (SQLite) instead of JSON for state that grows. |

### 6. Lead Overwrite vs. Accumulation

| | |
|---|---|
| **What happened** | Initially, each daily run overwrote `leads-latest.json` — all previous leads disappeared. The BD team expected persistence. Had to retrofit a merge system with `_firstSeen`, `_lastUpdated`, `_isNew` metadata and 90-day auto-purge. |
| **Rule** | Design for **lead accumulation** from the start. New runs merge with the existing lead set. Track first-seen date, last-updated date, and score history. Auto-purge based on age + score threshold. |

### 7. .env Path Assumptions Break in CI

| | |
|---|---|
| **What happened** | `run.js` loaded `.env` from `process.cwd()` instead of relative to the agent directory. Worked locally, broke in CI where cwd was the repo root. |
| **Rule** | Always resolve `.env` path relative to `__dirname` (or `import.meta.dirname`). Never rely on `process.cwd()`. |

### 8. Scoring Needs Calibration Examples (Few-Shot)

| | |
|---|---|
| **What happened** | Opus was under-scoring leads. A Kaiser Permanente project with DPR as GC was getting a 6 instead of 9+. Added few-shot examples and hard-coded score floors (Kaiser = 8+, data center = 7+). |
| **Impact** | Lead volume jumped from **0 hot leads to 14 hot leads**. |
| **Rule** | Never ship an LLM scoring system without calibration examples in the prompt. Include 3-5 "anchor" examples showing what a 9, a 7, and a 4 look like. Add score floors for known high-value patterns. |

### 9. Pre-filter Thresholds Started Too Conservative

| | |
|---|---|
| **What happened** | Initial permit valuation threshold was $1M, which filtered out real steel projects. Lowered to $500K. Also missed projects because construction type codes weren't being inferred (Type I/II = steel frame). |
| **Impact** | Lead count jumped from **8 to 31** after tuning. |
| **Rule** | Start with **loose** pre-filters and tighten based on data. The pre-filter (cheap Haiku pass) should be permissive; the evaluation (expensive Opus pass) should be selective. False negatives at the pre-filter stage are invisible and expensive. |

### 10. Status Tracking Keyed by Title Is Fragile

| | |
|---|---|
| **What happened** | `lead-status.json` uses lead title as the lookup key. If the agent re-scores a lead and the title changes slightly, the status lookup fails — all notes, assignee data, and progression history get orphaned. |
| **Rule** | Key status tracking by a **stable ID** (`sha256(url)` or composite key), never by title or display text. |

---

## Part 2: Patterns That Worked

### 1. Two-Tier LLM Architecture (Cheap Filter + Expensive Scorer)

- **Haiku pre-filter:** ~$0.10/run, batches of 30, fast classification
- **Opus evaluation:** ~$2-5/run, batches of 12, deep scoring with weighted dimensions
- **Why it works:** 90% of items are obvious non-matches. Spending $0.001 to filter them out saves $0.50+ in Opus costs per item.
- **Carry forward:** Always have a cheap fast pass before an expensive deep pass.

### 2. Conservative Error Handling: Keep on Failure

- **Pre-filter:** If Haiku API fails, **keep the entire batch** (don't drop leads).
- **Evaluate:** If Opus fails, create stub leads with `score=0` and `_evaluationError` flag for manual review.
- **Why it works:** For lead gen, false negatives (missing a real lead) cost more than false positives (reviewing a bad lead). The pipeline never silently drops data.
- **Carry forward:** On any classification failure, default to "include and flag," not "exclude."

### 3. `Promise.allSettled()` for Multi-Source Ingestion

- All 15+ sources run in parallel; one source failure doesn't crash the pipeline.
- Per-source error logging with pass/fail counts in run metadata.
- **Carry forward:** Always use `allSettled` for multi-source fetching. Log per-source diagnostics.

### 4. Config-Driven Source Definitions

- `sources.json` defines each source with: name, type, module path, phase, region, category.
- Adding a new city = write a scraper file + add one entry in `sources.json`.
- **Carry forward:** Every source should be a config entry + a module. No hardcoded source lists in orchestration code.

### 5. Scoring Profile as JSON (Not Hardcoded)

- `profiles/conxtech.json` contains: target regions, project types, scoring weights, known GCs, known owners.
- Changing scoring criteria = edit JSON, no code changes needed.
- **Carry forward:** Externalize the "what are we looking for" definition into a profile JSON that feeds the LLM system prompt.

### 6. Run History with Per-Stage Metrics

- `run-history.json` logs each run: timestamp, items ingested, items filtered, items scored, errors, per-source counts.
- 90-day rolling window for automatic cleanup.
- **Carry forward:** Log every pipeline run with stage-by-stage counts. This is how you detect silent failures (e.g., a source returning 0 items when it usually returns 20).

### 7. Phase-Based Source Activation

- Sources tagged with `phase: 1`, `phase: 2`, etc.
- Pipeline accepts `--phase` flag to run only Phase 1 sources during development.
- **Carry forward:** Tag sources by phase so you can develop incrementally and debug with a fast subset.

---

## Part 3: How to Apply This to Your Next Project

### Step 1: Before Writing Code — Source Audit

For each data source you plan to ingest:

- [ ] Classify as **time-series** or **snapshot**
- [ ] Hit the live endpoint and document the actual API field names (don't trust docs)
- [ ] Note data quirks: text-vs-numeric fields, currency formatting, missing fields
- [ ] Test: does the URL/ID remain stable across queries?
- [ ] Determine rate limits and timeout behavior
- [ ] Record expected item counts (baseline for health monitoring)

### Step 2: Scaffold the Pipeline with These Defaults Baked In

```
agent/
  sources.json              ← config-driven source list with type/phase/category/sourceType
  profiles/{client}.json    ← scoring criteria, weights, known partners, few-shot examples
  data/seen-items.json      ← dedup state WITH expiration policy (90 days)
  data/run-history.json     ← per-run metrics with rolling window
  scrapers/                 ← one module per source
```

Pipeline stages (same 7-stage pattern, with guardrails pre-installed):

| Stage | Key Defaults |
|-------|-------------|
| **1. Ingest** | `Promise.allSettled()`, per-source timeout (30s), per-source diagnostics |
| **2. Dedup** | Source-type-aware (skip for snapshots), stable key (`sha256(url)`), 90-day expiration |
| **3. Pre-filter** | Cheap model (Haiku), batches of 25-30, **permissive** thresholds, keep-on-failure |
| **4. Evaluate** | Expensive model (Opus/Sonnet), batches of 10-12, few-shot calibration, score floors |
| **5. Generate** | **Merge** with cumulative leads (not overwrite), track `_firstSeen` / `_lastUpdated` / `_isNew` |
| **6. Publish** | Single mechanism only (CI workflow OR app code, never both) |
| **7. Update state** | Dedup log with pruning, run history, lead status |

### Step 3: Build These Guardrails from Day One

1. **Per-source integration tests** — Hit each live API, validate field names exist and types match
2. **Source health monitoring** — If a source returns 0 items when historical average is 15+, flag it in run history
3. **State file expiration** — Prune dedup entries older than 90 days on every run
4. **Stable lead IDs** — Use `sha256(url)` or `sha256(source + ":" + title)` for status tracking keys
5. **`.env` path resolution** — Always `path.resolve(__dirname, '.env')`, never rely on cwd
6. **LLM response parsing** — Strip markdown fences → `JSON.parse()` → regex fallback. Log raw response on parse failure.

### Step 4: Scoring System Checklist

- [ ] Define 3-5 weighted scoring dimensions in the profile JSON
- [ ] Write 3-5 **few-shot calibration examples** (what does a 9 look like? a 5? a 3?)
- [ ] Add **score floors** for known high-value patterns (e.g., "if owner = [key account] AND region = [home market], score >= 8")
- [ ] Start pre-filter thresholds **LOOSE**, tighten based on actual data
- [ ] Log score distributions per run so you can detect drift over time

### Step 5: Dashboard Data Contract

- [ ] Define the JSON schema for leads **BEFORE** building the dashboard
- [ ] Lead accumulation from day one (merge, don't overwrite)
- [ ] Status tracking keyed by **stable ID**, not display title
- [ ] Separate concerns: agent writes `leads-latest.json`, humans write `lead-status.json`
- [ ] Define the conflict rule: if agent re-scores a lead higher but user marked it "dead," what wins?

### Step 6: Operational Readiness

- [ ] Run history with per-stage item counts (detect silent failures)
- [ ] Source health checks (expected vs actual item counts per source)
- [ ] API key / token expiration monitoring (GITHUB_PAT, ANTHROPIC_API_KEY, etc.)
- [ ] Document the "How do I add a new source?" workflow (should be: write scraper module + add config entry)
- [ ] Document the "How do I change scoring criteria?" workflow (should be: edit profile JSON)

---

## Quick Reference: Error Patterns to Watch For

| Pattern | Symptom | Root Cause | Prevention |
|---------|---------|------------|------------|
| Source returns 0 items | Lead count drops suddenly | API field name changed or rate limited | Per-source integration tests + health monitoring |
| Dedup blocks everything | Known projects stop appearing | Snapshot source treated as time-series | Source-type-aware dedup in config |
| Scores cluster low | No hot leads despite good data | Missing few-shot calibration examples | Few-shot anchoring + score floors |
| Pipeline timeout | CI job killed mid-run | Sequential external fetches | `Promise.allSettled()` + per-call timeout |
| Status data orphaned | Notes/assignee disappear | Lead title changed between runs | Stable ID keys (URL hash) |
| State file bloat | Slow pipeline startup | No expiration on seen-items.json | 90-day prune on every run |
| Local/remote git diverge | Push fails, history conflicts | Two systems both committing | Single publishing mechanism |
| LLM response parse failure | Leads silently dropped | Model returns markdown-wrapped JSON | Strip fences → JSON.parse → regex fallback |
| Pre-filter too aggressive | Real leads never reach scoring | Thresholds set too high at launch | Start loose, tighten with data |
| .env not found in CI | Pipeline crashes on first run | Path resolved relative to cwd | `path.resolve(__dirname, '.env')` |

---

## The One-Paragraph Summary

The ConXtech Project Finder's core architecture (7-stage pipeline, two-tier LLM scoring, config-driven sources) was sound from day one. **80% of the debugging effort was in data source quirks and dedup edge cases**, not in the pipeline logic itself. The three biggest wins came from: **(1)** making the pre-filter more permissive (8 leads → 31), **(2)** adding few-shot scoring calibration (0 hot → 14 hot), and **(3)** switching from lead overwrite to lead accumulation. Start your next project with those three patterns already in place, and you'll skip weeks of debugging.

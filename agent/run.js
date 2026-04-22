// MUST be the very first import. Loads .env before any sibling import causes
// a module to instantiate `new Anthropic()` at top-level. ES imports are
// hoisted and run in source order, so a `config()` function call placed AFTER
// `import ingest from './ingest.js'` would execute too late: prefilter.js,
// evaluate.js, and planning-agendas.js would already have built their clients
// against an empty process.env.ANTHROPIC_API_KEY. See load-env.js for details.
import './load-env.js'

import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Validate required env vars before doing anything
const REQUIRED_ENV = ['ANTHROPIC_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY']
const missing = REQUIRED_ENV.filter(key => !process.env[key])
if (missing.length > 0) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`)
  console.error(`Ensure agent/.env exists and contains these keys.`)
  process.exit(1)
}

import ingest from './ingest.js'
import prefilter from './prefilter.js'
import evaluate from './evaluate.js'
import { processLeads, logAgentRun } from './crm.js'
import enrich from './enrich.js'
import { generateBriefing, generateWeeklyEmail, generateUrgentAlert } from './generate.js'
import publish from './publish.js'
import { sendDigestEmail, sendUrgentAlert } from './email.js'

// Bad Monkey At The Mail Truck — Daily Agent Pipeline
// Runs daily at 6 AM MST via cron
//
// Pipeline: Ingest → Dedup → Pre-filter (Haiku) → Evaluate (Opus) →
//           CRM Update → Enrich (score >= threshold) → Generate Briefing →
//           Publish → Email → Log

async function main() {
  const startTime = Date.now()
  const profileName = process.env.PROFILE || 'bristlecone'
  const profilePath = join(__dirname, 'profiles', `${profileName}.json`)
  const profile = JSON.parse(readFileSync(profilePath, 'utf-8'))

  console.log(`\n=== Bad Monkey Agent Run ===`)
  console.log(`Profile: ${profileName} (${profile.profileName})`)
  console.log(`Time: ${new Date().toISOString()}`)
  console.log(`===========================\n`)

  // Step 1: Ingest from all active sources
  const { items, sourcesChecked, sourcesFailed, failures } = await ingest()
  console.log(`\nIngested ${items.length} new items from ${sourcesChecked} sources`)

  // Step 2: Pre-filter with Haiku (drops non-construction noise)
  const filtered = await prefilter(items)
  console.log(`Filtered to ${filtered.length} construction-relevant items`)

  // Step 3: Evaluate with Opus (score through Bristlecone profile)
  const evaluated = await evaluate(filtered, profileName)

  // Step 4: Update CRM — create/update leads in Supabase
  const { created, updated } = await processLeads(evaluated, profile)

  // Step 4.5: Auto-enrich high-priority leads (score >= profile.enrichmentThreshold)
  // Pulls developer/architect intel + decision-maker contacts from Apollo,
  // detects warm-intro angles from CRM history, rewrites action_item with
  // concrete names + numbers. Runs on the persisted lead rows so it covers
  // both new leads from this run and any prior leads that scored up to 8+
  // via accumulation. Skipped silently if APOLLO_API_KEY is not set.
  const enrichResult = await enrich(profile)

  // Step 5: Generate daily briefing Markdown
  const stats = {
    sourcesChecked, sourcesFailed, failures,
    itemsIngested: items.length,
    itemsFiltered: filtered.length
  }
  const briefing = await generateBriefing(evaluated, stats)

  // Step 6: Publish briefing to GitHub → triggers Vercel deploy
  const publishSuccess = await publish(briefing.markdown, briefing.date)

  // Step 7: Email — weekly digest (Friday) + urgent alerts (any day)
  const weeklyEmail = await generateWeeklyEmail(evaluated, profile)
  const emailSent = await sendDigestEmail(weeklyEmail)

  const urgentAlert = generateUrgentAlert(evaluated, profile)
  if (urgentAlert) {
    await sendUrgentAlert(urgentAlert)
  }

  // Step 8: Log the run
  const hotLeads = evaluated.filter(i => i.actionability_score >= 8).length
  const watchList = evaluated.filter(i => i.actionability_score >= 5 && i.actionability_score < 8).length

  await logAgentRun({
    profile: profileName,
    itemsIngested: items.length,
    itemsFiltered: filtered.length,
    itemsEvaluated: evaluated.length,
    hotLeads,
    watchList,
    leadsCreated: created,
    leadsUpdated: updated,
    publishSuccess,
    emailSent,
    sourcesChecked,
    sourcesFailed,
    failures,
    estimatedCost: estimateCost(filtered.length, evaluated.length, enrichResult?.enriched || 0)
  })

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log(`\n=== Agent run complete in ${elapsed}s ===`)
  console.log(`  Items: ${items.length} ingested → ${filtered.length} filtered → ${evaluated.length} evaluated`)
  console.log(`  Leads: ${created} created, ${updated} updated`)
  console.log(`  Hot: ${hotLeads}, Watch: ${watchList}`)
  console.log(`  Enriched: ${enrichResult?.enriched || 0} (${enrichResult?.failed || 0} failed)`)
  console.log(`  Published: ${publishSuccess}, Email: ${emailSent}`)
}

function estimateCost(filteredCount, evaluatedCount, enrichedCount = 0) {
  // Rough cost estimate per run
  // Haiku pre-filter: ~$0.001 per item
  // Opus evaluation: ~$0.03 per item
  // Enrichment per lead: Haiku extract (~$0.002) + Opus synthesis (~$0.015) ≈ $0.02
  // Apollo credits aren't included — those bill separately on the Apollo plan.
  const haikuCost = filteredCount * 0.001
  const opusCost = evaluatedCount * 0.03
  const enrichCost = enrichedCount * 0.02
  return parseFloat((haikuCost + opusCost + enrichCost).toFixed(4))
}

main().catch(err => {
  console.error('Agent run failed:', err)
  process.exit(1)
})

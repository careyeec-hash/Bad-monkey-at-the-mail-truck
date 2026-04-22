// Pre-filter module — cheap Haiku pass to drop irrelevant items
// Permit/ABP items skip filtering (construction by definition)
// RSS/news items go through Haiku binary classification

import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic()

const SYSTEM_PROMPT = `You are a construction lead classifier for the Arizona market. Bias toward KEEPING items that have any construction/development signal — Tom prefers to see 50 leads and quickly filter the 1-2 worth pursuing rather than miss something. Drop only the clearly irrelevant.

KEEP if the item touches ANY of these:
- A specific named project, address, developer, owner, architect, or GC in Arizona
- A construction RFP, bid solicitation, permit filing, planning/zoning case
- A developer announcing activity, expansion, land purchase, or pipeline (even without a named project — developer signals matter)
- A GC win, hire, expansion, acquisition, or capacity signal in Arizona (competitor intel is valuable)
- Economic development that will drive construction: relocations, expansions, facilities, data centers, manufacturing plants, semiconductor fabs
- Architecture firm news: project wins, hires, relocations, mergers (architects are one of Tom's three BD categories)
- Adaptive reuse, redevelopment, or repositioning of existing buildings (these ARE construction projects)
- Distressed, stalled, foreclosed, or "back on the market" projects
- Major real estate transactions where the buyer has known development plans
- Submarket activity reports for Tom's target corridors (Downtown PHX, Camelback, Tempe Town Lake, Scottsdale Airpark, I-17 industrial, West Valley)
- Capital markets news where the financing is tied to a specific build (construction loan closings, EB-5 raises for projects)
- TSMC, Intel, semiconductor, or large-employer expansion news (drives downstream construction demand)

DROP only the clearly irrelevant:
- Industry statistics, employment data, wage reports, market indices with no project anchor (e.g. "national construction employment up 26K")
- "Top 5 / Best of / Year in Review" roundups that don't name specific buildable projects
- Leasing announcements for ALREADY-COMPLETED buildings with no expansion/Phase 2 (e.g. "Park303 100% leased — Glendale" where the building already exists and is fully built)
- Single-family residential (unless 50+ unit subdivision or master-planned community)
- National news with zero Arizona connection
- Restaurant menu launches, retail tenant move-ins to EXISTING spaces
- Opinion pieces, op-eds, columnist takes with no project specifics
- Events, conferences, awards galas, ribbon cuttings on long-completed work
- Pure forecast / outlook / sentiment articles with no specific project, developer, or build mentioned

When in doubt: KEEP. Opus will score it appropriately downstream. The cost of a marginal item reaching Opus is small; the cost of missing a real lead is high.

For each item: { "url": string, "keep": boolean, "reason": string (max 10 words) }
Respond as a JSON array. No markdown fences.`

// Types that skip pre-filtering — already construction-relevant
const SKIP_TYPES = new Set(['permit', 'rfp', 'planning'])

const BATCH_SIZE = 30

async function classifyBatch(items) {
  const itemSummaries = items.map(item => ({
    url: item.url,
    title: item.title,
    summary: item.summary?.slice(0, 300) || ''
  }))

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: JSON.stringify(itemSummaries)
    }]
  })

  let text = message.content[0].text
  // Strip markdown fences if present
  text = text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim()
  try {
    return JSON.parse(text)
  } catch {
    console.log('  [Pre-filter] Warning: could not parse Haiku response, keeping all items')
    console.log('  [Pre-filter] Raw response:', text.slice(0, 200))
    return items.map(i => ({ url: i.url, keep: true, reason: 'parse-error-fallback' }))
  }
}

export default async function prefilter(items) {
  console.log('\n--- PRE-FILTER PHASE ---')

  if (items.length === 0) {
    console.log('  No items to filter')
    return []
  }

  // Split into items that skip filtering vs items that need Haiku
  const passThrough = items.filter(i => SKIP_TYPES.has(i.type))
  const needsFilter = items.filter(i => !SKIP_TYPES.has(i.type))

  console.log(`  ${passThrough.length} permits/RFPs/planning (auto-keep), ${needsFilter.length} news items to classify`)

  if (needsFilter.length === 0) {
    return passThrough
  }

  // Batch items and send to Haiku
  const kept = [...passThrough]
  let totalDropped = 0

  for (let i = 0; i < needsFilter.length; i += BATCH_SIZE) {
    const batch = needsFilter.slice(i, i + BATCH_SIZE)
    const batchNum = Math.floor(i / BATCH_SIZE) + 1
    const totalBatches = Math.ceil(needsFilter.length / BATCH_SIZE)

    console.log(`  Batch ${batchNum}/${totalBatches} (${batch.length} items)...`)

    const results = await classifyBatch(batch)

    // Build a lookup of Haiku's decisions
    const decisions = new Map()
    for (const r of results) {
      decisions.set(r.url, r)
    }

    // Apply decisions
    for (const item of batch) {
      const decision = decisions.get(item.url)
      if (!decision || decision.keep) {
        kept.push(item)
      } else {
        totalDropped++
      }
    }
  }

  console.log(`  Pre-filter: ${items.length} → ${kept.length} kept, ${totalDropped} dropped`)
  return kept
}

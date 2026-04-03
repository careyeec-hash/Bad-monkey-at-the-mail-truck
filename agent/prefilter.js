// Pre-filter module — cheap Haiku pass to drop irrelevant items
// Permit/ABP items skip filtering (construction by definition)
// RSS/news items go through Haiku binary classification

import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic()

const SYSTEM_PROMPT = `You are a construction industry classifier for the Arizona market.
For each item, determine if it is relevant to commercial construction,
multifamily development, institutional building, or industrial
construction in Arizona.

KEEP items about:
- Building permits (commercial, multifamily, institutional, industrial)
- Construction project announcements, awards, ground-breakings
- Developer/owner activity (land purchases, entitlements, site plans)
- Construction RFPs, bids, procurement
- General contractor news (awards, hires, expansions) in Arizona
- Economic development driving construction (relocations, facilities, data centers, manufacturing plants)
- Real estate transactions signaling future construction
- Concrete industry developments in Arizona

DROP items about:
- Single-family residential (unless 50+ unit subdivision)
- National news with no Arizona connection
- General business news unrelated to construction
- Restaurant openings, retail tenant announcements
- Opinion pieces with no project specifics
- Events, conferences, awards galas
- Completed projects with no forward-looking element

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

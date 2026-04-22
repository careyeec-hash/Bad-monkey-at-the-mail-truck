// Ingestion orchestrator — pulls from all active sources in sources.json
// Routes each source to the appropriate scraper by type
// Deduplicates against seen-items.json (source-type-aware: skips dedup for snapshot sources)
// Returns: { items, sourcesChecked, sourcesFailed, failures }

import { readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

import fetchPhoenixPermits from './scrapers/phoenix-permits.js'
import fetchPhoenixPDD from './scrapers/phoenix-pdd.js'
import fetchMesaPermits from './scrapers/mesa-permits.js'
import fetchTempePermits from './scrapers/tempe-permits.js'
import fetchSamGov from './scrapers/sam-gov.js'
import fetchLegistarMatters from './scrapers/legistar.js'
import fetchAgendaFromIndex from './scrapers/agenda-index.js'
import fetchRss from './scrapers/generic-rss.js'
import scrapeAccela from './scrapers/accela-abp.js'
import scrapePage from './scrapers/cheerio-scraper.js'
import parsePlanningAgendas from './scrapers/planning-agendas.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const SEEN_ITEMS_TTL_DAYS = 90

// Map source types to their scraper functions
const scrapers = {
  api: (source) => {
    if (source.category === 'rfp') return fetchSamGov(source)
    if (source.category === 'permit') {
      if (source.scraper === 'mesa') return fetchMesaPermits(source)
      if (source.scraper === 'tempe') return fetchTempePermits(source)
      if (source.scraper === 'phoenix-pdd') return fetchPhoenixPDD(source)
      return fetchPhoenixPermits(source)
    }
    if (source.category === 'planning') return fetchLegistarMatters(source)
    throw new Error(`Unknown API source category: ${source.category}`)
  },
  rss: fetchRss,
  abp: scrapeAccela,
  scrape: scrapePage,
  pdf: parsePlanningAgendas,
  'agenda-index': fetchAgendaFromIndex
}

// --- Seen items with TTL support ---

function loadSeenItems() {
  try {
    const data = JSON.parse(readFileSync(join(__dirname, 'seen-items.json'), 'utf-8'))

    // Migrate from old flat array format to timestamped format
    if (Array.isArray(data.processed)) {
      const migrated = {}
      const now = new Date().toISOString()
      for (const url of data.processed) {
        migrated[url] = { addedAt: now, source: 'migrated' }
      }
      return migrated
    }

    return data.processed || {}
  } catch {
    return {}
  }
}

function pruneSeenItems(seenMap) {
  const cutoff = Date.now() - (SEEN_ITEMS_TTL_DAYS * 24 * 60 * 60 * 1000)
  let pruned = 0

  for (const url of Object.keys(seenMap)) {
    const entry = seenMap[url]
    const addedAt = new Date(entry.addedAt).getTime()
    if (addedAt < cutoff) {
      delete seenMap[url]
      pruned++
    }
  }

  if (pruned > 0) {
    console.log(`  Pruned ${pruned} seen items older than ${SEEN_ITEMS_TTL_DAYS} days`)
  }

  return seenMap
}

function saveSeenItems(seenMap) {
  writeFileSync(
    join(__dirname, 'seen-items.json'),
    JSON.stringify({ processed: seenMap, lastPruned: new Date().toISOString() }, null, 2)
  )
}

// --- Source fetching with timeout ---

async function fetchSource(source) {
  const scraper = scrapers[source.type]
  if (!scraper) {
    throw new Error(`Unknown type: ${source.type}`)
  }

  // 30s timeout per source so nothing hangs the pipeline
  const items = await Promise.race([
    scraper(source),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Source timeout (30s)')), 30000)
    )
  ])

  // Cap items per source to prevent any single source from dominating
  const maxItems = source.maxItemsPerRun || 50
  if (items.length > maxItems) {
    console.log(`  [${source.name}] Capped from ${items.length} to ${maxItems} items`)
    return items.slice(0, maxItems)
  }

  return items
}

export default async function ingest() {
  console.log('--- INGEST PHASE ---')

  // 1. Load sources and filter active ones
  const sourcesData = JSON.parse(readFileSync(join(__dirname, 'sources.json'), 'utf-8'))
  const activeSources = sourcesData.sources.filter(s => s.active)
  console.log(`Active sources: ${activeSources.length} of ${sourcesData.sources.length}`)

  // 2. Load and prune seen items (TTL-based cleanup)
  const seenItems = loadSeenItems()
  const seenCountBefore = Object.keys(seenItems).length
  pruneSeenItems(seenItems)

  // 3. Fetch all sources in parallel with Promise.allSettled()
  const results = await Promise.allSettled(
    activeSources.map(async (source) => {
      console.log(`  Fetching: ${source.name} (${source.type})...`)
      const items = await fetchSource(source)
      return { source, items }
    })
  )

  // 4. Process results — separate successes and failures
  let sourcesChecked = activeSources.length
  let sourcesFailed = 0
  const failures = []
  const allItems = []

  for (const result of results) {
    if (result.status === 'fulfilled') {
      const { source, items } = result.value
      source.lastSuccess = new Date().toISOString()
      source.consecutiveFailures = 0
      allItems.push(...items)
    } else {
      // Find which source failed by matching the error
      sourcesFailed++
      // Promise.allSettled doesn't directly tell us which source failed,
      // so we track by index
      const idx = results.indexOf(result)
      const source = activeSources[idx]
      source.consecutiveFailures = (source.consecutiveFailures || 0) + 1
      failures.push({ source: source.name, error: result.reason?.message || 'Unknown error' })
      console.log(`  [${source.name}] FAILED: ${result.reason?.message || 'Unknown error'}`)

      if (source.consecutiveFailures >= 3) {
        console.log(`  WARNING: ${source.name} has failed ${source.consecutiveFailures} consecutive times`)
      }
    }
  }

  // 5. Save updated source health back
  try {
    writeFileSync(join(__dirname, 'sources.json'), JSON.stringify(sourcesData, null, 2))
  } catch (err) {
    console.log(`  Warning: Could not update sources.json: ${err.message}`)
  }

  // 6. Deduplicate — source-type-aware
  // Snapshot sources (permits, etc.) bypass dedup — they return the same projects every query
  // Time-series sources (RSS, news) use normal URL dedup
  const now = new Date().toISOString()
  const newItems = []
  let dedupSkipped = 0

  for (const item of allItems) {
    if (!item.url) {
      newItems.push(item) // keep items with no URL
      continue
    }

    // Find the source config for this item to check sourceType
    const itemSource = activeSources.find(s => s.name === item.source)
    const isSnapshot = itemSource?.sourceType === 'snapshot'

    if (isSnapshot) {
      // Snapshot sources bypass URL dedup — always pass through for re-scoring
      dedupSkipped++
      newItems.push(item)
      // Still record as seen (for tracking purposes, not blocking)
      seenItems[item.url] = { addedAt: now, source: item.source }
      continue
    }

    // Time-series: standard URL dedup
    if (seenItems[item.url]) {
      continue // already seen, skip
    }
    seenItems[item.url] = { addedAt: now, source: item.source }
    newItems.push(item)
  }

  // 7. Save updated seen items
  saveSeenItems(seenItems)

  const deduped = allItems.length - newItems.length
  console.log(`\nIngest summary:`)
  console.log(`  Sources: ${sourcesChecked} checked, ${sourcesFailed} failed`)
  console.log(`  Items: ${allItems.length} total, ${deduped} deduped, ${dedupSkipped} snapshot pass-through, ${newItems.length} new`)
  console.log(`  Seen items: ${seenCountBefore} → ${Object.keys(seenItems).length}`)

  return {
    items: newItems,
    sourcesChecked,
    sourcesFailed,
    failures
  }
}

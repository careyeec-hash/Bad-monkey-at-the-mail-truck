// Ingestion orchestrator — pulls from all active sources in sources.json
// Routes each source to the appropriate scraper by type
// Deduplicates against seen-items.json
// Returns: { items, sourcesChecked, sourcesFailed, failures }

import { readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

import fetchPhoenixPermits from './scrapers/phoenix-permits.js'
import fetchSamGov from './scrapers/sam-gov.js'
import fetchRss from './scrapers/generic-rss.js'
import scrapeAccela from './scrapers/accela-abp.js'
import scrapePage from './scrapers/cheerio-scraper.js'
import parsePlanningAgendas from './scrapers/planning-agendas.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Map source types to their scraper functions
const scrapers = {
  api: (source) => {
    if (source.category === 'permit') return fetchPhoenixPermits(source)
    if (source.category === 'rfp') return fetchSamGov(source)
    throw new Error(`Unknown API source category: ${source.category}`)
  },
  rss: fetchRss,
  abp: scrapeAccela,
  scrape: scrapePage,
  pdf: parsePlanningAgendas
}

function loadSeenItems() {
  try {
    const data = JSON.parse(readFileSync(join(__dirname, 'seen-items.json'), 'utf-8'))
    return new Set(data.processed || [])
  } catch {
    return new Set()
  }
}

function saveSeenItems(seenSet) {
  writeFileSync(
    join(__dirname, 'seen-items.json'),
    JSON.stringify({ processed: [...seenSet] }, null, 2)
  )
}

export default async function ingest() {
  console.log('--- INGEST PHASE ---')

  // 1. Load sources and filter active ones
  const sourcesData = JSON.parse(readFileSync(join(__dirname, 'sources.json'), 'utf-8'))
  const activeSources = sourcesData.sources.filter(s => s.active)
  console.log(`Active sources: ${activeSources.length} of ${sourcesData.sources.length}`)

  // 2. Load seen items for dedup
  const seenItems = loadSeenItems()
  const seenCountBefore = seenItems.size

  // 3. Process each source
  let sourcesChecked = 0
  let sourcesFailed = 0
  const failures = []
  const allItems = []

  for (const source of activeSources) {
    sourcesChecked++
    const scraper = scrapers[source.type]

    if (!scraper) {
      console.log(`  [${source.name}] Unknown source type: ${source.type} — skipping`)
      sourcesFailed++
      failures.push({ source: source.name, error: `Unknown type: ${source.type}` })
      continue
    }

    try {
      console.log(`  Fetching: ${source.name} (${source.type})...`)
      // 30s timeout per source so nothing hangs the pipeline
      const items = await Promise.race([
        scraper(source),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Source timeout (30s)')), 30000)
        )
      ])

      // Update source health on success
      source.lastSuccess = new Date().toISOString()
      source.consecutiveFailures = 0

      allItems.push(...items)
    } catch (err) {
      sourcesFailed++
      source.consecutiveFailures = (source.consecutiveFailures || 0) + 1
      failures.push({ source: source.name, error: err.message })
      console.log(`  [${source.name}] FAILED: ${err.message}`)

      if (source.consecutiveFailures >= 3) {
        console.log(`  ⚠ ${source.name} has failed ${source.consecutiveFailures} consecutive times`)
      }
    }
  }

  // 4. Save updated source health back
  try {
    writeFileSync(join(__dirname, 'sources.json'), JSON.stringify(sourcesData, null, 2))
  } catch (err) {
    console.log(`  Warning: Could not update sources.json: ${err.message}`)
  }

  // 5. Deduplicate against seen items
  const newItems = allItems.filter(item => {
    if (!item.url) return true // keep items with no URL
    if (seenItems.has(item.url)) return false
    seenItems.add(item.url)
    return true
  })

  // 6. Save updated seen items
  saveSeenItems(seenItems)

  const deduped = allItems.length - newItems.length
  console.log(`\nIngest summary:`)
  console.log(`  Sources: ${sourcesChecked} checked, ${sourcesFailed} failed`)
  console.log(`  Items: ${allItems.length} total, ${deduped} duplicates removed, ${newItems.length} new`)
  console.log(`  Seen items: ${seenCountBefore} → ${seenItems.size}`)

  return {
    items: newItems,
    sourcesChecked,
    sourcesFailed,
    failures
  }
}

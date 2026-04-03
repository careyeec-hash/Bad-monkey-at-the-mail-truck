// Generic cheerio scraper — for static HTML permit/planning pages
// Used for sources that don't require JavaScript rendering

import * as cheerio from 'cheerio'

export default async function scrapePage(source) {
  if (!source.url) {
    console.log(`  [Scrape: ${source.name}] No URL configured`)
    return []
  }

  const res = await fetch(source.url, {
    headers: {
      'User-Agent': 'BadMonkeyAgent/1.0 (construction-intelligence)'
    },
    signal: AbortSignal.timeout(15000)
  })

  if (!res.ok) {
    throw new Error(`${source.name} returned ${res.status}: ${res.statusText}`)
  }

  const html = await res.text()
  const $ = cheerio.load(html)

  // Structure change detection — check for expected elements
  if (source.expectedSelector && $(source.expectedSelector).length === 0) {
    console.log(`  [Scrape: ${source.name}] Structure change detected — expected element not found`)
    return []
  }

  // Generic extraction — source-specific parsing configured via source.scrapeConfig
  const items = []

  if (source.scrapeConfig) {
    const { rowSelector, titleSelector, linkSelector, dateSelector, descSelector } = source.scrapeConfig

    $(rowSelector).each((_, el) => {
      const title = $(el).find(titleSelector).text().trim()
      const link = $(el).find(linkSelector).attr('href') || ''
      const date = $(el).find(dateSelector).text().trim()
      const description = $(el).find(descSelector).text().trim()

      if (title) {
        items.push({
          title,
          url: link.startsWith('http') ? link : new URL(link, source.url).href,
          source: source.name,
          sourceTier: source.tier,
          sourceCategory: source.category,
          date: date || new Date().toISOString(),
          summary: description || title,
          rawContent: { title, description, date, html: $(el).html() },
          type: 'scrape',
          permitData: null
        })
      }
    })
  }

  console.log(`  [Scrape: ${source.name}] ${items.length} items extracted`)
  return items
}

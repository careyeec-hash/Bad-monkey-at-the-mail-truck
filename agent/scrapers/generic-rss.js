// Generic RSS feed parser — used for all RSS sources
// Uses rss-parser, filters to last 7 days

import RssParser from 'rss-parser'

const parser = new RssParser({
  timeout: 15000,
  headers: {
    'User-Agent': 'BadMonkeyAgent/1.0 (construction-intelligence)'
  }
})

export default async function fetchRss(source) {
  const feed = await parser.parseURL(source.url)

  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - 7)

  const maxItems = source.maxItemsPerRun || 10
  const items = (feed.items || [])
    .filter(item => {
      if (!item.pubDate && !item.isoDate) return true // keep items with no date
      const itemDate = new Date(item.isoDate || item.pubDate)
      return itemDate >= cutoff
    })
    .slice(0, maxItems) // cap per source to prevent any single feed from dominating
    .map(item => ({
      title: item.title || 'Untitled',
      url: item.link || item.guid || '',
      source: source.name,
      sourceTier: source.tier,
      sourceCategory: source.category,
      date: item.isoDate || item.pubDate || new Date().toISOString(),
      summary: item.contentSnippet || item.content || item.title || '',
      rawContent: {
        title: item.title,
        content: item.content || item.contentSnippet || '',
        categories: item.categories || [],
        creator: item.creator || item.author || null
      },
      type: 'news',
      permitData: null
    }))

  console.log(`  [RSS: ${source.name}] ${feed.items?.length || 0} total → ${items.length} in last 7d`)
  return items
}

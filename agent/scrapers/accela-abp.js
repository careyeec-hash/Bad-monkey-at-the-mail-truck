// Generic Accela ABP scraper — works across all Accela permit portals
// Uses Agent Browser Protocol (ABP) for JavaScript-rendered pages
// Each city has its own config in abp-config/{city}.json

import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const ABP_BASE = `http://localhost:${process.env.ABP_PORT || 8222}`

async function abpRequest(endpoint, body) {
  const res = await fetch(`${ABP_BASE}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!res.ok) {
    throw new Error(`ABP ${endpoint} returned ${res.status}`)
  }
  return res.json()
}

export default async function scrapeAccela(source) {
  const configPath = join(__dirname, 'abp-config', `${source.config}.json`)
  let config

  try {
    config = JSON.parse(readFileSync(configPath, 'utf-8'))
  } catch (err) {
    console.log(`  [ABP: ${source.name}] Config not found at ${configPath}`)
    return []
  }

  if (!config.active) {
    console.log(`  [ABP: ${source.name}] Disabled in config`)
    return []
  }

  if (!config.portalUrl) {
    console.log(`  [ABP: ${source.name}] No portal URL configured yet`)
    return []
  }

  // Check if ABP is running
  try {
    const healthRes = await fetch(`${ABP_BASE}/health`, { signal: AbortSignal.timeout(3000) })
    if (!healthRes.ok) throw new Error('ABP not healthy')
  } catch {
    console.log(`  [ABP: ${source.name}] ABP not running on port ${process.env.ABP_PORT || 8222} — skipping`)
    return []
  }

  const timeout = config.timeout || 60000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)

  try {
    // 1. Create a new browser session
    const session = await abpRequest('/session/create', {})
    const sessionId = session.sessionId

    try {
      // 2. Navigate to the Accela portal
      await abpRequest('/session/navigate', {
        sessionId,
        url: config.portalUrl
      })

      // 3. Wait for page to settle
      await abpRequest('/session/wait', {
        sessionId,
        timeout: 10000
      })

      // 4. Fill search form if selectors are configured
      if (config.selectors?.searchForm) {
        for (const [selector, value] of Object.entries(config.selectors.searchForm)) {
          await abpRequest('/session/fill', {
            sessionId,
            selector,
            value
          })
        }

        // Submit search
        if (config.selectors.submitButton) {
          await abpRequest('/session/click', {
            sessionId,
            selector: config.selectors.submitButton
          })

          await abpRequest('/session/wait', {
            sessionId,
            timeout: 15000
          })
        }
      }

      // 5. Extract results from the page
      const pageContent = await abpRequest('/session/content', {
        sessionId
      })

      // 6. Parse results using configured selectors
      const items = parseAccelaResults(pageContent.html || '', config)

      console.log(`  [ABP: ${config.cityName}] ${items.length} permits extracted`)
      return items

    } finally {
      // Always close the session
      try {
        await abpRequest('/session/close', { sessionId })
      } catch { /* ignore cleanup errors */ }
    }

  } catch (err) {
    if (err.name === 'AbortError') {
      console.log(`  [ABP: ${config.cityName}] Timed out after ${timeout / 1000}s`)
    } else {
      console.log(`  [ABP: ${config.cityName}] Error: ${err.message}`)
    }
    return []
  } finally {
    clearTimeout(timer)
  }
}

function parseAccelaResults(html, config) {
  // When selectors are properly configured, this will parse the HTML table
  // For now, return empty — selectors need to be determined per city via ABP testing
  if (!config.selectors?.resultsTable) {
    return []
  }

  // TODO: Use cheerio to parse the HTML with config-defined selectors
  // Each row becomes a standard item:
  // {
  //   title: "{type}: {description} — {address}",
  //   url: link to permit detail,
  //   source: "{config.cityName} Permits (Accela)",
  //   sourceTier: 1,
  //   sourceCategory: "permits",
  //   date: permit_date,
  //   summary: "Permit #{number} filed by {owner} ...",
  //   rawContent: { full permit record },
  //   type: "permit",
  //   permitData: { permitNumber, address, description, owner, contractor, valuation, ... }
  // }

  return []
}

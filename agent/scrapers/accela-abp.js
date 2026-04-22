// Generic ABP scraper — works across Accela, PDD, and Salesforce permit portals
// Uses Agent Browser Protocol (ABP) via MCP JSON-RPC
// Each city/portal has its own config in abp-config/{name}.json
// Config defines: URL, search form selectors, result table selectors, column mapping

import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import * as cheerio from 'cheerio'

const __dirname = dirname(fileURLToPath(import.meta.url))

const ABP_PORT = process.env.ABP_PORT || 8222
const ABP_MCP_URL = `http://localhost:${ABP_PORT}/mcp`

let mcpIdCounter = 0

async function mcpCall(toolName, args) {
  const res = await fetch(ABP_MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: toolName, arguments: args || {} },
      id: ++mcpIdCounter
    })
  })
  if (!res.ok) {
    throw new Error(`ABP MCP returned ${res.status}`)
  }
  const result = await res.json()
  if (result.error) {
    throw new Error(`ABP error: ${result.error.message || JSON.stringify(result.error)}`)
  }
  return result.result
}

function extractText(mcpResult) {
  const content = mcpResult?.content?.[0]
  if (!content) return ''
  if (content.type === 'text') {
    try {
      const parsed = JSON.parse(content.text)
      return parsed.text || content.text
    } catch {
      return content.text
    }
  }
  return content.text || ''
}

function extractValue(mcpResult) {
  return mcpResult?.value || mcpResult?.content?.[0]?.text || ''
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

  // Check if ABP is running via MCP
  try {
    await mcpCall('browser_get_status')
  } catch {
    console.log(`  [ABP: ${source.name}] ABP not running on port ${ABP_PORT} — skipping`)
    return []
  }

  const timeout = config.timeout || 60000

  try {
    // 1. Navigate to the portal
    await mcpCall('browser_navigate', { url: config.portalUrl })
    await new Promise(r => setTimeout(r, 3000))
    await mcpCall('browser_wait', {})

    // 1b. Log in if auth is configured and we're not already authenticated
    if (config.auth) {
      await ensureAuthenticated(config, source)
    }

    // 2. Fill search form fields
    const formFields = config.selectors?.searchForm || {}
    for (const [selector, value] of Object.entries(formFields)) {
      if (!selector || !value) continue
      await mcpCall('browser_javascript', {
        expression: `document.querySelector('${selector}').value = ${JSON.stringify(value)};`
      })
    }

    // 3. Click submit button
    if (config.selectors?.submitButton) {
      await mcpCall('browser_javascript', {
        expression: `document.querySelector('${config.selectors.submitButton}').click();`
      })

      // Wait for results to load
      await new Promise(r => setTimeout(r, 5000))
      await mcpCall('browser_wait', {})
    }

    // 4. Extract results (with pagination)
    const allItems = []
    const maxPages = config.maxPages || 1

    for (let page = 0; page < maxPages; page++) {
      // Get page HTML via JavaScript
      const htmlResult = await mcpCall('browser_javascript', {
        expression: config.selectors?.resultsContainer
          ? `document.querySelector('${config.selectors.resultsContainer}')?.outerHTML || ''`
          : 'document.body.innerHTML'
      })
      const html = extractValue(htmlResult)

      if (!html || html.length < 50) break

      const items = parseResults(html, config, source)
      if (items.length === 0) break

      allItems.push(...items)
      console.log(`  [ABP: ${config.cityName}] Page ${page + 1}: ${items.length} items`)

      // Pagination
      if (page < maxPages - 1 && config.selectors?.nextPage) {
        try {
          await mcpCall('browser_javascript', {
            expression: `var btn = document.querySelector('${config.selectors.nextPage}'); if(btn && !btn.classList.contains('k-state-disabled')) btn.click(); else throw 'no-more';`
          })
          await new Promise(r => setTimeout(r, 3000))
          await mcpCall('browser_wait', {})
        } catch {
          break
        }
      }
    }

    console.log(`  [ABP: ${config.cityName}] ${allItems.length} total permits extracted`)
    return allItems

  } catch (err) {
    console.log(`  [ABP: ${config.cityName}] Error: ${err.message}`)
    return []
  }
}

async function ensureAuthenticated(config, source) {
  const auth = config.auth
  const username = auth.usernameEnv ? process.env[auth.usernameEnv] : null
  const password = auth.passwordEnv ? process.env[auth.passwordEnv] : null

  if (!username || !password) {
    throw new Error(`auth configured but ${auth.usernameEnv}/${auth.passwordEnv} not set in env`)
  }

  if (auth.successIndicator) {
    const already = await mcpCall('browser_javascript', {
      expression: `!!document.querySelector(${JSON.stringify(auth.successIndicator)})`
    })
    if (extractValue(already) === true || extractValue(already) === 'true') {
      return
    }
  }

  console.log(`  [ABP: ${config.cityName}] Logging in as ${username}`)

  if (auth.loginUrl && auth.loginUrl !== config.portalUrl) {
    await mcpCall('browser_navigate', { url: auth.loginUrl })
    await new Promise(r => setTimeout(r, 3000))
    await mcpCall('browser_wait', {})
  }

  if (auth.preLoginClickSelector) {
    await mcpCall('browser_javascript', {
      expression: `document.querySelector(${JSON.stringify(auth.preLoginClickSelector)})?.click();`
    })
    await new Promise(r => setTimeout(r, 2000))
    await mcpCall('browser_wait', {})
  }

  await mcpCall('browser_javascript', {
    expression: `(() => {
      const u = document.querySelector(${JSON.stringify(auth.usernameSelector)});
      const p = document.querySelector(${JSON.stringify(auth.passwordSelector)});
      if (!u || !p) throw new Error('login fields not found');
      const setVal = (el, v) => {
        const proto = Object.getPrototypeOf(el);
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        setter ? setter.call(el, v) : (el.value = v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      setVal(u, ${JSON.stringify(username)});
      setVal(p, ${JSON.stringify(password)});
    })()`
  })

  await mcpCall('browser_javascript', {
    expression: `document.querySelector(${JSON.stringify(auth.submitSelector)}).click();`
  })

  await new Promise(r => setTimeout(r, 5000))
  await mcpCall('browser_wait', {})

  if (auth.successIndicator) {
    const ok = await mcpCall('browser_javascript', {
      expression: `!!document.querySelector(${JSON.stringify(auth.successIndicator)})`
    })
    const value = extractValue(ok)
    if (!(value === true || value === 'true')) {
      throw new Error('login did not produce expected successIndicator')
    }
  }

  // Return to the portal URL if login redirected elsewhere
  await mcpCall('browser_navigate', { url: config.portalUrl })
  await new Promise(r => setTimeout(r, 3000))
  await mcpCall('browser_wait', {})
}

function parseResults(html, config, source) {
  if (!config.selectors?.rowSelector || !config.selectors?.columns) {
    return []
  }

  const $ = cheerio.load(html)
  const rows = $(config.selectors.rowSelector)
  const items = []
  const columns = config.selectors.columns
  const filters = config.filters || {}

  rows.each((i, row) => {
    const $row = $(row)

    // Extract fields using configured column selectors
    const raw = {}
    for (const [field, selector] of Object.entries(columns)) {
      if (!selector) continue
      raw[field] = $row.find(selector).text().trim() || $row.find(selector).attr('title') || ''
    }

    // Extract detail link if configured
    let detailUrl = null
    if (config.selectors.detailLink) {
      const href = $row.find(config.selectors.detailLink).attr('href')
      if (href) {
        detailUrl = href.startsWith('http') ? href : new URL(href, config.portalUrl).toString()
      }
    }

    // Apply filters
    const desc = (raw.description || '').toLowerCase()
    const status = (raw.status || '').toUpperCase()
    const permitNum = raw.permitNumber || ''

    if (filters.excludeStatuses?.some(s => status === s.toUpperCase())) return
    if (filters.excludeDescriptions?.some(t => desc.includes(t))) return

    if (filters.commercialPrefixes || filters.commercialKeywords) {
      const isCommercialPrefix = filters.commercialPrefixes?.some(p =>
        permitNum.toUpperCase().startsWith(p)
      )
      const isCommercialKeyword = filters.commercialKeywords?.some(k =>
        desc.includes(k)
      )
      if (!isCommercialPrefix && !isCommercialKeyword) return
    }

    const address = raw.address || ''
    const description = raw.description || 'Building Permit'

    items.push({
      title: `${config.cityName} Permit ${permitNum}: ${description}`.slice(0, 200),
      url: detailUrl || `${config.portalUrl}?permit=${encodeURIComponent(permitNum)}`,
      source: source.name,
      sourceTier: source.tier,
      sourceCategory: source.category,
      date: parseDate(raw.issuedDate),
      summary: [
        description,
        address ? `Address: ${address}` : null,
        raw.professional || raw.contractor ? `Professional: ${raw.professional || raw.contractor}` : null,
        raw.owner ? `Owner: ${raw.owner}` : null,
        raw.valuation ? `Valuation: ${raw.valuation}` : null,
        status ? `Status: ${status}` : null,
        `Permit: ${permitNum}`
      ].filter(Boolean).join('. '),
      rawContent: raw,
      type: 'permit',
      permitData: {
        permitNumber: permitNum,
        address,
        description,
        owner: raw.owner || null,
        contractor: raw.contractor || raw.professional || null,
        valuation: raw.valuation || null,
        status: raw.status || null,
        issuedDate: parseDate(raw.issuedDate),
        city: config.cityName
      }
    })
  })

  return items
}

function parseDate(dateStr) {
  if (!dateStr) return new Date().toISOString()
  try {
    const d = new Date(dateStr)
    if (!isNaN(d.getTime())) return d.toISOString()
  } catch {}
  return new Date().toISOString()
}

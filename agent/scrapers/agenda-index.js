// Agenda index scraper — discovers the latest planning commission agenda PDF
// from a city's agenda index page, then delegates to planning-agendas.js for parsing
// Supports CivicEngage (Maricopa County) and similar platforms
// Each source config specifies the index URL and link pattern

import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic()

export default async function fetchAgendaFromIndex(source) {
  if (!source.agendaIndexUrl) {
    throw new Error(`No agendaIndexUrl configured for ${source.name}`)
  }

  // Only run on Mondays (weekly cadence, same as planning-agendas.js)
  const today = new Date().getDay()
  if (today !== 1) {
    console.log(`  [Agenda: ${source.name}] Skipping — only runs on Mondays`)
    return []
  }

  // 1. Fetch the agenda index page
  const indexRes = await fetch(source.agendaIndexUrl, {
    headers: { 'User-Agent': 'BadMonkeyAgent/1.0 (construction-intelligence)' },
    signal: AbortSignal.timeout(15000)
  })

  if (!indexRes.ok) {
    throw new Error(`${source.name} index page returned ${indexRes.status}`)
  }

  const html = await indexRes.text()

  // 2. Find agenda PDF links using configured pattern
  const linkPattern = source.agendaLinkPattern || '/AgendaCenter/ViewFile/Agenda/'
  const regex = new RegExp(`href="([^"]*${escapeRegex(linkPattern)}[^"?]*)"`, 'g')
  const links = []
  let match
  while ((match = regex.exec(html)) !== null) {
    const href = match[1]
    // Skip HTML view and packet links
    if (!links.includes(href)) {
      links.push(href)
    }
  }

  if (links.length === 0) {
    console.log(`  [Agenda: ${source.name}] No agenda PDF links found`)
    return []
  }

  // 3. Use the most recent agenda (first link = most recent)
  const baseUrl = new URL(source.agendaIndexUrl).origin
  const agendaUrl = links[0].startsWith('http') ? links[0] : baseUrl + links[0]

  console.log(`  [Agenda: ${source.name}] Found ${links.length} agendas, fetching latest: ${agendaUrl}`)

  // 4. Fetch and parse the PDF using Claude (same approach as planning-agendas.js)
  const pdfRes = await fetch(agendaUrl, {
    headers: { 'User-Agent': 'BadMonkeyAgent/1.0 (construction-intelligence)' },
    signal: AbortSignal.timeout(30000)
  })

  if (!pdfRes.ok) {
    throw new Error(`${source.name} agenda PDF returned ${pdfRes.status}`)
  }

  const pdfBuffer = await pdfRes.arrayBuffer()
  const pdfBase64 = Buffer.from(pdfBuffer).toString('base64')

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: pdfBase64
          }
        },
        {
          type: 'text',
          text: `Extract all development review, site plan, rezoning, and construction-related agenda items from this planning commission agenda. For each item, provide:
- title: project name or address
- description: what's being proposed (building type, size, units, etc.)
- address: project address or location description
- developer: developer/applicant name if mentioned
- type: residential, commercial, multifamily, mixed-use, institutional, industrial, or other
- zoning_action: rezoning, variance, site plan review, development review, conditional use, etc.

Return as a JSON array. Only include items related to construction, development, or land use. Skip procedural items, minutes approval, call to order, etc. Return [] if no relevant items found.`
        }
      ]
    }]
  })

  let agendaItems = []
  const rawText = message.content[0].text
  try {
    let text = rawText.trim()
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
    if (fenceMatch) text = fenceMatch[1].trim()
    if (!text.startsWith('[')) {
      const start = text.indexOf('[')
      const end = text.lastIndexOf(']')
      if (start !== -1 && end > start) text = text.slice(start, end + 1)
    }
    agendaItems = JSON.parse(text)
  } catch {
    console.log(`  [Agenda: ${source.name}] Failed to parse Claude response. First 300 chars: ${rawText.slice(0, 300)}`)
    return []
  }

  const items = agendaItems.map(item => ({
    title: `Planning: ${item.title || 'Development Review Item'} — ${source.cityName || source.name}`,
    url: agendaUrl,
    source: source.name,
    sourceTier: source.tier,
    sourceCategory: 'planning',
    date: new Date().toISOString(),
    summary: `${item.zoning_action || 'Development review'}: ${item.description || item.title}. ` +
      `${item.address ? 'Address: ' + item.address + '. ' : ''}` +
      `${item.developer ? 'Applicant: ' + item.developer + '. ' : ''}` +
      `Type: ${item.type || 'unknown'}.`,
    rawContent: item,
    type: 'planning',
    permitData: null
  }))

  console.log(`  [Agenda: ${source.name}] ${items.length} development items extracted`)
  return items
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

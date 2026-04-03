// Planning agenda PDF parser — extracts development review items
// from city council / planning commission agendas
// Uses Claude API to parse PDF content into structured data
// Runs weekly, not daily (cost: ~$0.50/week for 4-5 PDFs)

import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic()

export default async function parsePlanningAgendas(source) {
  if (!source.url) {
    console.log(`  [PDF: ${source.name}] No URL configured`)
    return []
  }

  // Only run on Mondays (weekly cadence for agenda parsing)
  const today = new Date().getDay()
  if (today !== 1) {
    console.log(`  [PDF: ${source.name}] Skipping — only runs on Mondays`)
    return []
  }

  // Fetch the PDF
  const res = await fetch(source.url, {
    headers: {
      'User-Agent': 'BadMonkeyAgent/1.0 (construction-intelligence)'
    },
    signal: AbortSignal.timeout(30000)
  })

  if (!res.ok) {
    throw new Error(`${source.name} returned ${res.status}: ${res.statusText}`)
  }

  const pdfBuffer = await res.arrayBuffer()
  const pdfBase64 = Buffer.from(pdfBuffer).toString('base64')

  // Send to Claude for extraction
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
          text: `Extract all development review, site plan, and construction-related agenda items from this planning commission agenda. For each item, provide:
- title: project name or address
- description: what's being proposed
- address: project address if mentioned
- developer: developer/applicant name if mentioned
- type: residential, commercial, multifamily, mixed-use, institutional, industrial, or other
- zoning_action: rezoning, variance, site plan review, development review, conditional use, etc.

Return as a JSON array. Only include items related to construction, development, or land use. Skip procedural items, minutes approval, etc. Return [] if no relevant items found.`
        }
      ]
    }]
  })

  let agendaItems = []
  try {
    const text = message.content[0].text
    agendaItems = JSON.parse(text)
  } catch {
    console.log(`  [PDF: ${source.name}] Failed to parse Claude response as JSON`)
    return []
  }

  const items = agendaItems.map(item => ({
    title: `Planning: ${item.title || 'Development Review Item'}`,
    url: source.url,
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

  console.log(`  [PDF: ${source.name}] ${items.length} development items extracted`)
  return items
}

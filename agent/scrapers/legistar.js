// Legistar API scraper — extracts rezoning, planning, and development matters
// from city council/planning commission agendas via the Legistar web API
// Returns structured JSON — no PDF parsing needed, no AI cost
// API: https://webapi.legistar.com/v1/{client}/matters

const LEGISTAR_API = 'https://webapi.legistar.com/v1'

// Keywords that indicate construction/development-relevant matters
const PLANNING_KEYWORDS = [
  'rezone', 'rezoning', 'zoning', 'pud', 'planned unit',
  'site plan', 'development', 'subdivision', 'plat',
  'conditional use', 'use permit', 'variance',
  'general plan', 'specific plan', 'overlay',
  'annexation', 'building', 'construction'
]

const EXCLUDE_KEYWORDS = [
  'liquor license', 'special event', 'honorary',
  'proclamation', 'minutes of', 'executive session',
  'budget', 'pension', 'employee', 'personnel'
]

export default async function fetchLegistarMatters(source) {
  const client = source.legistarClient
  if (!client) {
    throw new Error(`No legistarClient configured for ${source.name}`)
  }

  const lookbackDays = source.lookbackDays || 30
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - lookbackDays)
  const cutoffStr = cutoff.toISOString().split('T')[0]

  // Query recent matters with planning/zoning keywords
  // Legistar OData doesn't support complex OR filters well,
  // so fetch recent matters and filter in JS
  const params = new URLSearchParams({
    '$filter': `MatterIntroDate ge datetime'${cutoffStr}'`,
    '$orderby': 'MatterIntroDate desc',
    '$top': '200'
  })

  const url = `${LEGISTAR_API}/${client}/matters?${params}`
  const res = await fetch(url, {
    headers: { 'User-Agent': 'BadMonkeyAgent/1.0 (construction-intelligence)' },
    signal: AbortSignal.timeout(15000)
  })

  if (!res.ok) {
    throw new Error(`Legistar API returned ${res.status}: ${res.statusText}`)
  }

  const matters = await res.json()

  const items = matters
    .filter(m => {
      const title = (m.MatterTitle || '').toLowerCase()

      // Exclude procedural/irrelevant items
      if (EXCLUDE_KEYWORDS.some(k => title.includes(k))) return false

      // Keep planning/development items
      return PLANNING_KEYWORDS.some(k => title.includes(k))
    })
    .map(m => {
      const title = m.MatterTitle || 'Planning Matter'
      // Extract address from title if present (common pattern: "Corner of X and Y")
      const addressMatch = title.match(/(?:corner of|at|near)\s+(.+?)(?:\s*-\s*District|\s*\(|$)/i)

      return {
        title: `${source.cityName} Planning: ${title}`.slice(0, 200),
        url: `https://${client}.legistar.com/LegislationDetail.aspx?ID=${m.MatterId}&GUID=${m.MatterGuid}`,
        source: source.name,
        sourceTier: source.tier,
        sourceCategory: 'planning',
        date: m.MatterIntroDate || new Date().toISOString(),
        summary: [
          title,
          m.MatterBodyName ? `Body: ${m.MatterBodyName}` : null,
          m.MatterStatusName ? `Status: ${m.MatterStatusName}` : null,
          m.MatterTypeName ? `Type: ${m.MatterTypeName}` : null,
          addressMatch ? `Location: ${addressMatch[1].trim()}` : null
        ].filter(Boolean).join('. '),
        rawContent: {
          matterId: m.MatterId,
          matterGuid: m.MatterGuid,
          title: m.MatterTitle,
          type: m.MatterTypeName,
          status: m.MatterStatusName,
          body: m.MatterBodyName,
          introDate: m.MatterIntroDate,
          agendaDate: m.MatterAgendaDate,
          file: m.MatterFile
        },
        type: 'planning',
        permitData: null
      }
    })

  const maxItems = source.maxItemsPerRun || 30
  const limited = items.slice(0, maxItems)

  console.log(`  [Legistar: ${source.cityName}] ${matters.length} total matters → ${items.length} planning/zoning → ${limited.length} returned`)
  return limited
}

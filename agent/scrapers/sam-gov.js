// SAM.gov — Federal construction RFPs in Arizona
// API: api.sam.gov/opportunities/v2/search
// Requires SAM_GOV_API_KEY (free registration)

import https from 'https'

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('SAM.gov timeout (15s)')), 15000)
    https.get(url, res => {
      let body = ''
      res.on('data', chunk => body += chunk)
      res.on('end', () => { clearTimeout(timer); resolve(body) })
      res.on('error', err => { clearTimeout(timer); reject(err) })
    }).on('error', err => { clearTimeout(timer); reject(err) })
  })
}

export default async function fetchSamGov(source) {
  const apiKey = process.env.SAM_GOV_API_KEY
  if (!apiKey) {
    console.log('  [SAM.gov] Skipping — SAM_GOV_API_KEY not set')
    return []
  }

  const now = new Date()
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - 2)

  // SAM.gov requires MM/DD/YYYY format — use raw https.get to avoid URL encoding
  const fmt = d => `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`

  const url = `https://api.sam.gov/opportunities/v2/search?api_key=${apiKey}&postedFrom=${fmt(cutoff)}&postedTo=${fmt(now)}&limit=100&offset=0&ptype=o`

  const body = await httpsGet(url)

  let data
  try {
    data = JSON.parse(body)
  } catch {
    throw new Error('SAM.gov returned non-JSON response')
  }

  const allOpps = data.opportunitiesData || []

  // Filter for AZ construction locally
  const constructionNaics = ['236', '237', '238']
  const opportunities = allOpps.filter(opp => {
    const place = JSON.stringify(opp.placeOfPerformance || {}).toLowerCase()
    const isAZ = place.includes('arizona') || place.includes(', az') || place.includes('"az"')
    const naics = opp.naicsCode || ''
    const isConstruction = constructionNaics.some(n => naics.startsWith(n))
    const titleMatch = (opp.title || '').toLowerCase().includes('arizona') ||
                       (opp.title || '').toLowerCase().includes(' az ')
    return (isAZ && isConstruction) || (isConstruction && titleMatch)
  })

  const items = opportunities.map(opp => {
    const title = opp.title || 'Federal Construction Opportunity'
    const solicitationNumber = opp.solicitationNumber || null
    const dueDate = opp.responseDeadLine || null
    const agency = opp.department || opp.subtier || 'Federal Agency'
    const setAside = opp.typeOfSetAside || null
    const postedDate = opp.postedDate || new Date().toISOString()

    return {
      title: `Federal RFP: ${title}`,
      url: opp.uiLink || `https://sam.gov/opp/${opp.noticeId || ''}`,
      source: source.name,
      sourceTier: source.tier,
      sourceCategory: source.category,
      date: postedDate,
      summary: `${agency}: ${title}. ` +
        `${solicitationNumber ? 'Solicitation: ' + solicitationNumber + '. ' : ''}` +
        `${dueDate ? 'Due: ' + dueDate + '. ' : ''}` +
        `${setAside ? 'Set-aside: ' + setAside + '. ' : ''}` +
        `NAICS: ${opp.naicsCode || '236'} (Construction).`,
      rawContent: opp,
      type: 'rfp',
      permitData: null
    }
  })

  console.log(`  [SAM.gov] ${allOpps.length} total → ${items.length} AZ construction RFPs`)
  return items
}

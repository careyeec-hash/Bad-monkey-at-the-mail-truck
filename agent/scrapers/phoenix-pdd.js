// Phoenix PDD Online — AJAX permit search (bridge scraper)
// Endpoint: apps-secure.phoenix.gov/PDD/Search/Permits/_GetPermitData
// POST-based search returning JSON via Kendo Grid
// Requires a session cookie — must GET the search page first, then POST.
// This is a TEMPORARY bridge until SHAPE PHX ABP scraper is built.
// Permits with status "SHAP" have migrated to SHAPE PHX.

const PDD_BASE = 'https://apps-secure.phoenix.gov/PDD/Search/Permits'
const PDD_SEARCH_URL = `${PDD_BASE}/_GetPermitData`

const COMMERCIAL_PREFIXES = [
  'COM', 'CTR', 'IND', 'MUL', 'MIX', 'HTL', 'HOS', 'OFF', 'RET', 'WAR',
  'INS', 'CHU', 'SCH', 'PLN'
]

const EXCLUDE_DESCRIPTIONS = [
  'single family', 'single-family', 'sfr', 'pool', 'fence', 'solar',
  'reroof', 're-roof', 'water heater', 'photovoltaic', 'patio cover'
]

export default async function fetchPhoenixPDD(source) {
  // Step 1: GET the search page to establish a session and get cookies
  const pageRes = await fetch(PDD_BASE, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml'
    },
    signal: AbortSignal.timeout(15000),
    redirect: 'follow'
  })

  if (!pageRes.ok) {
    throw new Error(`Phoenix PDD page returned ${pageRes.status}`)
  }

  // Extract cookies from the response
  const cookies = pageRes.headers.getSetCookie?.() || []
  const cookieStr = cookies.map(c => c.split(';')[0]).join('; ')

  // Extract verification token if present (ASP.NET anti-forgery)
  const html = await pageRes.text()
  const tokenMatch = html.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/)
  const token = tokenMatch ? tokenMatch[1] : null

  // Step 2: POST the search with session cookies
  const params = {
    'sort': '',
    'group': '',
    'filter': '',
    'PermitType': '',
    'PermitNumber': '%',
    'AddrNumber': '',
    'AddrDirection': '',
    'AddrStreet': '',
    'AddrType': '',
    'ProfName': '',
    'ProfLicNum': '',
    'ProjNumber': '',
    'ProjName': '',
    'DateFrom': formatDate(daysAgo(14)),
    'DateTo': formatDate(new Date()),
    'SolarGreenAdapt': '',
    'Temp': 'N',
    'page': '1',
    'pageSize': '100',
    'take': '100',
    'skip': '0'
  }

  if (token) {
    params['__RequestVerificationToken'] = token
  }

  const body = new URLSearchParams(params)

  const res = await fetch(PDD_SEARCH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': PDD_BASE,
      'Cookie': cookieStr
    },
    body: body.toString(),
    signal: AbortSignal.timeout(20000)
  })

  if (!res.ok) {
    throw new Error(`Phoenix PDD search returned ${res.status}: ${res.statusText}`)
  }

  const text = await res.text()
  if (!text || text.length === 0) {
    throw new Error('Phoenix PDD returned empty response (session may require browser)')
  }

  const data = JSON.parse(text)

  // Kendo Grid returns { Data: [...], Total: N }
  const records = data.Data || data.data || []
  if (!Array.isArray(records)) {
    console.log(`  [Phoenix PDD] Unexpected response format`)
    return []
  }

  const items = records
    .filter(r => {
      const desc = (r.ProjDesc || r.Description || '').toLowerCase()
      const permitType = (r.PermitType || '').toUpperCase()
      const status = (r.Status || '').toUpperCase()

      if (status === 'SHAP') return false
      if (EXCLUDE_DESCRIPTIONS.some(t => desc.includes(t))) return false
      if (COMMERCIAL_PREFIXES.some(p => permitType.startsWith(p))) return true

      const commercialKeywords = ['commercial', 'multi', 'apartment', 'hotel',
        'office', 'retail', 'warehouse', 'industrial', 'mixed use', 'restaurant',
        'medical', 'hospital', 'church', 'school', 'tenant improvement']
      if (commercialKeywords.some(k => desc.includes(k))) return true

      return false
    })
    .map(r => {
      const permitNum = r.PermitTypeNumber || r.PermitNumber || ''
      const address = r.Address || r.StreetAddress || ''
      const description = r.ProjDesc || r.Description || 'Commercial Permit'
      const issuedDate = r.IssuedDate || r.DateIssued || null
      const professional = r.ProfName || r.Professional || null
      const status = r.Status || null

      return {
        title: `Phoenix Permit ${permitNum}: ${description}`.slice(0, 200),
        url: `${PDD_BASE}?permit=${encodeURIComponent(permitNum)}`,
        source: source.name,
        sourceTier: source.tier,
        sourceCategory: source.category,
        date: issuedDate ? parseDate(issuedDate) : new Date().toISOString(),
        summary: [
          description,
          address ? `Address: ${address}` : null,
          professional ? `Professional: ${professional}` : null,
          status ? `Status: ${status}` : null,
          `Permit: ${permitNum}`
        ].filter(Boolean).join('. '),
        rawContent: r,
        type: 'permit',
        permitData: {
          permitNumber: permitNum,
          address,
          description,
          contractor: professional,
          status,
          issuedDate: issuedDate ? parseDate(issuedDate) : null,
          city: 'Phoenix'
        }
      }
    })

  console.log(`  [Phoenix PDD] ${records.length} total → ${items.length} commercial permits (excluding SHAP migrated)`)
  return items
}

function daysAgo(n) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d
}

function formatDate(d) {
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`
}

function parseDate(dateStr) {
  try {
    const d = new Date(dateStr)
    if (!isNaN(d.getTime())) return d.toISOString()
  } catch {}
  return new Date().toISOString()
}

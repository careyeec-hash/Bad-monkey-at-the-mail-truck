// Mesa building permits — Socrata Open Data API
// Endpoint: data.mesaaz.gov/resource/2gkz-7z4f.json
// No API key required (public, throttled)
// Fields: permit_number, property_address, description, value, type_of_work,
//         status, issued_date, applicant, contractor_name, total_sq_ft, latitude, longitude

const DATASET_URL = 'https://data.mesaaz.gov/resource/2gkz-7z4f.json'

export default async function fetchMesaPermits(source) {
  // Fetch permits issued in the last 30 days, commercial only (value >= $500K)
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - 30)
  const cutoffStr = cutoff.toISOString().split('T')[0]

  // Query all permits in date range — filter by use/value in JS below
  // Socrata value filter too aggressive; commercial permits can be under $500K at filing
  const params = new URLSearchParams({
    $where: `issued_date > '${cutoffStr}'`,
    $order: 'issued_date DESC',
    $limit: '500'
  })

  const res = await fetch(`${DATASET_URL}?${params}`, {
    headers: { 'User-Agent': 'BadMonkeyAgent/1.0 (construction-intelligence)' },
    signal: AbortSignal.timeout(15000)
  })

  if (!res.ok) {
    throw new Error(`Mesa Socrata API returned ${res.status}: ${res.statusText}`)
  }

  const records = await res.json()

  const items = records
    .filter(r => {
      // Filter for commercial construction (skip residential unless large)
      const use = (r.use || '').toUpperCase()
      const desc = (r.description || '').toLowerCase()
      const sqft = parseInt(r.total_sq_ft) || 0
      const value = parseInt(r.value) || 0

      // Keep: commercial, industrial, multifamily, or large residential
      if (use === 'COM' || use === 'IND') return true
      if (desc.includes('multi') || desc.includes('apartment') || desc.includes('hotel')) return true
      if (sqft >= 5000 || value >= 2000000) return true
      return false
    })
    .map(r => ({
      title: `Mesa Permit ${r.permit_number}: ${r.description || r.type_of_work || 'Building Permit'}`.slice(0, 200),
      url: `https://data.mesaaz.gov/resource/2gkz-7z4f.json?permit_number=${r.permit_number}`,
      source: source.name,
      sourceTier: source.tier,
      sourceCategory: source.category,
      date: r.issued_date || new Date().toISOString(),
      summary: [
        r.description,
        r.property_address ? `Address: ${r.property_address}` : null,
        r.value ? `Value: $${Number(r.value).toLocaleString()}` : null,
        r.total_sq_ft ? `${r.total_sq_ft} sq ft` : null,
        r.type_of_work ? `Type: ${r.type_of_work}` : null,
        r.contractor_name ? `Contractor: ${r.contractor_name}` : null,
        r.applicant ? `Applicant: ${r.applicant}` : null
      ].filter(Boolean).join('. '),
      rawContent: r,
      type: 'permit',
      permitData: {
        permitNumber: r.permit_number,
        address: r.property_address || '',
        description: r.description || '',
        valuation: r.value ? `$${Number(r.value).toLocaleString()}` : null,
        contractor: r.contractor_name || null,
        applicant: r.applicant || null,
        sqft: r.total_sq_ft || null,
        status: r.status || null,
        issuedDate: r.issued_date || null,
        workType: r.type_of_work || null,
        lat: r.latitude || null,
        lng: r.longitude || null
      }
    }))

  console.log(`  [Mesa Permits] ${records.length} total → ${items.length} commercial/large permits`)
  return items
}

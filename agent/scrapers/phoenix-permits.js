// Phoenix Open Data — Socrata API for commercial/multifamily permits
// Endpoint: data.phoenix.gov

const COMMERCIAL_TYPES = [
  'commercial', 'multi-family', 'multifamily', 'institutional',
  'industrial', 'mixed use', 'mixed-use', 'hotel', 'hospital',
  'school', 'church', 'office', 'retail', 'warehouse'
]

const EXCLUDE_TYPES = [
  'single family', 'single-family', 'sfr', 'residential single',
  'pool', 'fence', 'solar', 'reroof', 're-roof', 'water heater'
]

function isCommercial(record) {
  const desc = (record.description || '').toLowerCase()
  const type = (record.permit_type || record.type || '').toLowerCase()
  const combined = `${desc} ${type}`

  if (EXCLUDE_TYPES.some(t => combined.includes(t))) return false
  if (COMMERCIAL_TYPES.some(t => combined.includes(t))) return true

  // Check valuation — anything over $1M is worth looking at
  const val = parseFloat(record.valuation || record.estimated_value || '0')
  if (val >= 1000000) return true

  return false
}

export default async function fetchPhoenixPermits(source) {
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - 7)
  const cutoffStr = cutoff.toISOString().split('T')[0]

  // Socrata SoQL query — permits from the last 7 days
  const params = new URLSearchParams({
    '$where': `issue_date >= '${cutoffStr}'`,
    '$limit': '500',
    '$order': 'issue_date DESC'
  })

  const url = `${source.url}?${params}`
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) })

  if (!res.ok) {
    throw new Error(`Phoenix API returned ${res.status}: ${res.statusText}`)
  }

  const records = await res.json()

  const items = records
    .filter(isCommercial)
    .map(record => {
      const address = record.address || record.location || 'Unknown address'
      const description = record.description || record.permit_type || 'Commercial permit'
      const permitNumber = record.permit_number || record.permit_no || null
      const owner = record.owner_name || record.applicant || null
      const contractor = record.contractor_name || record.contractor || null
      const valuation = record.valuation || record.estimated_value || null

      return {
        title: `Phoenix Permit: ${description} — ${address}`,
        url: `https://data.phoenix.gov/resource/ieks-mgvz/${permitNumber || record.id || ''}`,
        source: source.name,
        sourceTier: source.tier,
        sourceCategory: source.category,
        date: record.issue_date || record.applied_date || new Date().toISOString(),
        summary: `Permit ${permitNumber ? '#' + permitNumber : ''} filed for ${description} at ${address}. ` +
          `${valuation ? 'Valuation: $' + Number(valuation).toLocaleString() + '. ' : ''}` +
          `${owner ? 'Owner: ' + owner + '. ' : ''}` +
          `Contractor: ${contractor || 'Not yet assigned'}`,
        rawContent: record,
        type: 'permit',
        permitData: {
          permitNumber,
          address,
          description,
          owner,
          contractor,
          valuation,
          permitType: record.permit_type || null,
          status: record.status || null,
          city: 'Phoenix'
        }
      }
    })

  console.log(`  [Phoenix Permits] ${records.length} total → ${items.length} commercial/multifamily`)
  return items
}

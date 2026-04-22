// Tempe building permits — ArcGIS Hub CSV download
// Source: data.tempe.gov (Permits Issued by Building Safety)
// Dataset ID: 55b38626464d48cb94e81cb8227d6fde_0
// Updated weekly from Accela Civic Platform
// Fields: PermitNum, Description, IssuedDate, Type, StatusCurrent, OriginalAddress1,
//         PermitClass, PermitType, TotalSqFt, EstProjectCost, ContractorCompanyName,
//         ProjectName, Zone, Latitude, Longitude

const CSV_URL = 'https://hub.arcgis.com/api/v3/datasets/55b38626464d48cb94e81cb8227d6fde_0/downloads/data?format=csv&spatialRefId=4326&where=1%3D1'

function parseCSV(text) {
  // Handle multi-line quoted fields by parsing character-by-character
  const headers = []
  const records = []
  let pos = 0
  let row = []
  let field = ''
  let inQuotes = false
  let headerParsed = false

  while (pos < text.length) {
    const ch = text[pos]

    if (inQuotes) {
      if (ch === '"') {
        if (pos + 1 < text.length && text[pos + 1] === '"') {
          field += '"' // escaped quote
          pos += 2
          continue
        }
        inQuotes = false
      } else {
        field += ch
      }
      pos++
      continue
    }

    if (ch === '"') {
      inQuotes = true
      pos++
      continue
    }

    if (ch === ',') {
      row.push(field.trim())
      field = ''
      pos++
      continue
    }

    if (ch === '\n' || ch === '\r') {
      // End of row
      if (ch === '\r' && pos + 1 < text.length && text[pos + 1] === '\n') pos++
      row.push(field.trim())
      field = ''

      if (!headerParsed) {
        headers.push(...row)
        headerParsed = true
      } else if (row.length > 1 || row[0] !== '') {
        const record = {}
        for (let j = 0; j < headers.length; j++) {
          record[headers[j]] = row[j] || ''
        }
        records.push(record)
      }
      row = []
      pos++
      continue
    }

    field += ch
    pos++
  }

  // Handle last row if no trailing newline
  if (field || row.length > 0) {
    row.push(field.trim())
    if (headerParsed && (row.length > 1 || row[0] !== '')) {
      const record = {}
      for (let j = 0; j < headers.length; j++) {
        record[headers[j]] = row[j] || ''
      }
      records.push(record)
    }
  }

  return records
}

export default async function fetchTempePermits(source) {
  const res = await fetch(CSV_URL, {
    headers: { 'User-Agent': 'BadMonkeyAgent/1.0 (construction-intelligence)' },
    signal: AbortSignal.timeout(30000) // CSV can be large
  })

  if (!res.ok) {
    throw new Error(`Tempe CSV download returned ${res.status}: ${res.statusText}`)
  }

  const text = await res.text()
  const allRecords = parseCSV(text)

  // Filter to recent permits (last 30 days) and commercial/large projects
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - 30)

  const records = allRecords.filter(r => {
    // Date filter — use IssuedDate
    const issued = r.IssuedDate || r.IssuedDateDtm
    if (!issued) return false
    const issuedDate = new Date(issued)
    if (issuedDate < cutoff) return false

    // Size/type filter — skip small residential
    const permitClass = (r.PermitClass || '').toLowerCase()
    const desc = (r.Description || '').toLowerCase()
    const cost = parseInt(r.EstProjectCost) || 0
    const sqft = parseInt(r.TotalSqFt) || 0
    const units = parseInt(r.HousingUnits) || 0

    // Keep: commercial, multi-family, large projects
    if (permitClass.includes('com') || permitClass.includes('multi')) return true
    if (desc.includes('multi') || desc.includes('apartment') || desc.includes('hotel')) return true
    if (desc.includes('commercial') || desc.includes('office') || desc.includes('retail')) return true
    if (cost >= 2000000 || sqft >= 5000 || units >= 4) return true
    return false
  })

  const maxItems = source.maxItemsPerRun || 50
  const limited = records.slice(0, maxItems)

  const items = limited.map(r => ({
    title: `Tempe Permit ${r.PermitNum}: ${r.ProjectName || r.Description || 'Building Permit'}`.slice(0, 200),
    url: `https://data.tempe.gov/datasets/tempegov::permits-issued-by-building-safety?where=PermitNum='${r.PermitNum}'`,
    source: source.name,
    sourceTier: source.tier,
    sourceCategory: source.category,
    date: r.IssuedDate || new Date().toISOString(),
    summary: [
      r.ProjectName || r.Description,
      r.OriginalAddress1 ? `Address: ${r.OriginalAddress1}, ${r.OriginalCity || 'Tempe'} AZ` : null,
      r.EstProjectCost && r.EstProjectCost !== '0' ? `Est. Cost: $${Number(r.EstProjectCost).toLocaleString()}` : null,
      r.TotalSqFt && r.TotalSqFt !== '0' ? `${r.TotalSqFt} sq ft` : null,
      r.HousingUnits && r.HousingUnits !== '0' ? `${r.HousingUnits} units` : null,
      r.PermitType ? `Type: ${r.PermitType}` : null,
      r.ContractorCompanyName ? `Contractor: ${r.ContractorCompanyName}` : null,
      r.Zone ? `Zone: ${r.Zone}` : null
    ].filter(Boolean).join('. '),
    rawContent: r,
    type: 'permit',
    permitData: {
      permitNumber: r.PermitNum,
      address: r.OriginalAddress1 || '',
      description: r.ProjectName || r.Description || '',
      valuation: r.EstProjectCost && r.EstProjectCost !== '0' ? `$${Number(r.EstProjectCost).toLocaleString()}` : null,
      contractor: r.ContractorCompanyName || null,
      sqft: r.TotalSqFt || null,
      units: r.HousingUnits || null,
      status: r.StatusCurrent || null,
      issuedDate: r.IssuedDate || null,
      permitClass: r.PermitClass || null,
      zone: r.Zone || null,
      lat: r.Latitude || null,
      lng: r.Longitude || null
    }
  }))

  console.log(`  [Tempe Permits] ${allRecords.length} total → ${records.length} recent commercial → ${items.length} returned`)
  return items
}

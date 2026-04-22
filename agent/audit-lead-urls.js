// One-off audit to find leads whose source_url domain looks unrelated to
// their source_name or project location. Surfaces the kind of mismatch that
// caused the "Chandler Bay Class A Industrial → mesacounty.us" bug.
//
// Usage: node agent/audit-lead-urls.js
//
// Read-only — it only prints. It does NOT modify the database.

import { supabase } from './db.js'

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return null }
}

// Domain hints that should correlate with a lead's source_name or project.
// If the host doesn't match ANY expected hint for its source_name, we flag it.
const SOURCE_DOMAIN_HINTS = {
  'Phoenix Permits': ['phoenix.gov'],
  'Phoenix Planning & Development': ['phoenix.gov'],
  'Scottsdale Accela': ['scottsdaleaz.gov', 'accela'],
  'Maricopa County': ['maricopa.gov'],
  'Mesa Permits': ['mesaaz.gov'],
  'Tempe Permits': ['tempe.gov'],
  'SAM.gov': ['sam.gov'],
  'Phoenix Business Journal': ['bizjournals.com'],
  'ENR': ['enr.com'],
  'AZRE': ['azremagazine', 'azbigmedia.com'],
  'Bisnow': ['bisnow.com'],
  'AZ Big Media': ['azbigmedia.com'],
  'AZ Commerce Authority': ['azcommerce.com'],
  'GPEC': ['gpec.org'],
  'TREO': ['treoaz.org'],
}

// Known-bad domain patterns — if a lead claims AZ but links here, flag it.
const RED_FLAG_HOSTS = [
  /mesacounty\.us$/i,   // Mesa County, Colorado (the Chandler Bay bug)
  /\.co\.us$/i,         // Colorado state/county sites
  /gov\.nm\.us$/i,      // New Mexico
]

async function main() {
  const { data: leads, error } = await supabase
    .from('leads')
    .select('id, project_name, address, source_name, source_url, created_at')
    .not('source_url', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1000)

  if (error) {
    console.error('Query failed:', error.message)
    process.exit(1)
  }

  console.log(`Auditing ${leads.length} leads with source URLs...\n`)

  const flagged = []
  for (const lead of leads) {
    const host = hostOf(lead.source_url)
    if (!host) {
      flagged.push({ lead, reason: 'invalid URL', host })
      continue
    }

    // Hard red-flag hosts
    if (RED_FLAG_HOSTS.some(rx => rx.test(host))) {
      flagged.push({ lead, reason: 'red-flag host (out-of-state/off-topic domain)', host })
      continue
    }

    // Source-name hint mismatch
    const sourceName = lead.source_name || ''
    const hintKey = Object.keys(SOURCE_DOMAIN_HINTS).find(k => sourceName.includes(k))
    if (hintKey) {
      const hints = SOURCE_DOMAIN_HINTS[hintKey]
      if (!hints.some(h => host.includes(h))) {
        flagged.push({ lead, reason: `source_name "${sourceName}" expected host containing [${hints.join(', ')}], got ${host}`, host })
      }
    }
  }

  if (flagged.length === 0) {
    console.log('✓ No suspicious URLs found.')
    return
  }

  console.log(`Flagged ${flagged.length} leads:\n`)
  for (const f of flagged) {
    console.log(`  ${f.lead.id}  [${f.lead.created_at?.slice(0, 10)}]`)
    console.log(`    project : ${f.lead.project_name}`)
    console.log(`    source  : ${f.lead.source_name}`)
    console.log(`    url host: ${f.host}`)
    console.log(`    reason  : ${f.reason}`)
    console.log(`    url     : ${f.lead.source_url}`)
    console.log('')
  }

  console.log(`Summary: ${flagged.length} / ${leads.length} leads have suspicious source URLs.`)
  console.log('Review these manually. To clear a bad URL, set source_url = NULL via the web app or SQL.')
}

main().catch(err => { console.error(err); process.exit(1) })

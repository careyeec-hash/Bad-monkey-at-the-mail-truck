// CRM module — lead management via Supabase
// Handles: lead creation, updates, dedup, stale detection, KPIs, source health, run logging

import { supabase } from './db.js'

// --- Address normalization for dedup ---

const STREET_ABBREVS = {
  'street': 'ST', 'avenue': 'AVE', 'boulevard': 'BLVD', 'drive': 'DR',
  'lane': 'LN', 'road': 'RD', 'court': 'CT', 'place': 'PL',
  'circle': 'CIR', 'way': 'WAY', 'parkway': 'PKWY', 'terrace': 'TER',
  'highway': 'HWY', 'north': 'N', 'south': 'S', 'east': 'E', 'west': 'W',
  'northeast': 'NE', 'northwest': 'NW', 'southeast': 'SE', 'southwest': 'SW'
}

export function normalizeAddress(address) {
  if (!address) return ''
  let normalized = address.toUpperCase().trim()

  // Remove apt/suite/unit numbers
  normalized = normalized.replace(/\b(APT|SUITE|STE|UNIT|#)\s*\S+/gi, '')

  // Expand abbreviations
  for (const [full, abbrev] of Object.entries(STREET_ABBREVS)) {
    normalized = normalized.replace(new RegExp(`\\b${full}\\b`, 'gi'), abbrev)
  }

  // Collapse whitespace
  normalized = normalized.replace(/\s+/g, ' ').trim()

  return normalized
}

// --- Lead ID generation ---

let dailySequence = 0
let lastDate = ''

function generateLeadId() {
  const today = new Date().toISOString().split('T')[0]
  if (today !== lastDate) {
    dailySequence = 0
    lastDate = today
  }
  dailySequence++
  return `lead-${today}-${String(dailySequence).padStart(3, '0')}`
}

// --- Core operations ---

export async function processLeads(evaluatedItems, profile) {
  console.log('\n--- CRM UPDATE PHASE ---')

  let created = 0
  let updated = 0

  const threshold = profile.digestThreshold || 5

  const qualifiedItems = evaluatedItems.filter(
    item => (item.actionability_score || 0) >= threshold
  )

  console.log(`  ${qualifiedItems.length} items score ${threshold}+ (of ${evaluatedItems.length} total)`)

  for (const item of qualifiedItems) {
    const address = item.permitData?.address || item.originalItem?.permitData?.address || ''
    const normalized = normalizeAddress(address)

    if (!normalized) {
      // No address — create as new lead
      await createLead(item, profile)
      created++
      continue
    }

    // Check for existing lead by normalized address
    const { data: existing } = await supabase
      .from('leads')
      .select('id, project_name')
      .eq('normalized_address', normalized)
      .limit(1)

    if (existing && existing.length > 0) {
      // Update existing lead
      const leadId = existing[0].id
      await supabase.from('agent_updates').insert({
        lead_id: leadId,
        briefing_date: new Date().toISOString().split('T')[0],
        update_text: `Agent update: ${item.one_line || 'New information found'}. Score: ${item.actionability_score}/10.`,
        source_url: item.url || item.originalItem?.url || null
      })
      updated++
    } else {
      // Create new lead
      await createLead(item, profile)
      created++
    }
  }

  console.log(`  CRM: ${created} leads created, ${updated} leads updated`)
  return { created, updated }
}

async function createLead(item, profile) {
  const id = generateLeadId()
  const address = item.permitData?.address || item.originalItem?.permitData?.address || item.one_line || ''
  const assignedTo = profile.company?.keyPeople?.[0]?.name || 'Unassigned'

  const lead = {
    id,
    project_name: item.one_line || item.originalItem?.title || 'Unknown Project',
    // Store rich content in why_it_matters as combined field
    address: address,
    normalized_address: normalizeAddress(address),
    project_type: item.project_type || null,
    estimated_value: item.estimated_value || null,
    stage: item.project_stage || null,
    gc_assigned: item.permitData?.contractor ? true : false,
    gc_name: item.permitData?.contractor || null,
    permit_number: item.permitData?.permitNumber || null,
    source_type: 'agent',
    source_name: item.originalItem?.source || null,
    source_category: item.category || item.originalItem?.sourceCategory || null,
    source_url: item.url || item.originalItem?.url || null,
    briefing_date: new Date().toISOString().split('T')[0],
    actionability_score: item.actionability_score,
    bristlecone_fit: item.bristlecone_fit || null,
    fit_type: item.fit_type || null,
    action_item: item.action_item || null,
    why_it_matters: [item.project_summary, item.why_it_matters, item.pitch_angle ? 'PITCH: ' + item.pitch_angle : ''].filter(Boolean).join('\n\n') || null,
    enrichment_needed: item.enrichment_needed || [],
    status: 'new',
    assigned_to: assignedTo,
    priority: item.actionability_score >= 8 ? 'high' : item.actionability_score >= 5 ? 'medium' : 'low',
    profile: profile.profileSlug,
    tags: []
  }

  const { error } = await supabase.from('leads').insert(lead)
  if (error) {
    console.log(`  Warning: Failed to create lead ${id}: ${error.message}`)
    return null
  }

  // Add initial note
  await supabase.from('lead_notes').insert({
    lead_id: id,
    author: 'agent',
    text: `Lead auto-created. Score ${item.actionability_score}/10. ${item.bristlecone_fit || ''}.`
  })

  // Add contacts if available
  if (item.key_contacts?.length > 0) {
    const contacts = item.key_contacts.map(c => ({
      lead_id: id,
      name: c.name,
      company: c.company || null,
      role: c.role || null
    }))
    await supabase.from('lead_contacts').insert(contacts)
  }

  return lead
}

// --- Stale lead detection ---

export async function detectStaleLeads() {
  const thirtyDaysAgo = new Date()
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

  const { data, error } = await supabase
    .from('leads')
    .select('id, project_name, status, updated_at')
    .eq('status', 'tracking')
    .lt('updated_at', thirtyDaysAgo.toISOString())

  if (error) {
    console.log(`  Warning: Could not check stale leads: ${error.message}`)
    return []
  }

  return data || []
}

// --- Source health tracking ---

export async function updateSourceHealth(sourceName, success, itemCount, errorMsg) {
  if (success) {
    await supabase.from('source_health').upsert({
      source_name: sourceName,
      last_success: new Date().toISOString(),
      consecutive_failures: 0,
      last_error: null,
      items_last_returned: itemCount || 0,
      updated_at: new Date().toISOString()
    }, { onConflict: 'source_name' })
  } else {
    // Increment consecutive failures
    const { data: existing } = await supabase
      .from('source_health')
      .select('consecutive_failures')
      .eq('source_name', sourceName)
      .single()

    const failures = (existing?.consecutive_failures || 0) + 1

    await supabase.from('source_health').upsert({
      source_name: sourceName,
      consecutive_failures: failures,
      last_error: errorMsg || 'Unknown error',
      updated_at: new Date().toISOString()
    }, { onConflict: 'source_name' })
  }
}

// --- Agent run logging ---

export async function logAgentRun(runData) {
  const { error } = await supabase.from('agent_runs').insert({
    profile: runData.profile,
    items_ingested: runData.itemsIngested || 0,
    items_filtered: runData.itemsFiltered || 0,
    items_evaluated: runData.itemsEvaluated || 0,
    hot_leads: runData.hotLeads || 0,
    watch_list: runData.watchList || 0,
    leads_created: runData.leadsCreated || 0,
    leads_updated: runData.leadsUpdated || 0,
    publish_success: runData.publishSuccess || false,
    email_sent: runData.emailSent || 'none',
    sources_checked: runData.sourcesChecked || 0,
    sources_failed: runData.sourcesFailed || 0,
    failures: runData.failures || [],
    abp_status: runData.abpStatus || null,
    estimated_cost: runData.estimatedCost || 0
  })

  if (error) {
    console.log(`  Warning: Failed to log agent run: ${error.message}`)
  }
}

// --- Seen items (Supabase-backed dedup) ---

export async function checkSeen(url) {
  const { data } = await supabase
    .from('seen_items')
    .select('url')
    .eq('url', url)
    .single()
  return !!data
}

export async function markSeen(urls, sourceName) {
  if (urls.length === 0) return
  const records = urls.map(url => ({
    url,
    source_name: sourceName || null
  }))
  await supabase.from('seen_items').upsert(records, { onConflict: 'url' })
}

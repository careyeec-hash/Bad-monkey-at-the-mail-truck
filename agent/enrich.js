// Enrichment module — auto-enriches high-scoring leads after CRM persistence
//
// Goal: Tom should never have to research who the developer is, who to call,
// or whether Bristlecone has prior history with the firm. The agent does that
// before he opens the lead.
//
// Pipeline placement: runs in run.js AFTER processLeads(), so leads exist in
// the DB and we can write enrichment back via UPDATE. Gated on
// profile.enrichmentThreshold (default 8) and profile.enrichmentDailyCap.
//
// Per-lead steps:
//   1. Fetch source article body and extract entities (Haiku)
//   2. Apollo org enrichment for developer + architect (cached 30 days)
//   3. Apollo people search for decision-makers at those firms
//   4. Cross-reference Bristlecone's prior leads/contacts for warm-intro angles
//   5. Opus synthesis to rewrite action_item with names + numbers + comps
//   6. Persist: UPDATE leads, INSERT lead_contacts, UPSERT enriched_organizations,
//      INSERT lead_notes (author='enrichment-agent') with the synthesis

import Anthropic from '@anthropic-ai/sdk'
import { supabase } from './db.js'

const client = new Anthropic()
const APOLLO_BASE = 'https://api.apollo.io/v1'
const CACHE_TTL_DAYS = 30

// --- Firm name normalization (cache key) ---
// Strips common org suffixes / punctuation so "Empire Group LLC" and
// "EMPIRE GROUP" hit the same cache row.

const ORG_SUFFIXES = /\b(LLC|L\.L\.C\.|INC|INC\.|CORP|CORP\.|CO|CO\.|LP|L\.P\.|LTD|LIMITED|GROUP|HOLDINGS|PARTNERS|DEVELOPMENT|DEVELOPERS|DEV|REAL ESTATE|REALTY|PROPERTIES|CAPITAL|VENTURES|COMPANY|COMPANIES|ENTERPRISES)\b/gi

export function normalizeFirmName(name) {
  if (!name) return ''
  return name
    .toLowerCase()
    .replace(ORG_SUFFIXES, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

// --- Step 1: Article fetch + entity extraction ---

async function fetchArticleBody(url) {
  if (!url) return null
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'BadMonkey/1.0 (+https://bad-monkey-mailtruck.vercel.app)' },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000)
    })
    if (!res.ok) return null
    const html = await res.text()
    // Strip HTML to text — naive but adequate as Haiku input
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 12000)
  } catch (err) {
    console.log(`    [Enrich] article fetch failed for ${url}: ${err.message}`)
    return null
  }
}

async function extractEntities(article, leadContext) {
  if (!article) return null
  const prompt = `Extract structured construction project entities from this article. Return JSON only, no markdown fences.

Lead context: ${JSON.stringify(leadContext)}

Article body:
${article}

Schema:
{
  "developer": "<firm name or null>",
  "architect": "<firm name or null>",
  "general_contractor": "<firm name or null>",
  "owner": "<firm name or null>",
  "address": "<street address or null>",
  "unit_count": <integer or null>,
  "estimated_value": "<dollar amount as string, e.g. '$25M' or '$15M-30M', or null>",
  "named_people": [{"name": "...", "role": "...", "company": "..."}],
  "key_dates": {"groundbreaking": "<date or null>", "completion": "<date or null>", "bid_due": "<date or null>"}
}

Rules:
- Only include fields explicitly stated in the article. Do not infer or guess.
- For people, only include named individuals (not "the developer says...").
- Return valid JSON. No prose before or after.`

  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }]
    })
    let text = msg.content[0].text
    text = text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim()
    return JSON.parse(text)
  } catch (err) {
    console.log(`    [Enrich] entity extraction failed: ${err.message}`)
    return null
  }
}

// --- Step 2 + 3: Apollo lookups (with cache) ---

async function getCachedOrg(normalizedName) {
  const { data } = await supabase
    .from('enriched_organizations')
    .select('*')
    .eq('normalized_name', normalizedName)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle()
  return data
}

async function apolloOrgEnrich(displayName) {
  if (!process.env.APOLLO_API_KEY) {
    console.log(`    [Enrich] APOLLO_API_KEY missing — Apollo lookups disabled`)
    return null
  }
  try {
    const res = await fetch(`${APOLLO_BASE}/organizations/enrich?q_organization_name=${encodeURIComponent(displayName)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': process.env.APOLLO_API_KEY,
        'accept': 'application/json'
      }
    })
    if (!res.ok) {
      console.log(`    [Enrich] Apollo org enrich ${res.status} for "${displayName}"`)
      return null
    }
    const json = await res.json()
    return json?.organization || null
  } catch (err) {
    console.log(`    [Enrich] Apollo org enrich error: ${err.message}`)
    return null
  }
}

async function apolloPeopleSearch(orgId, titles) {
  if (!orgId || !process.env.APOLLO_API_KEY) return []
  try {
    const res = await fetch(`${APOLLO_BASE}/mixed_people/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': process.env.APOLLO_API_KEY,
        'accept': 'application/json'
      },
      body: JSON.stringify({
        organization_ids: [orgId],
        person_titles: titles,
        per_page: 5
      })
    })
    if (!res.ok) return []
    const json = await res.json()
    return (json?.people || []).map(p => ({
      name: p.name,
      title: p.title,
      linkedin: p.linkedin_url,
      email: p.email,
      phone: p.phone_numbers?.[0]?.sanitized_number || null
    }))
  } catch {
    return []
  }
}

async function upsertOrg(normalizedName, displayName, orgType, apolloData, people) {
  const row = {
    normalized_name: normalizedName,
    display_name: displayName,
    org_type: orgType,
    apollo_id: apolloData?.id || null,
    website: apolloData?.website_url || null,
    hq_city: apolloData?.city || null,
    hq_state: apolloData?.state || null,
    employee_count: apolloData?.estimated_num_employees || null,
    industry: apolloData?.industry || null,
    founded_year: apolloData?.founded_year || null,
    linkedin_url: apolloData?.linkedin_url || null,
    decision_makers: people || [],
    raw_payload: apolloData || null,
    enriched_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + CACHE_TTL_DAYS * 86400000).toISOString()
  }
  const { data, error } = await supabase
    .from('enriched_organizations')
    .upsert(row, { onConflict: 'normalized_name' })
    .select()
    .single()
  if (error) {
    console.log(`    [Enrich] org upsert failed: ${error.message}`)
    return null
  }
  return data
}

async function enrichOrg(name, orgType) {
  if (!name) return null
  const normalized = normalizeFirmName(name)
  if (!normalized) return null

  const cached = await getCachedOrg(normalized)
  if (cached) {
    console.log(`    [Enrich] cache hit: ${name} (${orgType})`)
    return cached
  }

  const apollo = await apolloOrgEnrich(name)
  const titles = orgType === 'developer'
    ? ['Principal', 'Partner', 'Managing Director', 'Director of Development', 'VP Development', 'President', 'CEO']
    : orgType === 'architect'
      ? ['Principal', 'Partner', 'Director', 'Project Manager']
      : ['Principal', 'President', 'CEO', 'Project Executive', 'VP Operations']

  const people = apollo?.id ? await apolloPeopleSearch(apollo.id, titles) : []
  return await upsertOrg(normalized, name, orgType, apollo, people)
}

// --- Step 4: Warm-intro detection from prior Bristlecone history ---

async function findWarmIntros(orgNames) {
  const intros = []
  const seen = new Set()
  for (const name of orgNames.filter(Boolean)) {
    if (seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())
    const { data } = await supabase
      .from('lead_contacts')
      .select('lead_id, name, role, company, leads(project_name, status, updated_at)')
      .ilike('company', `%${name}%`)
      .limit(5)
    if (data?.length) intros.push({ org: name, prior: data })
  }
  return intros
}

// --- Step 5: Opus synthesis — rewrite action_item with concrete names ---

async function synthesizeNextAction(lead, entities, devOrg, archOrg, warmIntros) {
  const prompt = `You are advising Tom Keilty (Principal at Bristlecone Construction, Phoenix expansion lead) on a specific construction lead. Rewrite the next-action recommendation using the enriched intel below — concrete names, phone numbers, comp projects to lead with. Keep it to 2-3 sentences. Direct prescriptions only. No "consider" / "explore" hedging.

Lead: ${lead.project_name} (${lead.address || 'address TBD'})
Score: ${lead.actionability_score}/10
Current next-action: ${lead.action_item || '(none)'}

Article-extracted entities:
${JSON.stringify(entities || {}, null, 2)}

Developer firm intel:
${devOrg ? JSON.stringify({
  name: devOrg.display_name,
  hq: `${devOrg.hq_city || '?'}, ${devOrg.hq_state || '?'}`,
  size: devOrg.employee_count,
  decision_makers: devOrg.decision_makers
}, null, 2) : '(no developer enrichment)'}

Architect firm intel:
${archOrg ? JSON.stringify({
  name: archOrg.display_name,
  decision_makers: archOrg.decision_makers
}, null, 2) : '(no architect enrichment)'}

Bristlecone's prior interactions with these firms:
${warmIntros.length ? JSON.stringify(warmIntros, null, 2) : '(none — cold outreach)'}

Bristlecone portfolio comps to lead with (pick the most relevant): Catbird Hotel (boutique hospitality), Edgewater Public Market (urban mixed-use), Harvard Square Memory Care (institutional/senior), Cirrus Apartments (multifamily), AC Hotel RiNo (hospitality), YMCA Renovation (adaptive reuse), Jacques French Restaurant (design-forward F&B).

Return JSON only:
{
  "next_action": "<rewritten directive — name the person, the number/email if known, the Bristlecone comp project to lead with>",
  "warm_intro_angle": "<one sentence on the warmest in-road from the prior interactions, or null if cold>"
}`

  try {
    const msg = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }]
    })
    let text = msg.content[0].text
    text = text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim()
    return JSON.parse(text)
  } catch (err) {
    console.log(`    [Enrich] synthesis failed: ${err.message}`)
    return null
  }
}

// --- Per-lead orchestrator ---

async function enrichLead(lead) {
  console.log(`  → ${lead.id} "${lead.project_name}" (score ${lead.actionability_score})`)

  await supabase.from('leads').update({ enrichment_status: 'pending' }).eq('id', lead.id)

  const article = await fetchArticleBody(lead.source_url)
  const entities = await extractEntities(article, {
    project_name: lead.project_name,
    address: lead.address,
    project_type: lead.project_type
  })

  if (!entities) {
    await supabase.from('leads').update({
      enrichment_status: 'failed',
      enriched_at: new Date().toISOString()
    }).eq('id', lead.id)
    return { id: lead.id, status: 'failed', reason: 'no entities extracted' }
  }

  const [devOrg, archOrg] = await Promise.all([
    enrichOrg(entities.developer, 'developer'),
    enrichOrg(entities.architect, 'architect')
  ])

  const warmIntros = await findWarmIntros([
    entities.developer,
    entities.architect,
    entities.general_contractor
  ])

  const synthesis = await synthesizeNextAction(lead, entities, devOrg, archOrg, warmIntros)

  // --- Persist ---

  const updates = {
    enrichment_status: 'done',
    enriched_at: new Date().toISOString()
  }
  if (entities.general_contractor && !lead.gc_assigned) {
    updates.gc_assigned = true
    updates.gc_name = entities.general_contractor
  }
  if (entities.estimated_value && !lead.estimated_value) {
    updates.estimated_value = entities.estimated_value
  }
  if (synthesis?.next_action) {
    updates.action_item = synthesis.next_action
  }
  await supabase.from('leads').update(updates).eq('id', lead.id)

  // Build contact list — Apollo people first (have phone/email), then named people from article
  const contacts = []
  const seenNames = new Set()
  const addContact = (c) => {
    const key = `${(c.name || '').toLowerCase()}|${(c.company || '').toLowerCase()}`
    if (!c.name || seenNames.has(key)) return
    seenNames.add(key)
    contacts.push(c)
  }

  for (const p of devOrg?.decision_makers || []) {
    addContact({
      lead_id: lead.id,
      organization_id: devOrg.id,
      name: p.name,
      company: devOrg.display_name,
      role: p.title,
      phone: p.phone || null,
      email: p.email || null,
      notes: p.linkedin ? `LinkedIn: ${p.linkedin}` : null
    })
  }
  for (const p of archOrg?.decision_makers || []) {
    addContact({
      lead_id: lead.id,
      organization_id: archOrg.id,
      name: p.name,
      company: archOrg.display_name,
      role: p.title,
      phone: p.phone || null,
      email: p.email || null,
      notes: p.linkedin ? `LinkedIn: ${p.linkedin}` : null
    })
  }
  for (const p of entities.named_people || []) {
    addContact({
      lead_id: lead.id,
      name: p.name,
      company: p.company || null,
      role: p.role || null
    })
  }

  if (contacts.length > 0) {
    const { error } = await supabase.from('lead_contacts').insert(contacts)
    if (error) console.log(`    [Enrich] contact insert failed: ${error.message}`)
  }

  await supabase.from('lead_notes').insert({
    lead_id: lead.id,
    author: 'enrichment-agent',
    text: [
      synthesis?.warm_intro_angle ? `WARM INTRO: ${synthesis.warm_intro_angle}` : null,
      devOrg ? `DEVELOPER: ${devOrg.display_name}${devOrg.hq_city ? ` (${devOrg.hq_city}, ${devOrg.hq_state || ''})` : ''}${devOrg.employee_count ? ` — ~${devOrg.employee_count} employees` : ''}${devOrg.industry ? ` — ${devOrg.industry}` : ''}` : null,
      archOrg ? `ARCHITECT: ${archOrg.display_name}` : null,
      entities.unit_count ? `UNITS: ${entities.unit_count}` : null,
      entities.estimated_value ? `VALUE: ${entities.estimated_value}` : null,
      contacts.length > 0 ? `${contacts.length} contact${contacts.length === 1 ? '' : 's'} added (${contacts.filter(c => c.phone || c.email).length} with direct contact info)` : null,
      warmIntros.length > 0 ? `${warmIntros.length} prior firm interaction${warmIntros.length === 1 ? '' : 's'} found in CRM` : null
    ].filter(Boolean).join('\n')
  })

  return {
    id: lead.id,
    status: 'done',
    contacts: contacts.length,
    devOrg: devOrg?.display_name,
    archOrg: archOrg?.display_name
  }
}

// --- Pipeline entry ---

export default async function enrich(profile) {
  console.log('\n--- ENRICHMENT PHASE ---')

  const threshold = profile.enrichmentThreshold || 8
  const dailyCap = profile.enrichmentDailyCap || 20

  // Candidates: high-score, status open, not yet enriched (or previously failed).
  // We retry failed leads each run — cheap if the source URL is dead, valuable
  // if the article briefly 503'd.
  const { data: candidates, error } = await supabase
    .from('leads')
    .select('*')
    .gte('actionability_score', threshold)
    .or('enrichment_status.is.null,enrichment_status.eq.failed')
    .in('status', ['new', 'tracking', 'pursuing'])
    .order('actionability_score', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(dailyCap)

  if (error) {
    console.log(`  Could not load enrichment candidates: ${error.message}`)
    return { enriched: 0, failed: 0 }
  }

  if (!candidates || candidates.length === 0) {
    console.log(`  No leads need enrichment (threshold ${threshold}+)`)
    return { enriched: 0, failed: 0 }
  }

  console.log(`  ${candidates.length} candidate${candidates.length === 1 ? '' : 's'} (threshold ${threshold}+, daily cap ${dailyCap})`)

  let enriched = 0
  let failed = 0
  for (const lead of candidates) {
    try {
      const result = await enrichLead(lead)
      if (result.status === 'done') enriched++
      else failed++
    } catch (err) {
      console.log(`    [Enrich] hard failure on ${lead.id}: ${err.message}`)
      failed++
      await supabase.from('leads').update({
        enrichment_status: 'failed',
        enriched_at: new Date().toISOString()
      }).eq('id', lead.id)
    }
  }

  console.log(`  Enrichment: ${enriched} enriched, ${failed} failed`)
  return { enriched, failed }
}

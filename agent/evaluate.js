// Evaluation module — core intelligence engine
// Sends filtered items to Claude Opus for scoring through the active profile
// Returns structured briefing data sorted by actionability score

import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import Anthropic from '@anthropic-ai/sdk'
import { supabase } from './db.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const client = new Anthropic()

const BATCH_SIZE = 15

function buildSystemPrompt(profile, existingLeads) {
  const p = profile

  let prompt = `You are a construction market intelligence analyst creating a daily briefing for ${p.profileName}, a ${p.company.type} based in ${p.company.headquarters}.

COMPANY CONTEXT:
${p.company.differentiators.map(d => '- ' + d).join('\n')}
Expanding into ${p.location.primary} and ${p.location.secondary.join(', ')}.

Sweet spot: ${p.projectFit.strongFit.join(', ')}
Also interested in: ${p.projectFit.possibleFit.join(', ')}
Concrete scope opportunities: ${p.projectFit.concreteScopeOnly.join('; ')}
Not a fit: ${p.projectFit.notAFit.join(', ')}
Delivery preferences: ${JSON.stringify(p.projectFit.deliveryMethods)}
Best clients: ${p.projectFit.bestClients}`

  if (p.targetDevelopers?.length > 0) {
    prompt += `\n\nTARGET DEVELOPERS (boost score +2 if these appear):\n${p.targetDevelopers.join(', ')}`
  }

  if (p.targetArchitects?.length > 0) {
    prompt += `\n\nTARGET ARCHITECTS (boost score +2 if these appear):\n${p.targetArchitects.join(', ')}`
  }

  if (p.competitors?.length > 0) {
    prompt += `\n\nKEY COMPETITORS (flag wins, hires, capacity signals):\n${p.competitors.join(', ')}`
  }

  if (existingLeads.length > 0) {
    const leadList = existingLeads
      .slice(0, 50) // limit context size
      .map(l => `- [${l.id}] ${l.project_name} — ${l.normalized_address}`)
      .join('\n')
    prompt += `\n\nEXISTING TRACKED LEADS (check for updates — match by address):\n${leadList}`
  }

  prompt += `

For each item provide:
- actionability_score (1-10)
- category: permit | rfp | project | market | competitive | economic
- project_type: multifamily | commercial | institutional | industrial | hospitality | mixed-use | infrastructure | unknown
- estimated_value: dollar range if detectable, null if not
- project_stage: planning | entitled | permitted | bidding | under-construction | completed | unknown
- bristlecone_fit: strong-fit | possible-fit | concrete-scope | monitor | not-a-fit
- fit_type: gc-scope | concrete-scope | both
- one_line: concise project name (e.g. "Halo Vista Mixed-Use — N Phoenix" not a full sentence)
- project_summary: 2-3 sentence factual summary of the project — what's being built, where, how big, by whom
- action_item: specific next step Tom should take RIGHT NOW. Be prescriptive — name the person to call, the angle to pitch, the relationship to leverage. For GC scope: "Call [developer] — pitch early preconstruction collaboration and cost certainty." For concrete scope: "Identify the GC and call to bid structural concrete." Always match Tom's pursuit process: network intro → phone → LinkedIn → email → quals.
- pitch_angle: 1-2 sentences on WHY Bristlecone is the right fit for this specific project and what angle Tom should lead with (e.g. "Lead with your adaptive reuse track record — this project needs a builder who thrives on complexity" or "Pitch self-perform concrete — vertical pour on a project this size is your sweet spot")
- key_contacts: [{ name, company, role }] extracted from the content. Include developers, architects, GCs, owners mentioned.
- why_it_matters: 2-3 sentences explaining strategic importance for Bristlecone's Phoenix expansion
- existing_lead_match: lead ID if updates an existing lead, null otherwise
- enrichment_needed: array of what additional info would help (e.g. "architect of record", "GC shortlist", "bid deadline", "delivery method")

SCORING GUIDANCE:
Actionability: ${p.scoringGuidance.actionability}
Timing: ${p.scoringGuidance.timing}
Project Fit: ${p.scoringGuidance.projectFit}
Project Scale: ${p.scoringGuidance.projectScale}
Competitive Position: ${p.scoringGuidance.competitivePosition}
Pursuit Match: ${p.scoringGuidance.pursuitMatch}

IMPORTANT — GC FIELD NOTE:
${p.scoringGuidance.gcFieldNote}

Be aggressive about scoring. Most items = 3-5.
Reserve 8-10 for act-this-week items.
A target developer's new project = always 8+.
An RFP due in 10 days for institutional = always 9+.
A competitor winning a large project = 6 (track it).
A concrete-scope opportunity on a $50M project = 7.

Respond in JSON only. No markdown fences. Return a JSON array of objects.
Sort by actionability_score descending.`

  return prompt
}

async function evaluateBatch(items, systemPrompt) {
  const itemData = items.map(item => ({
    url: item.url,
    title: item.title,
    source: item.source,
    sourceCategory: item.sourceCategory,
    date: item.date,
    summary: item.summary,
    type: item.type,
    permitData: item.permitData || null
  }))

  const message = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 8192,
    system: systemPrompt,
    messages: [{
      role: 'user',
      content: `Evaluate these ${items.length} items:\n\n${JSON.stringify(itemData, null, 2)}`
    }]
  })

  let text = message.content[0].text
  // Strip markdown fences if present
  text = text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim()
  try {
    return JSON.parse(text)
  } catch {
    console.log('  [Evaluate] Warning: could not parse Opus response')
    console.log('  [Evaluate] Raw response:', text.slice(0, 300))
    return []
  }
}

export default async function evaluate(items, profileName) {
  console.log('\n--- EVALUATE PHASE ---')

  if (items.length === 0) {
    console.log('  No items to evaluate')
    return []
  }

  // Load profile
  const profilePath = join(__dirname, 'profiles', `${profileName}.json`)
  const profile = JSON.parse(readFileSync(profilePath, 'utf-8'))

  // Load existing active leads from Supabase for cross-referencing
  let existingLeads = []
  try {
    const { data } = await supabase
      .from('leads')
      .select('id, project_name, normalized_address')
      .in('status', ['new', 'tracking', 'pursuing'])
      .order('created_at', { ascending: false })
      .limit(100)
    existingLeads = data || []
  } catch (err) {
    console.log(`  Warning: Could not load existing leads: ${err.message}`)
  }

  const systemPrompt = buildSystemPrompt(profile, existingLeads)

  // Batch items and send to Opus
  const allResults = []

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE)
    const batchNum = Math.floor(i / BATCH_SIZE) + 1
    const totalBatches = Math.ceil(items.length / BATCH_SIZE)

    console.log(`  Batch ${batchNum}/${totalBatches} (${batch.length} items) → Opus...`)

    const results = await evaluateBatch(batch, systemPrompt)

    // Merge original item data with evaluation results
    for (const result of results) {
      const originalItem = batch.find(item => item.url === result.url) || batch.find(item => item.title === result.title)
      allResults.push({
        ...result,
        originalItem: originalItem || null
      })
    }
  }

  // Sort by score descending
  allResults.sort((a, b) => (b.actionability_score || 0) - (a.actionability_score || 0))

  const hotLeads = allResults.filter(r => r.actionability_score >= 8).length
  const watchList = allResults.filter(r => r.actionability_score >= 5 && r.actionability_score < 8).length

  console.log(`  Evaluated ${allResults.length} items: ${hotLeads} hot (8+), ${watchList} watch (5-7)`)

  return allResults
}

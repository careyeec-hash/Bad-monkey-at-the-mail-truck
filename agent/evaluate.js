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

PRIMARY BUSINESS — READ THIS FIRST:
${p.scoringGuidance?.primaryTrack || 'Bristlecone pursues GC work primarily; concrete sub is a secondary track.'}

COMPANY CONTEXT:
${p.company.differentiators.map(d => '- ' + d).join('\n')}
Expanding into ${p.location.primary} and ${p.location.secondary.join(', ')}.

PRIMARY BUSINESS SWEET SPOT (GC pursuit work — the focus):
${p.projectFit.strongFit.map(s => '- ' + s).join('\n')}

Also interested in (GC pursuit, secondary fit):
${p.projectFit.possibleFit.map(s => '- ' + s).join('\n')}

SECONDARY TRACK — Concrete sub-scope opportunities (only when a competitor GC has won the project):
${p.projectFit.concreteScopeOnly.map(s => '- ' + s).join('\n')}

Not a fit (drop or score 1-2):
${p.projectFit.notAFit.map(s => '- ' + s).join('\n')}

Delivery preferences: ${JSON.stringify(p.projectFit.deliveryMethods)}
Best clients: ${p.projectFit.bestClients}`

  if (p.location?.targetSubmarkets?.length > 0) {
    prompt += `\n\nTARGET SUBMARKETS (apply +1 score boost when a project is in one of these — per Tom's intake):\n${p.location.targetSubmarkets.map(s => '- ' + s).join('\n')}`
  }

  if (p.distressedSignals) {
    prompt += `\n\nDISTRESSED / RESCUE OPPORTUNITY DETECTION (Tom: 'broken, foreclosed, hairy projects are right in our wheelhouse'):
Watch for these keywords in the text and treat any match as a HIGH-VALUE signal:
${p.distressedSignals.keywords.map(k => '- "' + k + '"').join('\n')}
Scoring impact: ${p.distressedSignals.scoringImpact}`
  }

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
- idx: ECHO THE EXACT idx FIELD FROM THE INPUT ITEM. This is mandatory. Every result MUST include idx. Do not invent, renumber, or omit idx values.
- actionability_score (1-10)
- category: permit | rfp | project | market | competitive | economic
- project_type: multifamily | commercial | institutional | industrial | hospitality | mixed-use | infrastructure | unknown
- estimated_value: dollar range if detectable, null if not
- project_stage: planning | entitled | permitted | bidding | under-construction | completed | unknown
- bristlecone_fit: strong-fit | possible-fit | concrete-scope | monitor | not-a-fit
- fit_type: gc-scope | concrete-scope | both — CHOOSE CAREFULLY using the rules below
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

FIT_TYPE RULES — pick exactly one, follow this decision tree EXACTLY:

STEP 1: Is a specific General Contractor explicitly named in the item text as having WON or being AWARDED the project? (Not just "shortlisted", not just "considering" — explicitly named as the winner.)
- NO → fit_type = "gc-scope". STOP. Do not consider concrete-scope. The project is a GC pursuit opportunity for Bristlecone regardless of project type, location, or proximity to TSMC.
- YES, and the named GC is on the competitors list → go to STEP 2.
- YES, and the named GC is NOT a competitor → fit_type = "gc-scope" (Tom may know someone on that GC's team).

STEP 2: A competitor GC is named. Does the project have substantial structural concrete content? (high-rise, mid-rise with podium, parking structure, data center, semiconductor fab, large industrial slab pour)
- YES → fit_type = "concrete-scope". Action: call the winning GC to bid concrete sub.
- NO → fit_type = "gc-scope" but score it lower since it's locked up.

STEP 3: "both" — almost never use this. Only when a multi-phase development has some phases with GCs assigned and others without. If uncertain, pick "gc-scope".

CRITICAL CLARIFICATIONS:
- "TSMC area" / "TSMC-adjacent" / "near TSMC" does NOT mean concrete-scope. TSMC itself is a semiconductor fab. Mixed-use, multifamily, and commercial projects in the TSMC area are normal GC pursuit work — they happen to be near a big employer driving demand. Score these HIGH (target submarket boost + Phoenix demand driver).
- "Master plan" / "master-plan" / "master planned community" = gc-scope. Master plans by definition don't have GCs assigned yet.
- Mixed-use developments without a named GC = gc-scope. Period.

DO NOT default to "both" out of caution. Almost every legitimate lead is gc-scope.

SCORING — BE GENEROUS, NOT STINGY (but enforce the floors and ceilings below):
- Score 4+ for anything construction-related in the Phoenix metro WITH a specific named project (not industry stats)
- Score 5+ for any project with a named developer, architect, or address
- Score 6+ for any project where Tom could take an action
- Score 7+ for projects matching Bristlecone's GC pursuit sweet spot (multifamily, mixed-use, hospitality, institutional, adaptive reuse) in Phoenix metro
- Score 8+ for act-this-week items with specific contacts
- Score 9+ for target developer projects or RFPs with deadlines
- A target developer's new project = always 8+
- A competitor GC winning a large project = MAX 6 (concrete sub track is capped — it's secondary)
- ANY project with no GC assigned in Bristlecone's sweet spot = 7+
- Industry stats, employment data, market roundups, "Top 5 deals" articles with no specific named project = MAX 3 (these should usually be filtered before reaching you)
- "100% leased" / "fully leased" announcements about already-built buildings = MAX 2 (the building exists; nothing to build)
- TARGET SUBMARKET BOOST: After computing the base score, if the project is in Downtown Phoenix, Camelback corridor, Tempe Town Lake, Scottsdale Airpark, the I-17 industrial corridor, the West Valley growth nodes (Glendale/Goodyear/Surprise/Buckeye), or the TSMC-adjacent N Phoenix area: ADD +1 to the final score. This is mandatory, not optional. Tom called these out specifically in the intake.
- Phoenix demand-driver proximity: Projects adjacent to TSMC, major employers, or new transit lines get the same +1 boost as target submarkets.

CRITICAL — BRISTLECONE FIT: For EVERY item scored 4+, you MUST explain specifically why this matters to Bristlecone and what angle Tom should use. Reference Bristlecone's PRIMARY differentiators in this order: design-forward complex projects, early preconstruction collaboration with developers, comfort with adaptive reuse and distressed/hairy projects, new market entry hunger, AND (only when relevant) self-perform structural concrete. Every project_summary and pitch_angle must be filled in for items 4+.

CRITICAL — ARCHITECT EXTRACTION: ${p.scoringGuidance?.architectExtraction || 'Extract architect names into key_contacts when present.'}`

  // Inject few-shot calibration examples if available in profile
  if (p.fewShotExamples?.length > 0) {
    prompt += `\n\nSCORING CALIBRATION EXAMPLES — use these to anchor your scoring consistency:`
    for (const ex of p.fewShotExamples) {
      prompt += `\n- "${ex.title}" → Score ${ex.score}: ${ex.reasoning}`
    }
  }

  // Inject minimum/maximum scores for known patterns
  if (p.minimumScores?.length > 0) {
    prompt += `\n\nMINIMUM / MAXIMUM SCORES — when you see these patterns, override your initial score:`
    for (const rule of p.minimumScores) {
      const bound = rule.minScore !== undefined && rule.maxScore !== undefined
        ? `clamp to ${rule.minScore}-${rule.maxScore}`
        : rule.minScore !== undefined
          ? `minimum ${rule.minScore}`
          : `maximum ${rule.maxScore}`
      prompt += `\n- ${rule.pattern} → ${bound} (${rule.rationale})`
    }
  }
  // Backwards-compat: still honor scoreFloors if a profile hasn't been migrated
  else if (p.scoreFloors?.length > 0) {
    prompt += `\n\nMINIMUM SCORES — when you see these patterns, override your initial score if lower:`
    for (const floor of p.scoreFloors) {
      prompt += `\n- ${floor.condition} → minimum ${floor.minScore} (${floor.note})`
    }
  }

  prompt += `\n\nRespond in JSON only. No markdown fences. Return a JSON array of objects.
Sort by actionability_score descending.`

  return prompt
}

async function evaluateBatch(items, systemPrompt) {
  // Attach a stable idx to every item so we can join results back reliably,
  // even when Opus reorders, rewrites titles, or drops/hallucinates URLs.
  const itemData = items.map((item, idx) => ({
    idx,
    title: item.title,
    source: item.source,
    sourceCategory: item.sourceCategory,
    date: item.date,
    summary: item.summary,
    type: item.type,
    permitData: item.permitData || null
  }))

  const instruction = `Evaluate these ${items.length} items. Each item has an "idx" field — YOU MUST echo that exact idx back in every result object so we can join scoring back to the source. Do not invent, reorder, or omit idx values.

${JSON.stringify(itemData, null, 2)}`

  const message = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 8192,
    system: systemPrompt,
    messages: [{ role: 'user', content: instruction }]
  })

  let text = message.content[0].text
  // Strip markdown fences if present
  text = text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim()
  try {
    return JSON.parse(text)
  } catch {
    console.log('  [Evaluate] Warning: could not parse Opus response, creating stubs for manual review')
    console.log('  [Evaluate] Raw response:', text.slice(0, 300))
    // Keep-on-failure: create stub results that carry idx so crm handoff stays correct
    return items.map((item, idx) => ({
      idx,
      title: item.title,
      actionability_score: 0,
      category: item.sourceCategory || 'unknown',
      project_type: 'unknown',
      one_line: item.title || 'Evaluation parse error — manual review needed',
      project_summary: 'Automated evaluation failed to parse. This item needs manual review.',
      action_item: 'Review this item manually — agent evaluation encountered a parse error.',
      _evaluationError: true
    }))
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

    // Merge evaluation results with the original scraped items.
    // Match STRICTLY by idx — Opus reorders (sort-by-score) and rewrites titles,
    // so URL/title/positional matching produced cross-contamination between items
    // (wrong source URLs on leads). idx is a number Opus can echo but can't fuzz.
    const used = new Set()
    for (const result of results) {
      const idx = Number.isInteger(result?.idx) ? result.idx : -1
      const originalItem = idx >= 0 && idx < batch.length ? batch[idx] : null

      if (!originalItem) {
        console.log(`  [Evaluate] Warning: dropping result with invalid idx=${result?.idx} ("${(result?.one_line || result?.title || '').slice(0, 60)}") — cannot match to scraped item`)
        continue
      }
      if (used.has(idx)) {
        console.log(`  [Evaluate] Warning: duplicate idx=${idx} from Opus — keeping first, dropping "${(result?.one_line || '').slice(0, 60)}"`)
        continue
      }
      used.add(idx)

      // Always take the source URL from the scraper, never from Opus output.
      // Opus sometimes echoes URLs from other items in the same batch (hallucination),
      // which is how wrong source links ended up on leads.
      result.url = originalItem.url || null

      allResults.push({ ...result, originalItem })
    }

    // Log any scraped items Opus silently dropped so nothing vanishes quietly.
    for (let j = 0; j < batch.length; j++) {
      if (!used.has(j)) {
        console.log(`  [Evaluate] Warning: Opus did not return a result for batch idx=${j} ("${(batch[j]?.title || '').slice(0, 60)}")`)
      }
    }
  }

  // Sort by score descending
  allResults.sort((a, b) => (b.actionability_score || 0) - (a.actionability_score || 0))

  const hotLeads = allResults.filter(r => r.actionability_score >= 8).length
  const watchList = allResults.filter(r => r.actionability_score >= 5 && r.actionability_score < 8).length

  console.log(`  Evaluated ${allResults.length} items: ${hotLeads} hot (8+), ${watchList} watch (5-7)`)

  // Diagnostic: show every scored item so we can see what Opus actually decided
  // (especially useful for items that fall below digestThreshold and otherwise vanish)
  for (const r of allResults) {
    const score = r.actionability_score ?? '?'
    const fit = r.fit_type || '-'
    const oneLine = (r.one_line || r.title || '(no title)').slice(0, 80)
    console.log(`    [${score}] ${fit.padEnd(14)} ${oneLine}`)
  }

  return allResults
}

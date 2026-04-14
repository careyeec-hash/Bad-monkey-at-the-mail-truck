// POST /api/outreach — generates personalized outreach drafts using Claude
// Performs deep research on the project/person and drafts email + LinkedIn message

export async function POST({ request }) {
  const body = await request.json()
  const { lead, contactName, contactRole, contactCompany } = body

  if (!lead) {
    return new Response(JSON.stringify({ error: 'Lead data required' }), { status: 400 })
  }

  const apiKey = import.meta.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }), { status: 500 })
  }

  const targetPerson = contactName
    ? `${contactName}${contactRole ? ` (${contactRole})` : ''}${contactCompany ? ` at ${contactCompany}` : ''}`
    : null

  const prompt = `You are a business development assistant for Bristlecone Construction, a regional GC and self-perform structural concrete contractor expanding into the Phoenix/Tucson AZ market.

BRISTLECONE CONTEXT:
- Founded 2014, HQ Littleton CO, expanding to Phoenix/Tucson AZ
- Principal for AZ expansion: Tom Keilty
- Project range: $500K–$80M, sweet spot $5M–$40M
- Core strengths: Multifamily (~60% of portfolio), hospitality, mixed-use, adaptive reuse
- Self-performs structural concrete
- Delivery: Negotiated, Design-Build, CM-at-Risk preferred
- Differentiator: Design-forward, craft-focused ("Constructing value by valuing craft")
- 45+ completed projects in CO including Cirrus Apartments, Catbird Hotel, AC Hotel RiNo, Edgewater Public Market

PROJECT DETAILS:
- Name: ${lead.project_name}
- Address: ${lead.address || 'Unknown'}
- Type: ${lead.project_type || 'Unknown'}
- Estimated Value: ${lead.estimated_value || 'Unknown'}
- Stage: ${lead.stage || 'Unknown'}
- GC Assigned: ${lead.gc_assigned ? (lead.gc_name || 'Yes') : 'No / Unknown'}
- Fit Type: ${lead.fit_type || 'Unknown'}
- Source: ${lead.source_name || lead.source_type || 'Unknown'}
- Analysis: ${lead.why_it_matters || 'None available'}
- Action Item: ${lead.action_item || 'None'}
${targetPerson ? `\nTARGET CONTACT: ${targetPerson}` : ''}

TASK:
1. First, provide a brief RESEARCH SUMMARY (3-5 bullet points) about what you can infer or know about this project, the key players, and the opportunity for Bristlecone. Think about:
   - What stage is this project in and what does that mean for BD timing?
   - Who are the likely decision-makers?
   - What's Bristlecone's angle (GC pursuit, concrete sub, or both)?
   - Any competitive considerations?
   - What relevant Bristlecone projects could serve as references?

2. Draft a SHORT, WARM OUTREACH EMAIL from Tom Keilty. Guidelines:
   - Subject line that references the specific project
   - 3-4 paragraphs max, conversational but professional
   - Lead with genuine interest in the project, not a sales pitch
   - Reference 1-2 relevant Bristlecone projects naturally
   - Clear but soft call-to-action (coffee, site visit, quick call)
   - Tom's tone: direct, builder-to-builder, no corporate fluff
   - Sign off as Tom Keilty, Principal, Bristlecone Construction

3. Draft a SHORT LINKEDIN MESSAGE (connection request or InMail). Guidelines:
   - 2-3 sentences max
   - Reference the specific project
   - Personal, not templated
   - Suggest connecting to discuss

Return your response as JSON with this exact structure:
{
  "research": "bullet point research summary as a string with newlines",
  "email": {
    "subject": "email subject line",
    "body": "full email body"
  },
  "linkedin": "linkedin message text"
}

Return ONLY valid JSON, no markdown fences.`

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
      }),
    })

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}))
      return new Response(JSON.stringify({ error: errData.error?.message || `Claude API error: ${res.status}` }), { status: 502 })
    }

    const data = await res.json()
    const text = data.content?.[0]?.text || ''

    // Parse JSON response — strip markdown fences if present
    const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim()
    const result = JSON.parse(cleaned)

    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' }
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || 'Failed to generate outreach' }), { status: 500 })
  }
}

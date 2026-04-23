import { supabase } from '../../../lib/supabase.js'

export async function GET({ params }) {
  const { id } = params

  const { data, error } = await supabase
    .from('leads')
    .select('*, lead_contacts(*), lead_notes(*), agent_updates(*), lead_feedback(*)')
    .eq('id', id)
    .single()

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 404 })
  }

  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' }
  })
}

export async function PUT({ params, request }) {
  const { id } = params
  const body = await request.json()

  // Handle special _addNote action
  if (body._addNote) {
    const { author, text } = body._addNote
    const { error } = await supabase.from('lead_notes').insert({
      lead_id: id,
      author: author || 'Tom Keilty',
      text
    })

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 400 })
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' }
    })
  }

  // Handle special _addContact action. entity_type defaults to 'person'
  // server-side when the client didn't send it (older clients).
  if (body._addContact) {
    const { lead_id, name, role, company, phone, email, notes, entity_type } = body._addContact
    const row = {
      lead_id: lead_id || id,
      name,
      role,
      company,
      phone,
      email,
      notes,
      entity_type: entity_type || 'person'
    }
    let { error } = await supabase.from('lead_contacts').insert(row)

    // Graceful fallback if entity_type column isn't yet in the database
    // (migration pending) — retry without the column.
    if (error && /entity_type/i.test(error.message || '')) {
      delete row.entity_type
      ;({ error } = await supabase.from('lead_contacts').insert(row))
    }

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 400 })
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' }
    })
  }

  // Update an existing contact/organization row by id.
  if (body._updateContact) {
    const { id: contactId, name, role, company, phone, email, notes, entity_type } = body._updateContact
    if (!contactId) {
      return new Response(JSON.stringify({ error: 'contact id required' }), { status: 400 })
    }
    const patch = { name, role, company, phone, email, notes, entity_type }
    let { error } = await supabase.from('lead_contacts').update(patch).eq('id', contactId).eq('lead_id', id)

    if (error && /entity_type/i.test(error.message || '')) {
      delete patch.entity_type
      ;({ error } = await supabase.from('lead_contacts').update(patch).eq('id', contactId).eq('lead_id', id))
    }

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 400 })
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' }
    })
  }

  // Delete a contact/organization row. Scoped to this lead so a stray
  // id from elsewhere can't delete something off another lead.
  if (body._deleteContact) {
    const { id: contactId } = body._deleteContact
    if (!contactId) {
      return new Response(JSON.stringify({ error: 'contact id required' }), { status: 400 })
    }
    const { error } = await supabase.from('lead_contacts').delete().eq('id', contactId).eq('lead_id', id)

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 400 })
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' }
    })
  }

  // Handle special _addFeedback action — Tom's calibration on a lead.
  // Written by the feedback modal on negative/positive status transitions
  // and by the standalone "+ Add Feedback" button. Rows with generalize=true
  // are pulled into the Opus system prompt on the next agent run.
  if (body._addFeedback) {
    const { sentiment, category, reasoning, generalize, status_at_feedback } = body._addFeedback
    if (!sentiment || !category) {
      return new Response(JSON.stringify({ error: 'sentiment and category required' }), { status: 400 })
    }
    const { error } = await supabase.from('lead_feedback').insert({
      lead_id: id,
      author: 'Tom Keilty',
      sentiment,
      category,
      reasoning: reasoning || null,
      generalize: generalize !== false,
      status_at_feedback: status_at_feedback || null
    })

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 400 })
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' }
    })
  }

  // Rule: dismissed leads have their score zeroed and priority dropped so
  // they disappear from dashboards and sorted views. Applies whether the
  // status change came from the lead page, the CRM table, or anywhere else.
  if (body.status === 'dismissed') {
    body.actionability_score = 0
    body.priority = 'low'
  }

  // Clamp any explicit score edit to 0–10 and keep priority in sync.
  if (body.actionability_score !== undefined && body.actionability_score !== null) {
    const n = Number(body.actionability_score)
    body.actionability_score = Number.isFinite(n) ? Math.max(0, Math.min(10, Math.round(n))) : 0
    if (body.priority === undefined) {
      body.priority = body.actionability_score >= 8 ? 'high' : body.actionability_score >= 5 ? 'medium' : 'low'
    }
  }

  // Regular lead update
  const { data, error } = await supabase
    .from('leads')
    .update(body)
    .eq('id', id)
    .select()
    .single()

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 400 })
  }

  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' }
  })
}

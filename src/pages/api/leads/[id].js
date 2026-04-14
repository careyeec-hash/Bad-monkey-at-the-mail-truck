import { supabase } from '../../../lib/supabase.js'

export async function GET({ params }) {
  const { id } = params

  const { data, error } = await supabase
    .from('leads')
    .select('*, lead_contacts(*), lead_notes(*), agent_updates(*)')
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

  // Handle special _addContact action
  if (body._addContact) {
    const { lead_id, name, role, company, phone, email, notes } = body._addContact
    const { error } = await supabase.from('lead_contacts').insert({
      lead_id: lead_id || id,
      name,
      role,
      company,
      phone,
      email,
      notes
    })

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 400 })
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' }
    })
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

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

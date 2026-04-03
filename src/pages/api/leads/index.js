import { supabase } from '../../../lib/supabase.js'

export async function GET({ request }) {
  const url = new URL(request.url)
  const status = url.searchParams.get('status')
  const limit = parseInt(url.searchParams.get('limit') || '50')
  const offset = parseInt(url.searchParams.get('offset') || '0')

  let query = supabase
    .from('leads')
    .select('*')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (status) {
    query = query.eq('status', status)
  }

  const { data, error } = await query

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 })
  }

  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' }
  })
}

export async function POST({ request }) {
  const body = await request.json()

  const { data, error } = await supabase
    .from('leads')
    .insert(body)
    .select()
    .single()

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 400 })
  }

  return new Response(JSON.stringify(data), {
    status: 201,
    headers: { 'Content-Type': 'application/json' }
  })
}

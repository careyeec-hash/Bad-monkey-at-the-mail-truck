// POST /api/evaluate — on-demand evaluation for manually entered leads
// Uses Claude Opus to score a lead through the active profile

export async function POST({ request }) {
  // TODO: Implement on-demand evaluation
  // 1. Accept lead data from request body
  // 2. Load active profile
  // 3. Send to Claude Opus for scoring
  // 4. Return scored lead data

  return new Response(JSON.stringify({ error: 'Not yet implemented' }), {
    status: 501,
    headers: { 'Content-Type': 'application/json' }
  })
}

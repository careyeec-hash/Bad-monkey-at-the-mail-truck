// Publisher module — pushes daily briefing Markdown to GitHub repo
// GitHub is ONLY used for briefing content (Astro content collections)
// All data lives in Supabase

export default async function publish(briefingMarkdown, date) {
  console.log('\n--- PUBLISH PHASE ---')

  const token = process.env.GITHUB_PAT
  const repo = process.env.GITHUB_REPO

  if (!token || !repo) {
    console.log('  Skipping publish — GITHUB_PAT or GITHUB_REPO not set')
    return false
  }

  const path = `src/content/briefs/${date}.md`
  const content = Buffer.from(briefingMarkdown).toString('base64')

  // Check if file already exists (to get SHA for update)
  let sha = null
  try {
    const existing = await fetch(
      `https://api.github.com/repos/${repo}/contents/${path}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github.v3+json'
        },
        signal: AbortSignal.timeout(10000)
      }
    )
    if (existing.ok) {
      const data = await existing.json()
      sha = data.sha
    }
  } catch {
    // File doesn't exist yet — that's fine
  }

  // Create or update the file
  const body = {
    message: `Daily briefing ${date}`,
    content,
    branch: 'main'
  }
  if (sha) body.sha = sha

  const res = await fetch(
    `https://api.github.com/repos/${repo}/contents/${path}`,
    {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000)
    }
  )

  if (!res.ok) {
    const err = await res.text()
    console.log(`  Publish failed: ${res.status} — ${err}`)
    return false
  }

  console.log(`  Published ${path} to ${repo}`)
  return true
}

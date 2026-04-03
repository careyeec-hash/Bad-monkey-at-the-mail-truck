// Generator module — produces daily Markdown briefing + weekly digest email HTML
// Daily briefing: published to site every run
// Weekly digest email: generated on Friday only
// Urgent alert: for 9+ items with deadlines (any day)

import { getKPISummary } from './kpi.js'

export async function generateBriefing(evaluated, stats) {
  const today = new Date().toISOString().split('T')[0]

  const hotItems = evaluated.filter(i => i.actionability_score >= 8)
  const watchItems = evaluated.filter(i => i.actionability_score >= 5 && i.actionability_score < 8)
  const signalItems = evaluated.filter(i => i.actionability_score >= 3 && i.actionability_score < 5)
  const leadUpdates = evaluated.filter(i => i.existing_lead_match)

  // --- YAML frontmatter ---
  let md = `---
date: "${today}"
hotLeads: ${hotItems.length}
watchList: ${watchItems.length}
totalItems: ${evaluated.length}
sourcesChecked: ${stats.sourcesChecked || 0}
sourcesFailed: ${stats.sourcesFailed || 0}
---

# Daily Briefing — ${today}

`

  // --- Hot items ---
  if (hotItems.length > 0) {
    md += `## Rip It Open (${hotItems.length})\n\n`
    for (const item of hotItems) {
      md += formatItem(item)
    }
  } else {
    md += `## Rip It Open\n\nNothing today. The Monkey checked every mailbox — quiet morning.\n\n`
  }

  // --- Watch items ---
  if (watchItems.length > 0) {
    md += `## Worth a Sniff (${watchItems.length})\n\n`
    for (const item of watchItems) {
      md += formatItem(item)
    }
  }

  // --- Lead updates ---
  if (leadUpdates.length > 0) {
    md += `## Updates on Tracked Leads\n\n`
    for (const item of leadUpdates) {
      md += `- **${item.one_line || 'Update'}** — matches lead \`${item.existing_lead_match}\`\n`
    }
    md += '\n'
  }

  // --- Signals ---
  if (signalItems.length > 0) {
    md += `## Neighborhood Chatter (${signalItems.length})\n\n`
    for (const item of signalItems.slice(0, 10)) {
      md += `- **${item.one_line || 'Signal'}** (${item.actionability_score}/10) — ${item.category || 'market'}\n`
    }
    md += '\n'
  }

  // --- Route summary ---
  md += `## Daily Route Summary\n\n`
  md += `- Sources checked: ${stats.sourcesChecked || 0}\n`
  md += `- Sources failed: ${stats.sourcesFailed || 0}\n`
  md += `- Items ingested: ${stats.itemsIngested || 0}\n`
  md += `- Items after pre-filter: ${stats.itemsFiltered || 0}\n`
  md += `- Items evaluated: ${evaluated.length}\n`

  if (stats.failures?.length > 0) {
    md += `\n**Source warnings:**\n`
    for (const f of stats.failures) {
      md += `- ${f.source}: ${f.error}\n`
    }
  }

  return { markdown: md, date: today, hotItems, watchItems, signalItems, leadUpdates }
}

function formatItem(item) {
  let block = `### ${item.one_line || 'Untitled'} — ${item.actionability_score}/10\n\n`

  if (item.why_it_matters) {
    block += `${item.why_it_matters}\n\n`
  }

  const tags = []
  if (item.bristlecone_fit) tags.push(item.bristlecone_fit)
  if (item.fit_type) tags.push(item.fit_type)
  if (item.project_type) tags.push(item.project_type)
  if (item.estimated_value) tags.push(item.estimated_value)
  if (tags.length > 0) {
    block += `**${tags.join(' | ')}**\n\n`
  }

  if (item.action_item) {
    block += `> **Action:** ${item.action_item}\n\n`
  }

  if (item.url || item.originalItem?.url) {
    block += `[Source](${item.url || item.originalItem?.url})\n\n`
  }

  block += `---\n\n`
  return block
}

// --- Weekly digest email HTML (Friday only) ---

export async function generateWeeklyEmail(weekItems, profile) {
  const isFriday = new Date().getDay() === 5
  if (!isFriday) return null

  let kpi = {}
  try {
    kpi = await getKPISummary()
  } catch (err) {
    console.log(`  Warning: Could not load KPIs: ${err.message}`)
  }

  const hot = weekItems.filter(i => i.actionability_score >= 8)
  const watch = weekItems.filter(i => i.actionability_score >= 5 && i.actionability_score < 8)
  const updates = weekItems.filter(i => i.existing_lead_match)

  const siteUrl = process.env.SITE_URL || 'https://bad-monkey-mailtruck.vercel.app'

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0; padding:0; background:#f3f4f6; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<div style="max-width:600px; margin:0 auto; background:#ffffff;">

  <!-- Header -->
  <div style="background:#1E2761; padding:24px; text-align:center;">
    <h1 style="color:#ffffff; margin:0; font-size:24px;">Bad Monkey Weekly Digest</h1>
    <p style="color:#9CA3AF; margin:8px 0 0;">Week of ${kpi.weekStarting || 'this week'} — ${profile.profileName}</p>
  </div>

  <!-- Pipeline snapshot -->
  <div style="padding:20px; background:#f8fafc; border-bottom:1px solid #e5e7eb;">
    <h2 style="margin:0 0 12px; font-size:16px; color:#374151;">Pipeline Report</h2>
    <table style="width:100%; text-align:center;">
      <tr>
        <td style="padding:8px;">
          <div style="font-size:28px; font-weight:bold; color:#1E2761;">${kpi.pipelineCount || 0}</div>
          <div style="font-size:12px; color:#6B7280;">Active Leads</div>
        </td>
        <td style="padding:8px;">
          <div style="font-size:28px; font-weight:bold; color:#EF4444;">${hot.length}</div>
          <div style="font-size:12px; color:#6B7280;">Hot This Week</div>
        </td>
        <td style="padding:8px;">
          <div style="font-size:28px; font-weight:bold; color:#10B981;">${kpi.createdThisWeek || 0}</div>
          <div style="font-size:12px; color:#6B7280;">New Leads</div>
        </td>
        <td style="padding:8px;">
          <div style="font-size:28px; font-weight:bold; color:#4A6FA5;">${kpi.winRate || 0}%</div>
          <div style="font-size:12px; color:#6B7280;">Win Rate</div>
        </td>
      </tr>
    </table>
  </div>

  <!-- Hot items -->
  ${hot.length > 0 ? `
  <div style="padding:20px;">
    <h2 style="color:#EF4444; font-size:18px; margin:0 0 16px;">Rip It Open (${hot.length})</h2>
    ${hot.map(item => emailItemCard(item, '#FEE2E2')).join('')}
  </div>` : ''}

  <!-- Watch items -->
  ${watch.length > 0 ? `
  <div style="padding:20px;">
    <h2 style="color:#F59E0B; font-size:18px; margin:0 0 16px;">Worth a Sniff (${watch.length})</h2>
    ${watch.map(item => emailItemCard(item, '#FEF3C7')).join('')}
  </div>` : ''}

  <!-- Lead updates -->
  ${updates.length > 0 ? `
  <div style="padding:20px;">
    <h2 style="color:#4A6FA5; font-size:18px; margin:0 0 16px;">Tracked Lead Updates</h2>
    ${updates.map(item => `<p style="margin:4px 0; font-size:14px;">• ${item.one_line || 'Update'}</p>`).join('')}
  </div>` : ''}

  <!-- Footer -->
  <div style="padding:20px; background:#f8fafc; text-align:center; border-top:1px solid #e5e7eb;">
    <a href="${siteUrl}" style="color:#1E2761; text-decoration:underline; font-size:14px;">View daily briefings</a>
    &nbsp;|&nbsp;
    <a href="${siteUrl}/leads/new" style="color:#1E2761; text-decoration:underline; font-size:14px;">Spotted something? Tell the Monkey</a>
    <p style="color:#9CA3AF; font-size:12px; margin-top:12px;">Bad Monkey At The Mail Truck — Construction Intelligence for ${profile.profileName}</p>
  </div>

</div>
</body>
</html>`

  return {
    html,
    subject: `Bad Monkey Weekly — ${hot.length} hot leads, ${kpi.pipelineCount || 0} in pipeline`,
    recipients: profile.emailRecipients || []
  }
}

function emailItemCard(item, bgColor) {
  return `<div style="background:${bgColor}; border-radius:8px; padding:16px; margin-bottom:12px;">
    <div style="display:flex; justify-content:space-between; align-items:center;">
      <strong style="font-size:15px; color:#111827;">${item.one_line || 'Untitled'}</strong>
      <span style="background:#1E2761; color:white; padding:2px 8px; border-radius:12px; font-size:13px; font-weight:bold;">${item.actionability_score}/10</span>
    </div>
    ${item.why_it_matters ? `<p style="font-size:13px; color:#374151; margin:8px 0 4px;">${item.why_it_matters}</p>` : ''}
    ${item.action_item ? `<p style="font-size:13px; color:#1E2761; font-weight:600; margin:4px 0;"> Action: ${item.action_item}</p>` : ''}
    ${item.url ? `<a href="${item.url}" style="font-size:12px; color:#4A6FA5;">View source</a>` : ''}
  </div>`
}

// --- Urgent alert email (9+ with deadline, any day) ---

export function generateUrgentAlert(evaluatedItems, profile) {
  const urgent = evaluatedItems.filter(i =>
    i.actionability_score >= 9 &&
    (i.project_stage === 'bidding' || i.enrichment_needed?.includes('bid deadline'))
  )

  if (urgent.length === 0) return null

  const topItem = urgent[0]
  const siteUrl = process.env.SITE_URL || 'https://bad-monkey-mailtruck.vercel.app'

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0; padding:0; background:#f3f4f6; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<div style="max-width:600px; margin:0 auto; background:#ffffff;">
  <div style="background:#EF4444; padding:20px; text-align:center;">
    <h1 style="color:#ffffff; margin:0; font-size:20px;">Bad Monkey Alert</h1>
  </div>
  <div style="padding:24px;">
    ${urgent.map(item => emailItemCard(item, '#FEE2E2')).join('')}
  </div>
  <div style="padding:16px; text-align:center; background:#f8fafc;">
    <a href="${siteUrl}/leads" style="color:#1E2761; font-size:14px;">View in pipeline</a>
  </div>
</div>
</body>
</html>`

  return {
    html,
    subject: `Bad Monkey Alert — ${topItem.one_line || 'Urgent Lead'} — Action needed`,
    recipients: profile.emailRecipients || []
  }
}

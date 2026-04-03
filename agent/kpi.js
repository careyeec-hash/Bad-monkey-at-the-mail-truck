// KPI module — weekly pipeline summary queries from Supabase
// Used in Friday digest email and future dashboard

import { supabase } from './db.js'

export async function getKPISummary() {
  // Get Monday of current week
  const now = new Date()
  const monday = new Date(now)
  monday.setDate(monday.getDate() - monday.getDay() + 1)
  monday.setHours(0, 0, 0, 0)

  // Count by status
  const { data: allLeads } = await supabase
    .from('leads')
    .select('status, estimated_value')

  const statusCounts = {}
  let pipelineCount = 0
  for (const lead of (allLeads || [])) {
    statusCounts[lead.status] = (statusCounts[lead.status] || 0) + 1
    if (['new', 'tracking', 'pursuing'].includes(lead.status)) {
      pipelineCount++
    }
  }

  // Leads created this week
  const { count: createdThisWeek } = await supabase
    .from('leads')
    .select('*', { count: 'exact', head: true })
    .gte('created_at', monday.toISOString())

  // Source effectiveness
  const { data: sourceData } = await supabase
    .from('leads')
    .select('source_category')
    .gte('created_at', monday.toISOString())

  const sourceCounts = {}
  for (const lead of (sourceData || [])) {
    const cat = lead.source_category || 'unknown'
    sourceCounts[cat] = (sourceCounts[cat] || 0) + 1
  }

  // Win/loss counts
  const won = statusCounts['won'] || 0
  const lost = statusCounts['lost'] || 0
  const total = won + lost
  const winRate = total > 0 ? Math.round((won / total) * 100) : 0

  return {
    statusCounts,
    pipelineCount,
    createdThisWeek: createdThisWeek || 0,
    sourceCounts,
    winRate,
    weekStarting: monday.toISOString().split('T')[0]
  }
}

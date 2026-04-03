// Email module — sends via Resend
// Weekly digest (Friday) + urgent alerts (any day for 9+ with deadline)

import { Resend } from 'resend'

let resend = null

function getClient() {
  if (!resend) {
    const key = process.env.RESEND_API_KEY
    if (!key) return null
    resend = new Resend(key)
  }
  return resend
}

export async function sendDigestEmail(emailData) {
  console.log('\n--- EMAIL PHASE ---')

  if (!emailData) {
    console.log('  No digest email to send (not Friday or no data)')
    return 'none'
  }

  const client = getClient()
  if (!client) {
    console.log('  Skipping email — RESEND_API_KEY not set')
    return 'none'
  }

  const { html, subject, recipients } = emailData

  if (!recipients || recipients.length === 0) {
    console.log('  No recipients configured')
    return 'none'
  }

  try {
    const { data, error } = await client.emails.send({
      from: 'Bad Monkey <monkey@badmonkeymailtruck.com>',
      to: recipients.map(r => r.email),
      subject,
      html
    })

    if (error) {
      console.log(`  Email send failed: ${error.message}`)
      return 'none'
    }

    console.log(`  Weekly digest sent to ${recipients.length} recipient(s): ${data.id}`)
    return 'weekly'
  } catch (err) {
    console.log(`  Email send failed: ${err.message}`)
    return 'none'
  }
}

export async function sendUrgentAlert(alertData) {
  if (!alertData) return 'none'

  const client = getClient()
  if (!client) {
    console.log('  Skipping urgent alert — RESEND_API_KEY not set')
    return 'none'
  }

  const { html, subject, recipients } = alertData

  try {
    const { data, error } = await client.emails.send({
      from: 'Bad Monkey <monkey@badmonkeymailtruck.com>',
      to: recipients.map(r => r.email),
      subject,
      html
    })

    if (error) {
      console.log(`  Urgent alert failed: ${error.message}`)
      return 'none'
    }

    console.log(`  Urgent alert sent: ${data.id}`)
    return 'urgent'
  } catch (err) {
    console.log(`  Urgent alert failed: ${err.message}`)
    return 'none'
  }
}

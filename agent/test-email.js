// Resend smoke test — sends ONE email immediately to verify:
//   1. RESEND_API_KEY is valid
//   2. The from-address is accepted (verified domain or onboarding@resend.dev)
//   3. The recipient receives mail from us (not blocked by spam filter)
//
// Usage:
//   node test-email.js                    # sends to first profile recipient
//   node test-email.js you@example.com    # sends to a specific address (overrides profile)
//
// EMAIL_FROM env var overrides the from-address. Defaults to onboarding@resend.dev
// (Resend's no-verification sandbox sender) so this works before any domain setup.

import './load-env.js'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { Resend } from 'resend'

const __dirname = dirname(fileURLToPath(import.meta.url))

const key = process.env.RESEND_API_KEY
if (!key || key.length < 20) {
  console.error('FAIL: RESEND_API_KEY is missing or looks like a placeholder.')
  console.error('Get a real key at https://resend.com/api-keys and put it in agent/.env')
  process.exit(1)
}

const profileName = process.env.PROFILE || 'bristlecone'
const profile = JSON.parse(readFileSync(join(__dirname, 'profiles', `${profileName}.json`), 'utf-8'))

const cliRecipient = process.argv[2]
const recipient = cliRecipient || profile.emailRecipients?.[0]?.email
if (!recipient) {
  console.error('FAIL: No recipient. Pass one as an argument or add to profile.emailRecipients.')
  process.exit(1)
}

const from = process.env.EMAIL_FROM || 'Bad Monkey <onboarding@resend.dev>'

console.log(`Sending test email...`)
console.log(`  From: ${from}`)
console.log(`  To:   ${recipient}`)

const html = `<!DOCTYPE html>
<html>
<body style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #f3f4f6; padding: 24px;">
  <div style="max-width: 560px; margin: 0 auto; background: white; border-radius: 12px; padding: 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
    <h1 style="color: #1E2761; margin: 0 0 16px;">Bad Monkey Email Smoke Test</h1>
    <p style="color: #374151; line-height: 1.6;">If you're reading this, the Resend integration works end-to-end:</p>
    <ul style="color: #374151; line-height: 1.8;">
      <li>API key is valid</li>
      <li>From-address (<code>${from}</code>) is accepted by Resend</li>
      <li>Your inbox accepted the message (not flagged as spam)</li>
    </ul>
    <p style="color: #6B7280; font-size: 13px; margin-top: 24px;">
      Sent at ${new Date().toISOString()} from the agent test harness.<br>
      Profile: <strong>${profile.profileName}</strong>
    </p>
  </div>
</body>
</html>`

try {
  const resend = new Resend(key)
  const { data, error } = await resend.emails.send({
    from,
    to: recipient,
    subject: `Bad Monkey email smoke test — ${new Date().toLocaleString()}`,
    html
  })

  if (error) {
    console.error(`FAIL: Resend returned an error.`)
    console.error(error)
    process.exit(1)
  }

  console.log(`SUCCESS: Email queued. Message ID: ${data.id}`)
  console.log(`Check ${recipient} (and the spam folder, just in case).`)
} catch (err) {
  console.error(`FAIL: ${err.message}`)
  process.exit(1)
}

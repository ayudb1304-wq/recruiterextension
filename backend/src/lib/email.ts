/**
 * Transactional email for magic links (docs/05 §1).
 *
 * ⚠️ DECISION PENDING (docs/07 Phase 5, human task): pick the free-tier provider
 * (Resend / Brevo class), create the account, set EMAIL_API_KEY, and record the
 * choice in docs/05 §1. Until then the Resend-shaped adapter below is the
 * default and a missing key logs the link instead of sending, so local dev works
 * without an account.
 *
 * The enrichment budget must not be spent on email.
 */

import type { Env } from '../env';

export async function sendMagicLinkEmail(env: Env, to: string, link: string): Promise<void> {
  if (!env.EMAIL_API_KEY) {
    // Dev fallback. Never reached in production because the secret is set.
    console.log(`[dev] magic link for ${to}: ${link}`);
    return;
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.EMAIL_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to,
      subject: 'Your Recruiter Export sign-in link',
      text: [
        'Click to sign in to Recruiter Export:',
        '',
        link,
        '',
        'The link works once and expires in 15 minutes.',
        'If you did not ask for this, ignore this email — nothing happens.',
      ].join('\n'),
    }),
  });

  if (!res.ok) {
    // Log the failure, not the link or the address.
    console.error('magic link send failed', res.status);
    throw new Error('email_send_failed');
  }
}

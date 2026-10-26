// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import nodemailer from 'nodemailer';
import { getConfigValue } from '@/lib/config';
import { isPlainEmail } from '@/lib/email/address';

export async function isSmtpConfigured(): Promise<boolean> {
  return !!(
    (await getConfigValue('smtpHost')) &&
    (await getConfigValue('smtpUser')) &&
    (await getConfigValue('smtpPassword')) &&
    (await getConfigValue('smtpFromAddress'))
  );
}

export async function createTransport() {
  const port = parseInt((await getConfigValue('smtpPort')) || '587', 10);
  return nodemailer.createTransport({
    host: await getConfigValue('smtpHost'),
    port,
    secure: port === 465,
    auth: {
      user: await getConfigValue('smtpUser'),
      pass: await getConfigValue('smtpPassword'),
    },
  });
}

export async function sendPasswordResetEmail(
  toEmail: string,
  resetUrl: string
): Promise<void> {
  const fromName = (await getConfigValue('smtpFromName')) || 'Frontier Command Centre';
  const fromAddress = await getConfigValue('smtpFromAddress');

  const transport = await createTransport();

  // One recipient, passed as an address object so the mail library never
  // splits a stored string into a list (security re-review R1).
  if (!isPlainEmail(toEmail)) throw new Error('Password reset email refused: not a single plain address');
  await transport.sendMail({
    from: `"${fromName}" <${fromAddress}>`,
    to: { name: '', address: toEmail.trim() },
    subject: 'Reset your Frontier Command Centre password',
    text: [
      'You requested a password reset for your Frontier Command Centre account.',
      '',
      'Click the link below to set a new password. This link expires in 1 hour.',
      '',
      resetUrl,
      '',
      'If you did not request this, you can safely ignore this email.',
    ].join('\n'),
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px">
        <h2 style="margin-top:0;color:#111">Password reset</h2>
        <p style="color:#444">You requested a password reset for your Frontier Command Centre account.</p>
        <p style="color:#444">Click the button below to set a new password. This link expires in <strong>1 hour</strong>.</p>
        <p style="margin:28px 0">
          <a href="${resetUrl}"
             style="background:#6366f1;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:600">
            Reset password
          </a>
        </p>
        <p style="color:#888;font-size:13px">If you did not request this, you can safely ignore this email.</p>
        <hr style="border:none;border-top:1px solid #eee;margin-top:32px" />
        <p style="color:#bbb;font-size:12px">Frontier Command Centre</p>
      </div>
    `,
  });
}

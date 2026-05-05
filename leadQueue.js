import { logger } from '../lib/logger.js';

// ---------------------------------------------------------------------------
// Job queue — in production, replace this with BullMQ + Redis for durability.
// Using Promise.allSettled so one failing job never blocks the others.
// ---------------------------------------------------------------------------
export async function queueLeadJobs(lead) {
  const results = await Promise.allSettled([
    sendConfirmationEmail(lead),
    notifyTeam(lead),
    pushToCrm(lead),
  ]);

  results.forEach((result, i) => {
    const jobName = ['confirmationEmail', 'teamNotification', 'crmPush'][i];
    if (result.status === 'rejected') {
      // Log the failure but don't throw — the lead is already saved
      logger.error({ err: result.reason, leadId: lead.id, job: jobName }, 'Job failed');
    } else {
      logger.info({ leadId: lead.id, job: jobName }, 'Job completed');
    }
  });
}

// ---------------------------------------------------------------------------
// Send confirmation email to the person who submitted the form
// Uses Resend (https://resend.com) — swap for SendGrid if preferred
// ---------------------------------------------------------------------------
async function sendConfirmationEmail(lead) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + process.env.RESEND_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Progressive Digital <hello@progressivedigital.com>',
      to: lead.email,
      subject: "We received your message — Progressive Digital",
      html: confirmationTemplate(lead),
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error('Resend error: ' + res.status + ' ' + body);
  }
}

// ---------------------------------------------------------------------------
// Notify the team via email when a new lead arrives
// ---------------------------------------------------------------------------
async function notifyTeam(lead) {
  const TEAM_EMAIL = process.env.TEAM_NOTIFICATION_EMAIL || 'team@progressivedigital.com';

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + process.env.RESEND_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Progressive Digital Leads <noreply@progressivedigital.com>',
      to: TEAM_EMAIL,
      subject: `New lead: ${lead.name} — ${lead.service || 'General inquiry'}`,
      html: teamNotificationTemplate(lead),
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error('Team notification error: ' + res.status + ' ' + body);
  }
}

// ---------------------------------------------------------------------------
// Push to CRM — HubSpot example
// Replace with your actual CRM's API when you're ready to integrate
// ---------------------------------------------------------------------------
async function pushToCrm(lead) {
  if (!process.env.HUBSPOT_API_KEY) {
    logger.warn('HUBSPOT_API_KEY not set — skipping CRM push');
    return;
  }

  const res = await fetch('https://api.hubapi.com/crm/v3/objects/contacts', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + process.env.HUBSPOT_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      properties: {
        firstname: lead.name.split(' ')[0],
        lastname: lead.name.split(' ').slice(1).join(' '),
        email: lead.email,
        company: lead.organization || '',
        lead_source: 'Website Contact Form',
        hs_lead_status: 'NEW',
        notes_last_contacted: lead.message,
      },
    }),
  });

  // 409 Conflict = contact already exists in HubSpot; not an error
  if (!res.ok && res.status !== 409) {
    const body = await res.text();
    throw new Error('HubSpot error: ' + res.status + ' ' + body);
  }
}

// ---------------------------------------------------------------------------
// Email templates
// ---------------------------------------------------------------------------
function confirmationTemplate(lead) {
  return `
    <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#0a0a0a;">
      <div style="background:#0a0a0a;padding:24px 32px;">
        <p style="font-family:sans-serif;font-size:18px;font-weight:800;color:#f5f4f0;margin:0;">
          Progressive<span style="color:#e84d2b;">.</span>Digital
        </p>
      </div>
      <div style="padding:32px;">
        <h1 style="font-size:22px;margin:0 0 16px;">Thanks, ${lead.name.split(' ')[0]}.</h1>
        <p style="color:#555;line-height:1.6;">We received your message and will be in touch within <strong>1 business day</strong>.</p>
        ${lead.service ? `<p style="color:#555;line-height:1.6;">You're interested in: <strong>${lead.service}</strong></p>` : ''}
        <p style="color:#555;line-height:1.6;margin-top:24px;">In the meantime, feel free to connect with us on <a href="https://linkedin.com/company/progressive-digital" style="color:#e84d2b;">LinkedIn</a>.</p>
        <p style="color:#555;line-height:1.6;margin-top:32px;">— The Progressive Digital Team</p>
      </div>
      <div style="border-top:1px solid #eee;padding:16px 32px;">
        <p style="font-size:12px;color:#999;margin:0;">San Francisco Bay Area, California · <a href="https://progressivedigital.com/privacy" style="color:#999;">Privacy Policy</a></p>
      </div>
    </div>
  `;
}

function teamNotificationTemplate(lead) {
  return `
    <div style="font-family:monospace;max-width:560px;margin:0 auto;background:#f9f9f9;padding:24px;border-radius:4px;">
      <h2 style="margin:0 0 16px;font-size:16px;">New lead received</h2>
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <tr><td style="padding:6px 0;color:#666;width:120px;">Name</td><td>${lead.name}</td></tr>
        <tr><td style="padding:6px 0;color:#666;">Email</td><td>${lead.email}</td></tr>
        <tr><td style="padding:6px 0;color:#666;">Organization</td><td>${lead.organization || '—'}</td></tr>
        <tr><td style="padding:6px 0;color:#666;">Service</td><td>${lead.service || '—'}</td></tr>
        <tr><td style="padding:6px 0;color:#666;">Message</td><td>${lead.message}</td></tr>
        <tr><td style="padding:6px 0;color:#666;">Lead ID</td><td style="font-family:monospace;">${lead.id}</td></tr>
        <tr><td style="padding:6px 0;color:#666;">Submitted</td><td>${new Date(lead.created_at).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })}</td></tr>
      </table>
    </div>
  `;
}

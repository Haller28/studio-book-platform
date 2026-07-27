const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');
const { json } = require('./_lib');

// Automated site provisioning: turns a paid (or approved-free) signup into a
// live, fully independent Studio Book site cloned from salon-platform-template.
//
// Requires a Netlify Personal Access Token with permission to create sites
// under the Studio Book Netlify account/team. That token does not exist yet —
// it belongs to the new Studio Book business entity being set up tomorrow —
// so every step below is gated on PROVISIONING_NETLIFY_TOKEN being present.
// Until then, calls return { ok:false, reason:'not_configured' } and the
// signup is simply left in the signup-requests store for manual follow-up.
//
// Required env vars once real Studio Book infra exists:
//   PROVISIONING_NETLIFY_TOKEN   - Netlify PAT owned by Studio Book (not Dylan's personal one)
//   PROVISIONING_ACCOUNT_SLUG    - Netlify team/account slug new sites are created under
//   TEMPLATE_REPO                - e.g. "Haller28/salon-platform-template"
//   PROVISION_ADMIN_SECRET       - shared secret required in x-admin-secret header
//                                  when this is called directly (e.g. from an
//                                  internal admin tool), to prevent abuse.
//   GMAIL_USER / GMAIL_APP_PASSWORD - for the welcome email (reused pattern
//                                  from the per-salon template's own functions)

const NETLIFY_API = 'https://api.netlify.com/api/v1';

function slugify(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'salon';
}

function generateSecret(bytes = 24) {
  return crypto.randomBytes(bytes).toString('hex');
}

function provisioningConfigured() {
  return Boolean(process.env.PROVISIONING_NETLIFY_TOKEN && process.env.PROVISIONING_ACCOUNT_SLUG && process.env.TEMPLATE_REPO);
}

async function netlifyFetch(path, options = {}) {
  const res = await fetch(`${NETLIFY_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.PROVISIONING_NETLIFY_TOKEN}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`Netlify API ${path} failed: ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// Core provisioning logic. Called either by the Stripe webhook after a
// successful checkout, or directly (admin-secret gated) for free/manual
// signups like Dylan's wife's salon.
async function provisionSite({ salonName, ownerName, email, phone, plan }) {
  if (!provisioningConfigured()) {
    return { ok: false, reason: 'not_configured' };
  }

  const baseSlug = slugify(salonName);
  const siteName = `studiobook-${baseSlug}-${crypto.randomBytes(2).toString('hex')}`;

  // 1. Create the site, cloned from the shared template repo.
  const site = await netlifyFetch(`/${process.env.PROVISIONING_ACCOUNT_SLUG}/sites`, {
    method: 'POST',
    body: JSON.stringify({
      name: siteName,
      repo: {
        provider: 'github',
        repo: process.env.TEMPLATE_REPO,
        private: false,
        branch: 'main'
      }
    })
  });

  const siteId = site.id;
  const siteUrl = site.ssl_url || site.url;

  // 2. Generate fresh per-site secrets — never reuse Studio17's or another
  //    subscriber's JWT_SECRET/BOOTSTRAP_CODE.
  const jwtSecret = generateSecret(32);
  const bootstrapCode = generateSecret(6);

  // 3. Configure required env vars for the new site.
  await netlifyFetch(`/sites/${siteId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      build_settings: {
        env: {
          ADMIN_EMAILS: email,
          BOOTSTRAP_CODE: bootstrapCode,
          JWT_SECRET: jwtSecret,
          NETLIFY_SITE_ID: siteId,
          // Reuses the platform's own provisioning token so the new site's
          // Functions can read/write its own (fully isolated) Blobs store.
          NETLIFY_BLOBS_TOKEN: process.env.PROVISIONING_NETLIFY_TOKEN
        }
      }
    })
  });

  // 4. Trigger the first deploy so env vars take effect.
  await netlifyFetch(`/sites/${siteId}/builds`, { method: 'POST', body: JSON.stringify({}) });

  const record = {
    email: String(email).toLowerCase(),
    salonName, ownerName, phone: phone || '', plan: plan || 'pro',
    siteId, siteUrl, bootstrapCode,
    provisionedAt: Date.now(),
    status: 'active'
  };

  try {
    const store = getStore({
      name: 'subscribers', consistency: 'strong',
      siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN
    });
    await store.setJSON(record.email, record);
  } catch (e) {
    console.error('Failed to record subscriber after provisioning', e);
  }

  // 5. Best-effort welcome email with their bootstrap link.
  try {
    if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
      // eslint-disable-next-line global-require
      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
      });
      await transporter.sendMail({
        from: process.env.GMAIL_USER,
        to: record.email,
        subject: `${salonName} is live on Studio Book`,
        text: `Hi ${ownerName},\n\nYour Studio Book site is ready: ${siteUrl}\n\nUse bootstrap code ${bootstrapCode} the first time you log in to claim your owner account, then start adding your services, team, and photos.\n\n— Studio Book`
      });
    }
  } catch (e) {
    console.error('Welcome email failed', e);
  }

  return { ok: true, site: record };
}

// HTTP entry point — used for manually-triggered provisioning (e.g. an
// internal "approve this signup" action for free/comped accounts like
// Dylan's wife's salon). Real Stripe-driven signups are provisioned from
// stripe-webhook.js, which imports provisionSite() directly instead of
// calling this over HTTP.
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const adminSecret = event.headers['x-admin-secret'] || event.headers['X-Admin-Secret'];
  if (!process.env.PROVISION_ADMIN_SECRET || adminSecret !== process.env.PROVISION_ADMIN_SECRET) {
    return json(403, { error: 'Not authorized.' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Invalid JSON' }); }

  const { salonName, ownerName, email, phone, plan } = body;
  if (!salonName || !ownerName || !email) {
    return json(400, { error: 'salonName, ownerName, and email are required.' });
  }

  try {
    const result = await provisionSite({ salonName, ownerName, email, phone, plan });
    if (!result.ok && result.reason === 'not_configured') {
      return json(200, { ok: false, reason: 'not_configured', message: 'Provisioning is not configured yet — set PROVISIONING_NETLIFY_TOKEN, PROVISIONING_ACCOUNT_SLUG, and TEMPLATE_REPO once the Studio Book Netlify account exists.' });
    }
    return json(200, result);
  } catch (e) {
    console.error('Provisioning failed', e);
    return json(500, { ok: false, error: e.message });
  }
};

module.exports.provisionSite = provisionSite;
module.exports.provisioningConfigured = provisioningConfigured;

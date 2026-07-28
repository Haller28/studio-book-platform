const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');
const { json, getPlan, stripeConfigured, getStripe, SITE_URL } = require('./_lib');

// Appends a signup to the Salon Vine Signups Google Sheet via the Apps Script
// web app bound to that sheet. Never throws — a sheet outage must not stop a
// customer from signing up; the failure is logged for manual recovery instead.
async function logToSheet(record) {
  const url = process.env.SHEET_ENDPOINT_URL;
  const secret = process.env.SHEET_SECRET;
  if (!url || !secret) {
    console.error('Sheet logging skipped: SHEET_ENDPOINT_URL / SHEET_SECRET not set');
    return false;
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        secret,
        salonName: record.salonName,
        ownerName: record.ownerName,
        email: record.email,
        phone: record.phone,
        plan: record.plan,
        oldSiteUrl: record.oldSiteUrl
      })
    });
    const text = await res.text();
    let parsed = {};
    try { parsed = JSON.parse(text); } catch (e) { /* non-JSON response */ }
    if (!parsed.ok) {
      console.error('Sheet logging returned a non-ok response:', text.slice(0, 500));
      return false;
    }
    return true;
  } catch (e) {
    console.error('Sheet logging failed', e);
    return false;
  }
}

// Handles the signup form submission on signup.html.
//
// Two modes, auto-selected based on whether Stripe is configured yet:
//   1. Stripe configured  -> create a real Checkout Session, return its URL.
//      Successful payment fires stripe-webhook.js, which provisions the site.
//   2. Stripe NOT configured (true today) -> record the signup as pending and
//      tell the client we'll follow up. Nothing is charged.
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Invalid JSON' }); }

  const { salonName, ownerName, email, phone, oldSiteUrl, plan, billing } = body;
  if (!salonName || !ownerName || !email) {
    return json(400, { error: 'Salon name, your name, and email are required.' });
  }

  const planInfo = getPlan(plan);
  const signupId = crypto.randomBytes(8).toString('hex');

  const record = {
    id: signupId,
    createdAt: Date.now(),
    status: 'pending',
    plan: planInfo.key,
    billing: billing === 'annual' ? 'annual' : 'monthly',
    salonName, ownerName, email: String(email).toLowerCase(),
    phone: phone || '', oldSiteUrl: oldSiteUrl || ''
  };

  // Primary log: the Salon Vine Signups Google Sheet. Every signup lands there
  // as a new row with the monthly price auto-computed and status "Pending".
  await logToSheet(record);

  // Secondary/backup: Netlify Blobs. Optional — only runs if those env vars
  // happen to be set. Never blocks the signup.
  if (process.env.NETLIFY_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    try {
      const store = getStore({
        name: 'signup-requests', consistency: 'strong',
        siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN
      });
      await store.setJSON(signupId, record);
    } catch (e) {
      console.error('Blobs backup write failed (non-fatal)', e);
    }
  }

  if (stripeConfigured()) {
    const stripe = getStripe();
    const priceId = record.billing === 'annual' ? planInfo.stripePriceIdAnnual : planInfo.stripePriceIdMonthly;

    if (!priceId) {
      return json(200, {
        pending: true,
        message: "Thanks! Your plan isn't quite live for online checkout yet — our team will follow up by email to finish setting up your subscription."
      });
    }

    try {
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        line_items: [{ price: priceId, quantity: 1 }],
        customer_email: record.email,
        subscription_data: { trial_period_days: 30 },
        success_url: `${SITE_URL}/welcome.html?signup=${signupId}&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${SITE_URL}/signup.html?plan=${planInfo.key}`,
        metadata: {
          signupId, plan: planInfo.key, salonName, ownerName,
          phone: phone || '', oldSiteUrl: oldSiteUrl || ''
        }
      });
      return json(200, { checkoutUrl: session.url });
    } catch (e) {
      console.error('Stripe checkout session creation failed', e);
      return json(200, {
        pending: true,
        message: "We couldn't reach billing just now — we've saved your details and will follow up by email shortly."
      });
    }
  }

  // Billing not set up yet — normal/expected state for now.
  return json(200, {
    pending: true,
    message: `Thanks, ${ownerName}! We've got ${salonName}'s details. Salon Vine billing is being finalized — we'll personally reach out at ${record.email} to get your site set up.`
  });
};

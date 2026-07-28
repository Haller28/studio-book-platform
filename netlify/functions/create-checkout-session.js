const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');
const { json, getPlan, stripeConfigured, getStripe, SITE_URL } = require('./_lib');

// Handles the signup form submission on signup.html.
//
// Two modes, auto-selected based on whether Stripe is configured yet:
//   1. Stripe configured  -> create a real Checkout Session, return its URL.
//      Successful payment fires stripe-webhook.js, which provisions the site.
//   2. Stripe NOT configured (true today, until the Salon Vine business +
//      Stripe account exist) -> save the signup request to Blobs so it's not
//      lost, and tell the client it's pending. This is exactly the flow Dylan
//      wants for his wife's salon: her request gets captured, nothing is
//      charged, and the site can be provisioned manually/free in the interim.
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

  try {
    const store = getStore({
      name: 'signup-requests', consistency: 'strong',
      siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN
    });
    await store.setJSON(signupId, record);
  } catch (e) {
    // Don't block the signup flow on storage issues — Stripe (if configured)
    // is still the source of truth, and we log for manual recovery.
    console.error('Failed to persist signup request', e);
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

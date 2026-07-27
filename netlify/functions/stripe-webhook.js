const { getStore } = require('@netlify/blobs');
const { stripeConfigured, getStripe } = require('./_lib');
const { provisionSite } = require('./provision-site');

// Stripe webhook endpoint. Point this at:
//   https://<studio-book-domain>/.netlify/functions/stripe-webhook
// Listen for: checkout.session.completed, customer.subscription.deleted,
// customer.subscription.updated.
//
// Inert until STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are set (they
// don't exist yet — pending the real Studio Book Stripe account). Netlify
// Functions receive a parsed event.body string, which is what Stripe's
// signature verification needs raw, so we use event.body directly (Netlify
// does not re-serialize it) rather than JSON.parse-ing before verification.
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  if (!stripeConfigured() || !process.env.STRIPE_WEBHOOK_SECRET) {
    // Billing isn't live yet — nothing should be hitting this endpoint in
    // practice, but respond gracefully rather than error if it is.
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'not_configured' }) };
  }

  const stripe = getStripe();
  const sig = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(event.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe signature verification failed', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  try {
    if (stripeEvent.type === 'checkout.session.completed') {
      const session = stripeEvent.data.object;
      const meta = session.metadata || {};

      await provisionSite({
        salonName: meta.salonName,
        ownerName: meta.ownerName,
        email: session.customer_email || session.customer_details?.email,
        phone: meta.phone,
        plan: meta.plan
      });

      // Mark the original signup request resolved, if we still have it.
      if (meta.signupId) {
        try {
          const store = getStore({
            name: 'signup-requests', consistency: 'strong',
            siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN
          });
          const existing = await store.get(meta.signupId, { type: 'json' });
          if (existing) {
            existing.status = 'provisioned';
            existing.stripeCustomerId = session.customer;
            await store.setJSON(meta.signupId, existing);
          }
        } catch (e) { console.error('Failed to update signup record', e); }
      }
    }

    if (stripeEvent.type === 'customer.subscription.deleted') {
      // TODO once billing is live: look up the subscriber by Stripe customer
      // ID and mark their record inactive / trigger a grace-period flow
      // rather than immediately tearing down their site.
      console.log('Subscription canceled:', stripeEvent.data.object.customer);
    }

    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  } catch (err) {
    console.error('Error handling Stripe webhook', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

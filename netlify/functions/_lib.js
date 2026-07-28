// Shared helpers for Studio Book platform functions.

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}

// Plan catalog — single source of truth for pricing shown on the site,
// used in Checkout Sessions, and referenced by provisioning.
// priceId values are placeholders until the real Stripe account + products
// exist ("tomorrow"); swap in real Stripe Price IDs when ready.
const PLANS = {
  studio: {
    key: 'studio',
    name: 'Studio',
    monthlyPrice: 19,
    annualPrice: 16, // per month, billed annually
    stripePriceIdMonthly: process.env.STRIPE_PRICE_STUDIO_MONTHLY || null,
    stripePriceIdAnnual: process.env.STRIPE_PRICE_STUDIO_ANNUAL || null,
    maxTeam: 3
  },
  pro: {
    key: 'pro',
    name: 'Studio Pro',
    monthlyPrice: 39,
    annualPrice: 33,
    stripePriceIdMonthly: process.env.STRIPE_PRICE_PRO_MONTHLY || null,
    stripePriceIdAnnual: process.env.STRIPE_PRICE_PRO_ANNUAL || null,
    maxTeam: 10
  },
  elite: {
    key: 'elite',
    name: 'Studio Elite',
    monthlyPrice: 59,
    annualPrice: 49,
    stripePriceIdMonthly: process.env.STRIPE_PRICE_ELITE_MONTHLY || null,
    stripePriceIdAnnual: process.env.STRIPE_PRICE_ELITE_ANNUAL || null,
    maxTeam: null // unlimited
  }
};

function getPlan(planKey) {
  return PLANS[planKey] || PLANS.pro;
}

// Stripe is optional until the real Studio Book business/Stripe account exists.
// Everything that touches Stripe checks this first and falls back to a
// "pending signup" path so the site is fully usable (and looks complete)
// before real billing credentials are in place.
function stripeConfigured() {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

function getStripe() {
  if (!stripeConfigured()) return null;
  // eslint-disable-next-line global-require
  const Stripe = require('stripe');
  return new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
}

const SITE_URL = process.env.URL || process.env.SITE_URL || 'https://studiobook.app';

module.exports = { json, PLANS, getPlan, stripeConfigured, getStripe, SITE_URL };

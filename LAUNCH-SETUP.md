# Studio Book — Launch Setup Checklist

Live marketing/signup site: https://verdant-sawine-7574a4.netlify.app
Repo: https://github.com/Haller28/studio-book-platform
Netlify team: "Studio Book"

Everything below is code-complete and already deployed. Nothing here requires
touching code again — it's all environment variables to add in Netlify
(Site settings → Environment variables) once the pieces exist. After adding
any of these, trigger a new deploy (Deploys → Trigger deploy → Deploy project)
for them to take effect.

## Works right now, with zero setup

- Marketing site, pricing, "why Studio Book," "how it works"
- Signup form (signup.html) — saves every request and shows a friendly
  "we'll follow up" message since billing isn't live yet
- /admin.html — internal view of signup requests, with a one-click
  "Provision free" button for comped accounts (like your wife's salon)

## Step 1 — Turn on basic storage (do this first, ~5 min)

So signup requests and the admin view persist instead of silently failing:

| Env var | Value |
|---|---|
| `NETLIFY_SITE_ID` | This site's own Site ID (Site settings → General → Site details) |
| `NETLIFY_BLOBS_TOKEN` | A Netlify Personal Access Token (User settings → Applications → New access token). **Enter this yourself** — I won't ever type or see this value, same as we did for Studio17. |
| `PROVISION_ADMIN_SECRET` | Any password you pick — protects /admin.html and the provisioning endpoint. I can generate a random one if you'd rather not think one up. |

## Step 2 — Turn on the welcome email (optional, ~2 min)

| Env var | Value |
|---|---|
| `GMAIL_USER` | A Gmail address to send from |
| `GMAIL_APP_PASSWORD` | An app password for that Gmail account |

## Step 3 — Turn on automated provisioning (once you're ready to onboard real salons)

Requires a Netlify Personal Access Token that belongs to the **Studio Book**
account/team (not your personal one), since it will be creating sites on
Studio Book's behalf.

| Env var | Value |
|---|---|
| `PROVISIONING_NETLIFY_TOKEN` | Studio Book's own Netlify PAT — **enter this yourself** |
| `PROVISIONING_ACCOUNT_SLUG` | The Netlify team slug new salon sites should be created under |
| `TEMPLATE_REPO` | `Haller28/salon-platform-template` (or wherever it ends up living once it's under the Studio Book GitHub org) |

Until this step is done, the "Provision free" button in /admin.html will just
say "Provisioning not set up yet" — safe, no errors.

## Step 4 — Turn on real billing (once the Studio Book business + Stripe account exist)

1. In Stripe: create three Products, each with a monthly Price and an annual
   Price — "Studio" ($19/mo, $16/mo billed annually), "Studio Pro" ($39/mo,
   $33/mo billed annually), and "Studio Elite" ($59/mo, $49/mo billed
   annually). Copy each Price ID.
2. Add these env vars:

| Env var | Value |
|---|---|
| `STRIPE_SECRET_KEY` | From Stripe Dashboard → Developers → API keys |
| `STRIPE_WEBHOOK_SECRET` | Create a webhook endpoint pointing at `https://<your-domain>/.netlify/functions/stripe-webhook`, listening for `checkout.session.completed` and `customer.subscription.deleted`. Copy its signing secret. |
| `STRIPE_PRICE_STUDIO_MONTHLY` / `STRIPE_PRICE_STUDIO_ANNUAL` | Price IDs from step 1 |
| `STRIPE_PRICE_PRO_MONTHLY` / `STRIPE_PRICE_PRO_ANNUAL` | Price IDs from step 1 |
| `STRIPE_PRICE_ELITE_MONTHLY` / `STRIPE_PRICE_ELITE_ANNUAL` | Price IDs from step 1 |

Once these are set, signup.html automatically switches from "we'll follow up"
to real Stripe Checkout — no code changes needed.

## Before making the site public

- Swap the placeholder Terms of Service (`terms.html`) and Privacy Policy
  (`privacy.html`) for versions reviewed by a lawyer — flagged clearly as
  drafts in the pages themselves.
- Point a real domain at the site (Domain settings → Add a domain).
- Decide on final card-processing rate to advertise (currently placeholder
  language, no specific % promised on the public pricing page).

## What's deliberately NOT built yet

- The "import from your old site" feature — needs an Anthropic API key and
  more design work. Marked "Coming soon" / "beta" everywhere it's mentioned
  so nothing overpromises.

# Signups — Google Sheet

New signups from salonvine.com are written straight into a Google Sheet.
There is no database.

## How it flows

1. Someone submits the form on `signup.html`.
2. `netlify/functions/create-checkout-session.js` receives it.
3. That function POSTs the signup to a Google Apps Script web app.
4. The Apps Script appends a row to the **Salon Vine Signups** sheet.

## The sheet

**Signups** tab — one row per signup:

| Column | Notes |
|---|---|
| Date | Timestamp, set automatically |
| Salon Name | |
| Owner Name | |
| Email | |
| Phone | |
| Plan | Dropdown: studio / pro / elite |
| Monthly Price | Auto-computed from Plan (19 / 39 / 59) |
| Old Site URL | Optional, from the form |
| Status | Dropdown: Pending / Provisioned / Cancelled |
| Site URL | Filled in once their site is live |

**Summary** tab — computes automatically:

- Total signups, and counts by status
- Monthly Recurring Revenue (sums Monthly Price where Status = Provisioned)
- Potential MRR including pending
- Signup counts per plan

## Environment variables

Both are set in Netlify (Project configuration → Environment variables):

| Variable | Purpose |
|---|---|
| `SHEET_ENDPOINT_URL` | The Apps Script web app `/exec` URL |
| `SHEET_SECRET` | Shared secret; the Apps Script rejects anything without it |

If either is missing, the signup still succeeds — the failure is logged to the
function logs rather than shown to the customer. Sheet problems must never
block someone from signing up.

## Changing the Apps Script

Open the sheet → Extensions → Apps Script. If you edit it, you must
**Deploy → Manage deployments → edit → Deploy** for changes to take effect.
Editing the code alone does nothing to the live endpoint.

If you ever create a brand-new deployment, the `/exec` URL changes and
`SHEET_ENDPOINT_URL` in Netlify has to be updated to match.

## Note on hosting

Netlify's free and Personal plans cannot deploy a **private** repository owned
by an **organization**. This repo is therefore public. Going private would
require Netlify Pro. No credentials live in this code — everything sensitive is
in environment variables — so public exposure is a competitive concern, not a
security one.

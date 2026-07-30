const { json } = require('./_lib');

// Powers the "Log In" lookup on login.html. Each subscriber's salon runs on
// its own independent site (see provision-site.js), so Salon Vine itself has
// no shared login — this looks up which site belongs to a given email and
// sends them there.
//
// Reads the Salon Vine Signups Google Sheet through the same Apps Script
// endpoint the signup form writes to. This previously read Netlify Blobs,
// which was never configured, so every lookup failed with a generic error
// no matter which email was entered.
// Instant sites (built by the salonvine.com signup wizard) live in the owner
// backend's Salons sheet — check there FIRST so wizard customers get sent
// straight to their live site. Falls through to the legacy signup-sheet
// lookup below for pre-wizard signups.
async function findInstantSite(email) {
  const url = process.env.SV_BACKEND_URL ||
    'https://script.google.com/macros/s/AKfycbyXCmFCL-HuLEFvZDTsV9fIrYiaRCW06ZuNl1uYR-4DhgaJpmthlUKaAIr8rtau2_g4/exec';
  const token = process.env.SV_BACKEND_TOKEN;
  if (!token) {
    console.error('findInstantSite skipped: SV_BACKEND_TOKEN not set');
    return null;
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ type: 'findSite', token, email })
    });
    const parsed = JSON.parse(await res.text());
    if (parsed && parsed.ok && parsed.found && parsed.url) {
      return { siteUrl: parsed.url, salonName: parsed.salonName || '' };
    }
  } catch (e) {
    console.error('findInstantSite failed (falling back to legacy lookup)', e);
  }
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Invalid JSON' }); }

  const email = String(body.email || '').toLowerCase().trim();
  if (!email) return json(400, { error: 'Email is required.' });

  // 1) Instant sites first (wizard-built salons go straight to their site)
  const instant = await findInstantSite(email);
  if (instant) {
    return json(200, { siteUrl: instant.siteUrl, salonName: instant.salonName });
  }

  // 2) Legacy lookup in the Salon Vine Signups sheet
  const url = process.env.SHEET_ENDPOINT_URL;
  const secret = process.env.SHEET_SECRET;
  if (!url || !secret) {
    console.error('find-site: SHEET_ENDPOINT_URL / SHEET_SECRET not set');
    return json(500, { error: "Lookup isn't available right now — please try again shortly." });
  }

  let result;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ secret, action: 'lookup', email })
    });
    const text = await res.text();
    try {
      result = JSON.parse(text);
    } catch (e) {
      console.error('find-site: non-JSON from sheet endpoint:', text.slice(0, 300));
      return json(502, { error: "We couldn't reach our records just now — please try again." });
    }
  } catch (e) {
    console.error('find-site lookup failed', e);
    return json(502, { error: "We couldn't reach our records just now — please try again." });
  }

  if (!result.ok) {
    console.error('find-site: lookup returned not-ok', result.error);
    return json(502, { error: "We couldn't reach our records just now — please try again." });
  }

  if (!result.found) {
    return json(404, {
      error: "We couldn't find a Salon Vine account for that email. Check the address you signed up with, or start a new salon."
    });
  }

  // Signed up, but their site hasn't been built yet.
  if (!result.siteUrl) {
    return json(409, {
      pending: true,
      salonName: result.salonName || '',
      error: `${result.salonName || 'Your salon'} is signed up, but the site isn't built yet. We'll email you the moment it's ready to claim.`
    });
  }

  return json(200, { siteUrl: result.siteUrl, salonName: result.salonName });
};

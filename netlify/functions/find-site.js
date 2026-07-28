const { getStore } = require('@netlify/blobs');
const { json } = require('./_lib');

// Powers the "Log In" lookup on login.html. Each subscriber's salon runs on
// its own independent site/domain (see the provisioning architecture in
// provision-site.js), so Salon Vine itself has no shared login — this just
// looks up which site belongs to a given email and redirects them there.
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Invalid JSON' }); }

  const email = String(body.email || '').toLowerCase().trim();
  if (!email) return json(400, { error: 'Email is required.' });

  try {
    const store = getStore({
      name: 'subscribers', consistency: 'strong',
      siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN
    });
    const record = await store.get(email, { type: 'json' });
    if (!record || !record.siteUrl) {
      return json(404, { error: "We couldn't find a Salon Vine site for that email." });
    }
    return json(200, { siteUrl: record.siteUrl, salonName: record.salonName });
  } catch (e) {
    console.error('find-site lookup failed', e);
    return json(500, { error: 'Something went wrong looking that up.' });
  }
};

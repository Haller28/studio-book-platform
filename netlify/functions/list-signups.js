const { getStore } = require('@netlify/blobs');
const { json } = require('./_lib');

// Powers admin.html — lets Dylan see who has requested a Salon Vine site
// before Stripe billing exists (e.g. his wife's salon, or anyone else who
// fills out signup.html while it's still in "pending" mode). Gated by a
// shared secret so random visitors can't read the signup list.
exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });

  const adminSecret = event.headers['x-admin-secret'] || event.headers['X-Admin-Secret'];
  if (!process.env.PROVISION_ADMIN_SECRET || adminSecret !== process.env.PROVISION_ADMIN_SECRET) {
    return json(403, { error: 'Not authorized.' });
  }

  try {
    const store = getStore({
      name: 'signup-requests', consistency: 'strong',
      siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN
    });
    const { blobs } = await store.list();
    const all = await Promise.all(blobs.map(b => store.get(b.key, { type: 'json' })));
    const signups = all.filter(Boolean).sort((a, b) => b.createdAt - a.createdAt);
    return json(200, { signups });
  } catch (e) {
    console.error('list-signups failed', e);
    // Most likely cause right now: NETLIFY_SITE_ID / NETLIFY_BLOBS_TOKEN
    // haven't been set on this site yet.
    return json(200, { signups: [], error: 'Signup storage is not configured yet (set NETLIFY_SITE_ID and NETLIFY_BLOBS_TOKEN).' });
  }
};

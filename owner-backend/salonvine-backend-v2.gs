/* ============================================================
   SalonVine — Live Data backend v2 (Google Apps Script)

   v2 adds the self-service onboarding wizard + instant salon
   sites on top of v1. Everything in v1 keeps working unchanged:
     - {type:'signup'}        signup token OR full token
     - {type:'signupStatus'}  full token only
     - {type:'salon'}         full token only
     - doGet?token=SV_TOKEN   full data read

   New in v2:
     - {type:'signupSite'}    signup token ok — signup row + owner
                              email + creates a live Salons row with
                              a unique slug. Returns {ok,id,slug,url}.
     - {type:'sitePhoto'}     signup token ok — saves a base64 JPEG
                              to Drive "SalonVine Sites/<slug>/",
                              shares anyone-with-link, appends the
                              lh3.googleusercontent URL to the
                              salon's photos JSON. Cap 8/salon.
     - {type:'siteLead'}      signup token ok — booking request from
                              a live salon site. Stored in SiteLeads
                              tab + emailed to the salon owner AND
                              the SalonVine owners.
     - doGet?site=<slug>      NO token — public site config only
                              ({slug,name,tagline,theme,accent,photos})
                              for status 'live-free'/'live' salons.

   Install/upgrade: open the "SalonVine — Live Data" Sheet ->
   Extensions -> Apps Script -> replace the file with this one ->
   run setup() once (migration-safe: appends missing headers /
   missing tabs, never wipes) -> Deploy -> Manage deployments ->
   edit the EXISTING web-app deployment -> New version. The /exec
   URL stays the same.

   Script Properties (unchanged):
     SV_TOKEN        — full read/write token
     SV_SIGNUP_TOKEN — light public token for the marketing site
   ============================================================ */

/* ---------- Owner notification list ---------- */
var OWNER_NOTIFY = ['zackbrockway17@gmail.com', 'halleroffroadllc@gmail.com'];

var PUBLIC_SITE_BASE = 'https://salonvine.com/s/';
var DRIVE_ROOT_FOLDER = 'SalonVine Sites';
var MAX_PHOTOS_PER_SALON = 8;
/* ~6MB of binary is ~8.4M base64 chars (incl. dataURL header slack) */
var MAX_PHOTO_POST_CHARS = 8600000;

var TABS = {
  SIGNUPS: 'Signups',
  REVENUE: 'Revenue',
  SALONS: 'Salons',
  SITELEADS: 'SiteLeads'
};

var HEADERS = {
  Signups: ['id', 'ts', 'salon', 'name', 'email', 'phone', 'website', 'plan', 'status', 'salonId', 'actor'],
  Revenue: ['ym', 'revenue', 'studio', 'pro', 'elite', 'trials', 'conversions', 'churn'],
  /* v2: new columns are APPENDED after the v1 columns so existing
     live sheets migrate by adding columns on the right. */
  Salons:  ['salonId', 'name', 'url', 'plan', 'status', 'slug', 'theme', 'accent', 'tagline', 'photos', 'config', 'createdAt'],
  SiteLeads: ['ts', 'slug', 'name', 'phone', 'email', 'message']
};

/* ============================================================
   Setup — run once. Migration-safe:
     - creates any missing tab
     - writes full headers on an empty tab
     - APPENDS any missing header columns on an existing tab
     - never clears or overwrites data
   ============================================================ */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(HEADERS).forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh) { sh = ss.insertSheet(name); }
    var want = HEADERS[name];
    var lastCol = Math.max(sh.getLastColumn(), 1);
    var firstRow = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
    var hasHeaders = firstRow.some(function (c) { return c !== ''; });
    if (!hasHeaders) {
      sh.getRange(1, 1, 1, want.length).setValues([want]);
      sh.setFrozenRows(1);
      return;
    }
    /* append any headers that don't exist yet */
    var missing = want.filter(function (h) { return firstRow.indexOf(h) === -1; });
    if (missing.length) {
      var start = firstRow.filter(function (c) { return c !== ''; }).length + 1;
      sh.getRange(1, start, 1, missing.length).setValues([missing]);
    }
    if (sh.getFrozenRows() < 1) { sh.setFrozenRows(1); }
  });
}

/* ============================================================
   Token helpers
   ============================================================ */
function props_() { return PropertiesService.getScriptProperties(); }
function fullToken_() { return props_().getProperty('SV_TOKEN') || ''; }
function signupToken_() { return props_().getProperty('SV_SIGNUP_TOKEN') || ''; }

function isFullToken_(t) { return !!t && !!fullToken_() && t === fullToken_(); }
function isSignupToken_(t) { return !!t && !!signupToken_() && t === signupToken_(); }
function isPublicWriteToken_(t) { return isSignupToken_(t) || isFullToken_(t); }

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ============================================================
   Sheet helpers
   ============================================================ */
function sheet_(name) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) { throw new Error('Missing tab: ' + name + ' — run setup()'); }
  return sh;
}

/* Map header name -> 1-based column, from the ACTUAL sheet header
   row (never assume column order — sheets may pre-date v2). */
function headerCols_(sh) {
  var lastCol = Math.max(sh.getLastColumn(), 1);
  var head = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  var map = {};
  head.forEach(function (h, i) { if (h !== '') { map[h] = i + 1; } });
  return map;
}

/* Append a row by header name (missing headers are skipped). */
function appendByHeaders_(sh, obj) {
  var cols = headerCols_(sh);
  var width = Math.max(sh.getLastColumn(), 1);
  var row = new Array(width).fill('');
  Object.keys(obj).forEach(function (k) {
    if (cols[k]) { row[cols[k] - 1] = obj[k]; }
  });
  sh.appendRow(row);
}

/* Read a tab into an array of objects keyed by its header row. */
function readTab_(name) {
  var sh = sheet_(name);
  var values = sh.getDataRange().getValues();
  if (values.length < 2) { return []; }
  var head = values[0].map(String);
  return values.slice(1)
    .filter(function (row) { return row.some(function (c) { return String(c) !== ''; }); })
    .map(function (row) {
      var obj = {};
      head.forEach(function (h, i) {
        var v = row[i];
        obj[h] = (v instanceof Date) ? v.toISOString() : v;
      });
      return obj;
    });
}

/* Find the sheet row number (1-based) of the salon with a slug. */
function findSalonRow_(slug) {
  var sh = sheet_(TABS.SALONS);
  var cols = headerCols_(sh);
  if (!cols.slug) { return null; }
  var values = sh.getDataRange().getValues();
  for (var r = 1; r < values.length; r++) {
    if (String(values[r][cols.slug - 1]).trim() === slug) {
      return { sheet: sh, rowNum: r + 1, cols: cols, row: values[r] };
    }
  }
  return null;
}

function salonCell_(found, header) {
  var c = found.cols[header];
  return c ? String(found.row[c - 1]) : '';
}

/* ============================================================
   Slug helpers
   ============================================================ */
function slugify_(s) {
  var out = String(s || '').toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return out.slice(0, 60).replace(/-+$/g, '') || 'salon';
}

function uniqueSlug_(base) {
  var existing = {};
  readTab_(TABS.SALONS).forEach(function (s) {
    var v = String(s.slug || '').trim();
    if (v) { existing[v] = true; }
  });
  if (!existing[base]) { return base; }
  for (var n = 2; n < 1000; n++) {
    var candidate = base + '-' + n;
    if (!existing[candidate]) { return candidate; }
  }
  return base + '-' + new Date().getTime();
}

/* ============================================================
   doGet
     ?site=<slug>       — PUBLIC, no token. Only safe fields, only
                          for status 'live-free' / 'live'.
     ?token=<SV_TOKEN>  — full data read (v1 behaviour; salons now
                          naturally include the new columns).
   ============================================================ */
function doGet(e) {
  var p = (e && e.parameter) || {};

  /* ---- public site config (no token) ---- */
  if (p.site) {
    return publicSiteConfig_(String(p.site));
  }

  if (!isFullToken_(p.token)) {
    return jsonOut_({ error: 'Unauthorized' });
  }

  var signups = readTab_(TABS.SIGNUPS);
  var salons = readTab_(TABS.SALONS);
  var months = readTab_(TABS.REVENUE).map(function (r) {
    return {
      ym: String(r.ym),
      revenue: Number(r.revenue) || 0,
      subs: {
        studio: Number(r.studio) || 0,
        pro: Number(r.pro) || 0,
        elite: Number(r.elite) || 0
      },
      trials: Number(r.trials) || 0,
      conversions: Number(r.conversions) || 0,
      churn: Number(r.churn) || 0
    };
  });

  return jsonOut_({ signups: signups, months: months, salons: salons });
}

function publicSiteConfig_(slugRaw) {
  var slug = slugify_(slugRaw) === slugRaw ? slugRaw : String(slugRaw).trim().toLowerCase();
  var found;
  try {
    found = findSalonRow_(slug);
  } catch (err) {
    return jsonOut_({ error: 'not found' });
  }
  if (!found) { return jsonOut_({ error: 'not found' }); }

  var status = salonCell_(found, 'status');
  if (status !== 'live-free' && status !== 'live') {
    return jsonOut_({ error: 'not found' });
  }

  var photos = [];
  try { photos = JSON.parse(salonCell_(found, 'photos') || '[]'); } catch (e2) { photos = []; }
  if (!Array.isArray(photos)) { photos = []; }

  /* ONLY public fields — no plan, no status, no config, no email */
  return jsonOut_({
    ok: true,
    slug: slug,
    name: salonCell_(found, 'name'),
    tagline: salonCell_(found, 'tagline'),
    theme: salonCell_(found, 'theme'),
    accent: salonCell_(found, 'accent'),
    photos: photos
  });
}

/* ============================================================
   doPost — token-gated writes
     {type:'signup'}       signup token or full token   (v1)
     {type:'signupSite'}   signup token or full token   (v2)
     {type:'sitePhoto'}    signup token or full token   (v2)
     {type:'siteLead'}     signup token or full token   (v2)
     {type:'signupStatus'} full token only              (v1)
     {type:'salon'}        full token only              (v1)
   Body arrives as text/plain JSON (avoids CORS preflight).
   ============================================================ */
function doPost(e) {
  var body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return jsonOut_({ error: 'Invalid JSON' });
  }

  var type = String(body.type || '');
  var token = String(body.token || '');

  /* Public (light-token) writes */
  if (type === 'signup' || type === 'signupSite' || type === 'sitePhoto' || type === 'siteLead') {
    if (!isPublicWriteToken_(token)) {
      return jsonOut_({ error: 'Unauthorized' });
    }
    try {
      if (type === 'signup') { return handleSignup_(body); }
      if (type === 'signupSite') { return handleSignupSite_(body); }
      if (type === 'sitePhoto') { return handleSitePhoto_(body); }
      if (type === 'siteLead') { return handleSiteLead_(body); }
    } catch (err2) {
      /* Return, don't throw — the client surfaces {error} and can
         fall back to a plain signup so the lead is never lost. */
      return jsonOut_({ error: 'Server error: ' + (err2 && err2.message ? err2.message : err2) });
    }
  }

  /* Everything else requires the full token. */
  if (!isFullToken_(token)) {
    return jsonOut_({ error: 'Unauthorized' });
  }
  if (type === 'signupStatus') { return handleSignupStatus_(body); }
  if (type === 'salon') { return handleSalonUpsert_(body); }

  return jsonOut_({ error: 'Unknown type: ' + type });
}

/* ------------------------------------------------------------
   Signup core — shared by {type:'signup'} and {type:'signupSite'}.
   De-dupe guard: same email within 10 minutes is treated as a
   double-submit and acknowledged without a second row/email.
   Returns {id, deduped}.
   ------------------------------------------------------------ */
function signupCore_(body, now) {
  var sh = sheet_(TABS.SIGNUPS);
  var email = String(body.email || '').trim().toLowerCase();

  var TEN_MIN = 10 * 60 * 1000;
  var existing = readTab_(TABS.SIGNUPS);
  for (var i = existing.length - 1; i >= 0; i--) {
    var r = existing[i];
    if (String(r.email || '').trim().toLowerCase() === email && email !== '') {
      var ts = new Date(r.ts);
      if (!isNaN(ts.getTime()) && (now.getTime() - ts.getTime()) < TEN_MIN) {
        return { id: r.id, deduped: true };
      }
    }
  }

  var id = 'su_' + now.getTime() + '_' + Math.floor(Math.random() * 10000);
  appendByHeaders_(sh, {
    id: id,
    ts: now.toISOString(),
    salon: String(body.salon || ''),
    name: String(body.name || ''),
    email: String(body.email || ''),
    phone: String(body.phone || ''),
    website: String(body.website || ''),
    plan: String(body.plan || ''),
    status: 'new',
    salonId: String(body.salonId || ''),
    actor: String(body.actor || 'public-form')
  });

  notifyOwnersOfSignup_(body, id, now);
  return { id: id, deduped: false };
}

/* ------------------------------------------------------------
   {type:'signup'} — v1 INSERT from the marketing-site form.
   Extra wizard fields (theme/accent/tagline/slug) are accepted
   and simply appended into the owner email so nothing is lost
   when the client falls back to a plain signup.
   ------------------------------------------------------------ */
function handleSignup_(body) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var res = signupCore_(body, new Date());
    return jsonOut_({ ok: true, id: res.id, deduped: res.deduped || undefined });
  } finally {
    lock.releaseLock();
  }
}

/* Owner notification email for every new signup. */
function notifyOwnersOfSignup_(body, id, when) {
  var subject = 'New SalonVine trial signup — ' + String(body.salon || '(no salon name)');
  var lines = [
    'A new signup just came in from salonvine.com:',
    '',
    'Salon:    ' + (body.salon || '—'),
    'Contact:  ' + (body.name || '—'),
    'Email:    ' + (body.email || '—'),
    'Phone:    ' + (body.phone || '—'),
    'Website:  ' + (body.website || '—'),
    'Plan:     ' + (body.plan || '—') + ' (free during early access)',
    'When:     ' + when.toString(),
    'ID:       ' + id
  ];
  if (body.theme || body.tagline || body.accent) {
    lines.push('');
    lines.push('Site preferences from the wizard:');
    if (body.theme) { lines.push('Theme:    ' + body.theme); }
    if (body.accent) { lines.push('Accent:   ' + body.accent); }
    if (body.tagline) { lines.push('Tagline:  ' + body.tagline); }
    if (body.slug) { lines.push('Slug:     ' + body.slug); }
  }
  lines.push('');
  lines.push('Open the owner portal to follow up: https://portal.salonvine.com');
  OWNER_NOTIFY.forEach(function (addr) {
    if (!addr || addr.indexOf('PLACEHOLDER') === 0) { return; }
    try {
      MailApp.sendEmail(addr, subject, lines.join('\n'));
    } catch (err) {
      console.error('Notify failed for ' + addr + ': ' + err);
    }
  });
}

/* ------------------------------------------------------------
   {type:'signupSite'} — v2 wizard submit. Does everything
   {type:'signup'} does PLUS creates the live Salons row.
   Body: {salon,name,email,phone,website,plan,slug,theme,accent,tagline}
   Returns {ok, id, slug, url}.

   Retry-safe: if the same email already created a salon in the
   last 24h (e.g. the visitor hit Retry after a partial failure),
   the existing slug/url is returned instead of a duplicate site.
   ------------------------------------------------------------ */
function handleSignupSite_(body) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var now = new Date();
    var email = String(body.email || '').trim().toLowerCase();
    if (!String(body.salon || '').trim() || !email) {
      return jsonOut_({ error: 'Need salon and email' });
    }

    /* retry guard: same email already has a fresh salon? */
    var DAY = 24 * 60 * 60 * 1000;
    var salons = readTab_(TABS.SALONS);
    for (var i = salons.length - 1; i >= 0; i--) {
      var s = salons[i];
      var cfg = {};
      try { cfg = JSON.parse(String(s.config || '{}')); } catch (e1) { cfg = {}; }
      if (String(cfg.email || '').toLowerCase() === email && s.slug) {
        var created = new Date(s.createdAt);
        if (!isNaN(created.getTime()) && (now.getTime() - created.getTime()) < DAY) {
          signupCore_(body, now); /* still record/dedupe the lead */
          return jsonOut_({ ok: true, id: '', slug: String(s.slug), url: String(s.url || (PUBLIC_SITE_BASE + s.slug)), existing: true });
        }
      }
    }

    /* 1) the lead row + owner email (dedupe-aware) */
    var su = signupCore_(body, now);

    /* 2) the live salon row */
    var slug = uniqueSlug_(slugify_(body.slug || body.salon));
    var url = PUBLIC_SITE_BASE + slug;
    var salonId = 'sal_' + now.getTime() + '_' + Math.floor(Math.random() * 10000);
    var config = {
      email: String(body.email || ''),
      owner: String(body.name || ''),
      phone: String(body.phone || ''),
      signupId: su.id
    };
    appendByHeaders_(sheet_(TABS.SALONS), {
      salonId: salonId,
      name: String(body.salon || ''),
      url: url,
      plan: String(body.plan || ''),
      status: 'live-free',
      slug: slug,
      theme: String(body.theme || 'classic-cream'),
      accent: String(body.accent || ''),
      tagline: String(body.tagline || ''),
      photos: '[]',
      config: JSON.stringify(config),
      createdAt: now.toISOString()
    });

    return jsonOut_({ ok: true, id: su.id, slug: slug, url: url });
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------
   {type:'sitePhoto'} — v2. Body {slug, n, data: base64 dataURL}.
   Saves to Drive "SalonVine Sites/<slug>/", shares
   anyone-with-link, appends the lh3 URL to the salon's photos.
   ------------------------------------------------------------ */
function handleSitePhoto_(body) {
  var slug = String(body.slug || '').trim().toLowerCase();
  var data = String(body.data || '');
  var n = Number(body.n) || 0;

  if (!slug || !data) { return jsonOut_({ error: 'Need slug and data' }); }
  if (data.length > MAX_PHOTO_POST_CHARS) { return jsonOut_({ error: 'Photo too large' }); }
  var m = data.match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,(.+)$/);
  if (!m) { return jsonOut_({ error: 'Expected a base64 image dataURL' }); }

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var found = findSalonRow_(slug);
    if (!found) { return jsonOut_({ error: 'Unknown site: ' + slug }); }

    var photos = [];
    try { photos = JSON.parse(salonCell_(found, 'photos') || '[]'); } catch (e1) { photos = []; }
    if (!Array.isArray(photos)) { photos = []; }
    if (photos.length >= MAX_PHOTOS_PER_SALON) {
      return jsonOut_({ error: 'Photo limit reached (' + MAX_PHOTOS_PER_SALON + ')' });
    }

    var contentType = m[1] === 'image/jpg' ? 'image/jpeg' : m[1];
    var bytes;
    try {
      bytes = Utilities.base64Decode(m[2]);
    } catch (e2) {
      return jsonOut_({ error: 'Bad base64 data' });
    }
    var ext = contentType === 'image/png' ? 'png' : (contentType === 'image/webp' ? 'webp' : 'jpg');
    var blob = Utilities.newBlob(bytes, contentType, slug + '-' + (n || photos.length + 1) + '.' + ext);

    var folder = getOrCreateFolder_(getOrCreateRootFolder_(), slug);
    var file = folder.createFile(blob);
    try {
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    } catch (e3) {
      console.error('setSharing failed for ' + slug + ': ' + e3);
    }

    var url = 'https://lh3.googleusercontent.com/d/' + file.getId() + '=w1600';
    photos.push(url);
    var col = found.cols.photos;
    if (col) { found.sheet.getRange(found.rowNum, col).setValue(JSON.stringify(photos)); }

    return jsonOut_({ ok: true, url: url, count: photos.length });
  } finally {
    lock.releaseLock();
  }
}

function getOrCreateRootFolder_() {
  var it = DriveApp.getFoldersByName(DRIVE_ROOT_FOLDER);
  return it.hasNext() ? it.next() : DriveApp.createFolder(DRIVE_ROOT_FOLDER);
}

function getOrCreateFolder_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

/* ------------------------------------------------------------
   {type:'siteLead'} — v2 booking request from a live salon site.
   Body {slug, name, phone, email, message}. Stored to SiteLeads
   + emailed to the salon's signup email AND the owners.
   De-dupe: same email+slug within 5 minutes.
   ------------------------------------------------------------ */
function handleSiteLead_(body) {
  var slug = String(body.slug || '').trim().toLowerCase();
  var name = String(body.name || '').trim();
  var phone = String(body.phone || '').trim();
  var email = String(body.email || '').trim();
  var message = String(body.message || '').trim();
  if (!slug) { return jsonOut_({ error: 'Need slug' }); }
  if (!name || (!phone && !email)) {
    return jsonOut_({ error: 'Need a name and a phone or email' });
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var now = new Date();

    /* de-dupe: same email + slug in the last 5 minutes */
    var FIVE_MIN = 5 * 60 * 1000;
    var emailLc = email.toLowerCase();
    if (emailLc) {
      var existing = readTab_(TABS.SITELEADS);
      for (var i = existing.length - 1; i >= 0; i--) {
        var r = existing[i];
        if (String(r.slug || '') === slug && String(r.email || '').toLowerCase() === emailLc) {
          var ts = new Date(r.ts);
          if (!isNaN(ts.getTime()) && (now.getTime() - ts.getTime()) < FIVE_MIN) {
            return jsonOut_({ ok: true, deduped: true });
          }
        }
      }
    }

    appendByHeaders_(sheet_(TABS.SITELEADS), {
      ts: now.toISOString(),
      slug: slug,
      name: name,
      phone: phone,
      email: email,
      message: message
    });

    /* find the salon + its owner email */
    var found = findSalonRow_(slug);
    var salonName = found ? (salonCell_(found, 'name') || slug) : slug;
    var ownerEmail = '';
    if (found) {
      try {
        var cfg = JSON.parse(salonCell_(found, 'config') || '{}');
        ownerEmail = String(cfg.email || '');
      } catch (e1) { ownerEmail = ''; }
    }

    var subject = 'New booking request — ' + salonName;
    var lines = [
      'Someone just requested an appointment on your Salon Vine site:',
      '',
      'Salon:    ' + salonName + ' (' + PUBLIC_SITE_BASE + slug + ')',
      'Name:     ' + (name || '—'),
      'Phone:    ' + (phone || '—'),
      'Email:    ' + (email || '—'),
      'Message:  ' + (message || '—'),
      'When:     ' + now.toString(),
      '',
      'Reply directly to the client to book them in.'
    ];
    var recipients = [];
    if (ownerEmail) { recipients.push(ownerEmail); }
    OWNER_NOTIFY.forEach(function (a) { if (recipients.indexOf(a) === -1) { recipients.push(a); } });
    recipients.forEach(function (addr) {
      if (!addr || addr.indexOf('PLACEHOLDER') === 0) { return; }
      try {
        MailApp.sendEmail(addr, subject, lines.join('\n'));
      } catch (err) {
        console.error('Lead notify failed for ' + addr + ': ' + err);
      }
    });

    return jsonOut_({ ok: true });
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------
   {type:'signupStatus', id, status} — v1, unchanged.
   ------------------------------------------------------------ */
function handleSignupStatus_(body) {
  var VALID = ['new', 'contacted', 'converted', 'lost'];
  var id = String(body.id || '');
  var status = String(body.status || '');
  if (!id || VALID.indexOf(status) === -1) {
    return jsonOut_({ error: 'Need id and a valid status (' + VALID.join('/') + ')' });
  }
  var sh = sheet_(TABS.SIGNUPS);
  var values = sh.getDataRange().getValues();
  var head = values[0].map(String);
  var idCol = head.indexOf('id');
  var statusCol = head.indexOf('status');
  for (var r = 1; r < values.length; r++) {
    if (String(values[r][idCol]) === id) {
      sh.getRange(r + 1, statusCol + 1).setValue(status);
      return jsonOut_({ ok: true, id: id, status: status });
    }
  }
  return jsonOut_({ error: 'Signup not found: ' + id });
}

/* ------------------------------------------------------------
   {type:'salon', salonId, ...} — v1 upsert, now header-driven so
   it works with the extended Salons columns too.
   ------------------------------------------------------------ */
function handleSalonUpsert_(body) {
  var salonId = String(body.salonId || '');
  if (!salonId) { return jsonOut_({ error: 'Need salonId' }); }
  var sh = sheet_(TABS.SALONS);
  var cols = headerCols_(sh);
  var values = sh.getDataRange().getValues();
  var idCol = cols.salonId;
  if (!idCol) { return jsonOut_({ error: 'Salons tab missing salonId header — run setup()' }); }
  for (var r = 1; r < values.length; r++) {
    if (String(values[r][idCol - 1]) === salonId) {
      /* update: only overwrite provided fields */
      HEADERS.Salons.forEach(function (h) {
        if (body[h] !== undefined && cols[h]) {
          sh.getRange(r + 1, cols[h]).setValue(String(body[h]));
        }
      });
      return jsonOut_({ ok: true, salonId: salonId, updated: true });
    }
  }
  var obj = {};
  HEADERS.Salons.forEach(function (h) { obj[h] = String(body[h] || ''); });
  appendByHeaders_(sh, obj);
  return jsonOut_({ ok: true, salonId: salonId, created: true });
}

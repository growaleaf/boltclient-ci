// boltclient-ci-license — license server for the standalone "boltclient-ci" CLI
//
// Stateless: no database, no logs of user data. It does exactly four things:
//   /            landing page
//   /buy         302 → Stripe payment link
//   /license     verifies a Stripe Checkout session, mints a signed license key
//   /privacy     privacy policy   /terms  terms of sale & refunds
//
// Secrets (wrangler secret put): STRIPE_SECRET_KEY, LICENSE_PRIVATE_KEY (PKCS8 b64)
// Vars (wrangler.jsonc):         PAYMENT_LINK_URL
//
// Shares the same BP-001 license chassis and the same "boltclient-pro" product id / BC1
// prefix as the Boltclient VS Code extension — one license key unlocks both surfaces.

const PRODUCT = 'boltclient-ci';
const SUPPORT = 'greenboxhydro@gmail.com';
const SELLER = 'Unlimited Chaos (the developer)';
const REPO_URL = 'https://github.com/growaleaf/boltclient-ci';

function b64ToBytes(b64) {
  const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function mintLicense(email, privateKeyB64) {
  const payload = new TextEncoder().encode(JSON.stringify({ e: email, t: Math.floor(Date.now() / 1000), product: 'boltclient-pro' }));
  const key = await crypto.subtle.importKey(
    'pkcs8', b64ToBytes(privateKeyB64),
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(`BC1.${bytesToB64url(payload)}`)));
  return `BC1.${bytesToB64url(payload)}.${bytesToB64url(sig)}`;
}

const CSS = `
  body{margin:0;background:#0f1115;color:#e8eaf0;font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
  main{max-width:680px;margin:0 auto;padding:48px 20px}
  h1{font-size:26px} h2{font-size:19px;margin-top:32px}
  a{color:#4f8cff} .muted{color:#9aa1b2;font-size:14px}
  .card{background:#171a21;border:1px solid #232838;border-radius:12px;padding:22px;margin:18px 0}
  .key{font-family:ui-monospace,monospace;font-size:13px;word-break:break-all;background:#1e2230;
       border:1px solid #2a3145;border-radius:8px;padding:14px;user-select:all}
  .btn{display:inline-block;background:#4f8cff;color:#fff;border-radius:9px;padding:10px 18px;
       text-decoration:none;font-weight:600;margin-top:12px}
  ul{padding-left:20px} li{margin:6px 0}
  footer{margin-top:40px;color:#9aa1b2;font-size:13px}
`;

function page(title, body) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>${CSS}</style></head><body><main>${body}
<footer>${PRODUCT} · <a href="/privacy">Privacy</a> · <a href="/terms">Terms &amp; refunds</a> · ${SUPPORT}</footer>
</main></body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

const LANDING = `
<h1>${PRODUCT}</h1>
<p>Replay your API collection in CI before you deploy. Runs a Boltclient collection — or a
Thunder Client / Postman v2.1 export, auto-detected — against a named environment and fails
the build the moment any request comes back 4xx/5xx or can't connect.</p>
<div class="card"><ul>
<li><strong>Pro ($14, one time):</strong> an offline-checked license key for the CLI at
<a href="${REPO_URL}">${REPO_URL}</a>. No subscription, no per-seat pricing, no recurring
charge, no telemetry — the license check never makes a network call.</li>
<li>The same key also unlocks the Boltclient VS Code extension's Pro tier once that listing is
live — one purchase, both surfaces.</li>
</ul></div>
<a class="btn" href="/buy">Buy Pro — $14</a>
<p class="muted">Source is readable at the repo above before you buy.</p>`;

const PRIVACY = `
<h1>Privacy policy</h1>
<p class="muted">Effective 2026-10-16 · ${PRODUCT}</p>
<h2>The short version</h2>
<p>Your requests, your environment variables, and your API's responses never leave your
machine or your CI runner. The CLI makes no network request of any kind to check a license.</p>
<h2>What this website sees</h2>
<p>If you buy Pro, payment is processed by <a href="https://stripe.com/privacy">Stripe</a>.
After checkout, this site reads the checkout result from Stripe (your email address and
payment status) once, to generate your license key. We keep no database and store none of
it — the license key shown to you is derived and forgotten.</p>
<h2>Contact</h2><p>${SUPPORT}</p>`;

const TERMS = `
<h1>Terms of sale &amp; refunds</h1>
<p class="muted">Effective 2026-10-16 · ${PRODUCT}</p>
<ul>
<li><strong>Pro</strong> is a one-time purchase of <strong>$14 USD</strong> that unlocks the
CLI's "run" command. No subscription, no recurring charges.</li>
<li>Pro is sold by <strong>${SELLER}</strong>, and payment is processed by Stripe.</li>
<li>Delivery: your license key is shown immediately after checkout. Set it via the
<code>BOLTCLIENT_KEY</code> environment variable or <code>~/.boltclient/license</code>. It
works offline and on all your machines.</li>
<li><strong>Refunds:</strong> if Pro doesn't work for you, email ${SUPPORT} within 14 days
of purchase for a full refund — no questions asked.</li>
<li>Lost your key? Email ${SUPPORT} from the address you paid with and we'll re-issue it.</li>
</ul>`;

async function licensePage(url, env) {
  const sessionId = url.searchParams.get('session_id');
  if (!sessionId) return page('License', '<h1>Missing checkout session</h1><p>This page is reached automatically after a successful purchase.</p>');
  const resp = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
    headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  if (!resp.ok) {
    return page('License', `<h1>Couldn't find that purchase</h1><p>The checkout reference wasn't recognised. If you completed payment, email ${SUPPORT} with your Stripe receipt and we'll issue your key by hand.</p>`);
  }
  const session = await resp.json();
  if (session.payment_status !== 'paid') {
    return page('License', `<h1>Payment not completed</h1><p>This checkout hasn't been paid. If you believe that's wrong, email ${SUPPORT}.</p>`);
  }
  const email = (session.customer_details && session.customer_details.email) || '';
  const key = await mintLicense(email, env.LICENSE_PRIVATE_KEY);
  return page('Your Pro license', `
<h1>&#10003; Thank you &mdash; here's your Pro key</h1>
<div class="card">
<p><strong>Copy this key</strong> (click it to select), then set it as
<code>BOLTCLIENT_KEY</code> in your CI secrets, or write it to
<code>~/.boltclient/license</code> on your own machine:</p>
<div class="key">${key}</div>
<p class="muted">Licensed to ${email || 'your purchase email'}. Keep this page's key somewhere
safe — or just email ${SUPPORT} from your purchase address any time for a re-issue. Bookmarking
this page also works: it re-generates your key on each visit.</p>
</div>`);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    switch (url.pathname) {
      case '/': return page(PRODUCT, LANDING);
      case '/buy': return Response.redirect(env.PAYMENT_LINK_URL || '/', 302);
      case '/license': return licensePage(url, env);
      case '/privacy': return page('Privacy policy', PRIVACY);
      case '/terms': return page('Terms of sale & refunds', TERMS);
      default: return new Response('Not found', { status: 404 });
    }
  },
};

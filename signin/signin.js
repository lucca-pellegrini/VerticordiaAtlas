// The sign-in page: Google (the server does the redirect and checks the ID token), or a secret key. Either way the server sets the session.
const rawNext = new URLSearchParams(location.search).get('next') || '';
// only a path on this site: "/x" (not "//host") or nothing
const nextPath = /^\/(?!\/)/.test(rawNext) ? rawNext : '/';
const next = nextPath === '/' ? '../' : nextPath;
const api = (method, path, body) => fetch(new URL('../api/' + path, location.href), {
  method, cache: 'no-store', credentials: 'same-origin',
  headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
  body: body !== undefined ? JSON.stringify(body) : undefined,
}).then(async r => {
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
});
const $ = id => document.getElementById(id);
const showError = msg => { const e = $('secret-error'); e.textContent = msg; e.hidden = !msg; };
const done = () => { location.href = next; };

/* ---------- Google: our own button; the server sends the browser to Google and back (see api.mjs) ---------- */
async function setupGoogle() {
  const error = new URLSearchParams(location.search).get('error');
  if (error) { $('google-error').textContent = error; $('google-error').hidden = false; }
  let configured = false;
  try { configured = !!(await api('GET', 'config')).googleClientId; } catch { /* offline: no Google */ }
  if (!configured) { $('google-off').hidden = false; return; }
  const btn = $('google-btn');
  btn.href = `../api/auth/google/start?next=${encodeURIComponent(nextPath)}`;
  btn.hidden = false;
}
setupGoogle();

/* ---------- secret keys ---------- */
$('toggle-secret').onclick = () => {
  const open = $('secret-panel').hidden;
  $('secret-panel').hidden = !open;
  $('toggle-secret').setAttribute('aria-expanded', String(open));
};

$('secret-new').onclick = async () => {
  showError('');
  try {
    const { secret } = await api('POST', 'auth/secret/new', {});
    $('secret-value').textContent = secret;
    $('secret-shown').hidden = false;
    $('secret-new').hidden = true;
  } catch (e) { showError(e.message); }
};
$('secret-saved').onchange = e => { $('secret-continue').disabled = !e.target.checked; };
$('secret-continue').onclick = done;

$('secret-login').onsubmit = async e => {
  e.preventDefault();
  showError('');
  try { await api('POST', 'auth/secret/login', { secret: $('secret-input').value }); done(); }
  catch (err) { showError(err.message); }
};

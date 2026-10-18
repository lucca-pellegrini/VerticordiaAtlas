// The sign-in page: Google (the server checks the ID token), or a secret key. Either way the server sets the session.
const next = (() => {
  const n = new URLSearchParams(location.search).get('next') || '';
  // only a path on this site: "/x" (not "//host") or nothing
  return /^\/(?!\/)/.test(n) ? n : '../';
})();
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

/* ---------- Google ---------- */
async function setupGoogle() {
  let clientId = null;
  try { ({ googleClientId: clientId } = await api('GET', 'config')); } catch { /* offline: no Google */ }
  if (!clientId) { $('google-off').hidden = false; return; }
  const start = () => {
    if (!window.google?.accounts?.id) { $('google-off').textContent = 'Google sign-in could not load. Check your connection, or use a secret key.'; $('google-off').hidden = false; return; }
    google.accounts.id.initialize({
      client_id: clientId,
      callback: async ({ credential }) => {
        try { await api('POST', 'auth/google', { credential }); done(); }
        catch (e) { showError(e.message); }
      },
    });
    google.accounts.id.renderButton($('google-btn'), { type: 'standard', theme: 'filled_black', size: 'large', shape: 'pill', text: 'signin_with', width: 320 });
  };
  if (window.google?.accounts) start();
  else addEventListener('load', start, { once: true });
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

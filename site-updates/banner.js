/*
  The admin banner: "an engine9 update is available" with an Update button. Plain browser code, no dependencies.

    import { mountUpdateBanner } from './banner.js';
    mountUpdateBanner(document.getElementById('update-banner'), { url: '/api/admin/engine9-update' });

  Shows nothing while the site is current (or the check cannot be made). Pressing Update starts the site's update
  workflow, then it checks again until the pull request is ready. Text goes in with textContent, never as HTML.
  Style it with .e9u, .e9u-text, .e9u-button, or set --e9u-bg / --e9u-fg / --e9u-accent.
*/
const CSS = `.e9u{display:flex;flex-wrap:wrap;gap:.75rem;align-items:center;padding:.75rem 1rem;margin:0 0 1rem;border-radius:var(--e9u-radius,8px);background:var(--e9u-bg,#fff7e0);color:var(--e9u-fg,#3a2e00);border:1px solid var(--e9u-accent,#d9a400);font:inherit}
.e9u[hidden]{display:none}.e9u-text{flex:1 1 16rem}.e9u a{color:inherit;font-weight:600}
.e9u-button{font:inherit;font-weight:600;padding:.4rem .9rem;border-radius:var(--e9u-radius,8px);border:1px solid var(--e9u-accent,#d9a400);background:var(--e9u-accent,#d9a400);color:#fff;cursor:pointer}
.e9u-button[disabled]{opacity:.6;cursor:default}`;

export const short = (sha) => String(sha || '').slice(0, 7);

/* What the banner says for a status. Pure, so it can be tested without a browser. */
export function describe(status, { readyNote = '' } = {}) {
  switch (status?.state) {
    case 'available': return { text: `A newer engine9 core is available (${short(status.pinned)} to ${short(status.newest)}). Updating prepares a pull request; nothing changes on the live site until you merge and deploy it.`, button: 'Update' };
    case 'running': return { text: 'The update is being prepared. A pull request will appear here when it is ready.', busy: true };
    case 'ready': return { text: `An update is ready to review${status.pr?.draft ? ' (its tests failed, so it is a draft)' : ''}. ${readyNote}`.trim(), link: { href: status.pr?.url, label: `Open pull request #${status.pr?.number}` } };
    case 'failed': return { text: 'The update could not be started. Try again, or run the engine9-updates workflow from GitHub.', button: 'Try again' };
    default: return null;
  }
}

export function mountUpdateBanner(el, { url, fetch: fetchFn = globalThis.fetch.bind(globalThis), readyNote = '', pollMs = 15000, maxPolls = 40 } = {}) {
  if (!el.ownerDocument.getElementById('e9u-style')) {
    const s = el.ownerDocument.createElement('style'); s.id = 'e9u-style'; s.textContent = CSS; el.ownerDocument.head.appendChild(s);
  }
  el.classList.add('e9u'); el.hidden = true;
  let polls = 0; let timer = null;

  function render(status) {
    const d = describe(status, { readyNote });
    el.textContent = '';
    if (!d) { el.hidden = true; return; }
    const text = el.ownerDocument.createElement('span'); text.className = 'e9u-text'; text.textContent = d.text; el.appendChild(text);
    if (d.link?.href && /^https:\/\/github\.com\//.test(d.link.href)) {
      const a = el.ownerDocument.createElement('a'); a.href = d.link.href; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = d.link.label; el.appendChild(a);
    }
    if (d.button) {
      const b = el.ownerDocument.createElement('button'); b.type = 'button'; b.className = 'e9u-button'; b.textContent = d.button;
      b.addEventListener('click', start); el.appendChild(b);
    }
    el.hidden = false;
    if (d.busy && polls < maxPolls) { clearTimeout(timer); timer = setTimeout(check, pollMs); polls += 1; }
  }
  async function check() {
    try { render(await (await fetchFn(url, { credentials: 'same-origin' })).json()); } catch { el.hidden = true; }
  }
  async function start(ev) {
    ev.currentTarget.disabled = true; ev.currentTarget.textContent = 'Starting...';
    try {
      const res = await (await fetchFn(url, { method: 'POST', credentials: 'same-origin', headers: { 'X-Engine9-Update': '1' } })).json();
      polls = 0; render(res.started ? res.status : { state: res.reason === 'error' ? 'failed' : res.status?.state });
    } catch { render({ state: 'failed' }); }
  }
  check();
  return { refresh: check, stop: () => clearTimeout(timer) };
}

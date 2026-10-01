/*
  The screens for a hub with more than one account (see ../accounts.js): a small switcher above the usual screens. It mounts one
  mountEmailHub per account, at `<base>/<account id>`, and swaps them when the person picks another.

    import { mountEmailHubs } from '/email-hub/accounts.js';
    const hubs = mountEmailHubs(document.getElementById('email'), {
      base: '/api/admin/email',
      accounts: [{ id: 'main', label: 'Main list' }, { id: 'other', label: 'Other list', brandName: 'Other' }],
      account: 'main',                 // optional: where to start (default: the one used last in this browser, else the first)
      ...every other option mountEmailHub takes (timeZone, theme, extras, ...)
    });
    hubs.show('other'); hubs.account; hubs.hub(); hubs.destroy();

  With no `accounts` (or an empty list) it is exactly mountEmailHub, so a host can pass whatever it has. A draft kept in the
  browser is kept per account (`draftKey` + the account id), so words written for one list never turn up in another.
*/
import { mountEmailHub } from './hub.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inBrowser = () => typeof document !== 'undefined';
const remembered = (key) => { try { return inBrowser() ? globalThis.localStorage?.getItem(key) || '' : ''; } catch { return ''; } };
const remember = (key, id) => { try { if (inBrowser()) globalThis.localStorage?.setItem(key, id); } catch { /* a private window: fine */ } };

export function mountEmailHubs(root, options = {}) {
  const { accounts = [], base = '/mail', account: wanted = '', mount = mountEmailHub, storageKey = 'email-hub-account', ...rest } = options;
  if (!accounts.length) return mount(root, { base, ...rest });

  const byId = new Map(accounts.map((a) => [String(a.id), a]));
  root.classList.add('eh-multi');
  root.innerHTML = `<div class="eh-accounts"><label for="eh-account">Account</label><select id="eh-account" aria-label="Email account">${accounts.map((a) => `<option value="${esc(a.id)}">${esc(a.label || a.id)}</option>`).join('')}</select></div><div id="eh-account-hub"></div>`;
  const select = root.querySelector('#eh-account');
  const host = root.querySelector('#eh-account-hub');
  let current = '', hub = null;

  const show = (id) => {
    const a = byId.get(String(id));
    if (!a) return hub;
    hub?.destroy?.();
    current = String(a.id);
    select.value = current;
    remember(storageKey, current);
    hub = mount(host, { ...rest, base: `${base}/${current}`, draftKey: `${rest.draftKey || 'email-hub-draft'}-${current}`, brandName: a.brandName ?? a.label ?? rest.brandName ?? '' });
    return hub;
  };
  select.addEventListener('change', () => show(select.value));
  show([wanted, remembered(storageKey), accounts[0].id].find((id) => id && byId.has(String(id))));

  return {
    show,
    get account() { return current; },
    hub: () => hub,
    destroy() { hub?.destroy?.(); hub = null; root.innerHTML = ''; root.classList.remove('eh-multi'); },
  };
}

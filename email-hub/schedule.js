/*
  The one action that reaches an audience: scheduling. The rules are the hub's, not the provider's, so every site
  gets the same protection: a draft only, confirmed by the person, at least LEAD_MS from now, on a quarter hour
  (services send on :00 :15 :30 :45), and only when the service itself says the email is ready.
*/
import { HubError } from './provider.js';

export const QUARTER_MS = 15 * 60 * 1000;
export const LEAD_MS = 15 * 60 * 1000;

/* `sendAt` is any moment; it is rounded UP to the next quarter hour and the exact time is handed back so the
   screen can say it. */
export function planSchedule(sendAt, confirm, now = Date.now()) {
  if (confirm !== true) throw new HubError('Tick the box to say you have read the preview.');
  const when = Date.parse(sendAt);
  if (!Number.isFinite(when)) throw new HubError('Pick a day and time to send.');
  const at = Math.ceil(when / QUARTER_MS) * QUARTER_MS;
  if (at < now + LEAD_MS) throw new HubError('Choose a time at least 15 minutes from now.');
  return { at, iso: new Date(at).toISOString().replace(/\.\d+Z$/, 'Z') };
}

export const isDraft = (c) => c.status === 'save' || c.status === 'paused';

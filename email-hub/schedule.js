/*
  The one action that reaches an audience: scheduling. The rules are the hub's, not the provider's, so every site
  gets the same protection: a draft only, confirmed by the person, at least `leadMinutes` from now, on a `stepMinutes`
  boundary, and only when the service itself says the email is ready.

  The defaults are the strictest common ground (15 minutes' notice, a quarter hour: Mailchimp only sends on :00 :15 :30
  :45). A host on a service without that limit may loosen them with `createEmailHub({ schedule: { leadMinutes, stepMinutes } })`,
  never below 1 minute. Nothing else about the guard is configurable.
*/
import { HubError } from './provider.js';

export const QUARTER_MS = 15 * 60 * 1000;
export const LEAD_MS = 15 * 60 * 1000;
export const DEFAULT_SCHEDULE = { leadMinutes: 15, stepMinutes: 15 };

/* The rules in force, from what a host passed: whole minutes, at least 1, and a lead of at most a day. */
export function scheduleRules(opts = {}) {
  const whole = (v, d, max) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 1 ? Math.min(n, max) : d; };
  return { leadMinutes: whole(opts.leadMinutes, DEFAULT_SCHEDULE.leadMinutes, 1440), stepMinutes: whole(opts.stepMinutes, DEFAULT_SCHEDULE.stepMinutes, 60) };
}

/* `sendAt` is any moment; it is rounded UP to the next step and the exact time is handed back so the screen can say it. */
export function planSchedule(sendAt, confirm, now = Date.now(), rules = DEFAULT_SCHEDULE) {
  const { leadMinutes, stepMinutes } = scheduleRules(rules);
  if (confirm !== true) throw new HubError('Tick the box to say you have read the preview.');
  const when = Date.parse(sendAt);
  if (!Number.isFinite(when)) throw new HubError('Pick a day and time to send.');
  const step = stepMinutes * 60 * 1000;
  const at = Math.ceil(when / step) * step;
  if (at < now + leadMinutes * 60 * 1000) throw new HubError(`Choose a time at least ${leadMinutes} minutes from now.`);
  return { at, iso: new Date(at).toISOString().replace(/\.\d+Z$/, 'Z') };
}

export const isDraft = (c) => c.status === 'save' || c.status === 'paused';

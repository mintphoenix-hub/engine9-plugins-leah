/*
  The request flow, as pure steps the host runs around its own I/O. No I/O, no globals.

    1. settings   = resolveSettings(values)            values from engine9's `setting` table or the host's env
    2. used       = the host counts today's rows using usageCountSql(day)
    3. plan       = planRequest(input, { settings, guide, used, hasAi })
                    plan.ok false -> answer with plan.status and plan.error; log plan.outcome if set
    4. result     = the host calls ai.run(plan.model, { messages: plan.messages, ...plan.params })
    5. done       = finishRequest(result, plan)        result is { out } or { error }
                    answer with done.status and done.body
    6. the host writes one row with usageInsertSql({ ... , outcome: done.outcome })

  The host owns the AI binding, the database, who is allowed to ask, and the guide (who is writing
  and what their field forbids). The plugin owns the limits, the prompt, the checks and the schema.
*/
import { settings as SETTING_DEFS } from './settings.js';
import { buildMessages, tidy, readReply, flagWording, DEFAULT_FLAGS } from './prompt.js';
import { tableNames, utcDay, toSqlTime } from './helpers.js';

export const LIMITS = { instruction: 600 };

export const MESSAGES = {
  needText: 'Write or select some text first, then ask for help with it.',
  needBrief: 'Tell me what the piece should be about, or add a few notes.',
  tooLong: 'That is a lot of text at once. Select one section and ask again.',
  notOn: 'Writing help is not switched on yet. Ask whoever set up the site to finish the setup.',
  usedUp: 'The free writing help for today has been used up. It starts again tomorrow morning. Your writing is safe.',
  failed: 'The writing helper did not answer just now. Your writing is safe. Try again in a minute.',
  nothing: 'The writing helper did not come up with anything that time. Try saying it another way.'
};

/* Settings from a plain object of name -> value, else the defaults in settings.js. Numbers are
   clamped to the declared min and max, so a bad value cannot switch a limit off. */
export function resolveSettings(values = {}) {
  const out = {};
  for (const def of SETTING_DEFS) {
    const raw = values?.[def.name];
    let v = raw === undefined || raw === null || raw === '' ? def.default : raw;
    if (def.type === 'int') {
      const n = Number(v);
      v = Math.round(Number.isFinite(n) ? n : def.default);
      if (def.min != null) v = Math.max(def.min, v);
      if (def.max != null) v = Math.min(def.max, v);
    } else v = String(v);
    out[def.name] = v;
  }
  return out;
}

const clean = (v, max) => String(v ?? '').replace(/\r\n?/g, '\n').slice(0, max);

/* Step 3. Checks the request and the day's usage, and builds what to send. */
export function planRequest(input = {}, { settings, guide = '', used = 0, hasAi = true } = {}) {
  const s = resolveSettings(settings);
  const mode = input.mode === 'draft' ? 'draft' : 'rewrite';
  const instruction = clean(input.instruction, LIMITS.instruction).trim();
  const rawText = String(input.text ?? '');
  const text = clean(rawText, s.max_input_chars);
  const stop = (status, error, outcome) => ({ ok: false, status, error, ...(outcome ? { outcome, mode, model: s.model, inputChars: text.length } : {}) });

  if (mode === 'rewrite' && !text.trim()) return stop(400, MESSAGES.needText);
  if (mode === 'draft' && !text.trim() && !instruction) return stop(400, MESSAGES.needBrief);
  if (rawText.length > s.max_input_chars) return stop(413, MESSAGES.tooLong);
  if (!hasAi) return stop(503, MESSAGES.notOn);
  if (Number(used) >= s.daily_limit) return stop(429, MESSAGES.usedUp, 'limit');

  return {
    ok: true, mode, model: s.model, inputChars: text.length,
    messages: buildMessages({ mode, instruction, text, hasSelection: Boolean(input.hasSelection), guide }),
    params: { max_tokens: 1400, temperature: 0.6 },
    flags: DEFAULT_FLAGS
  };
}

const ALLOWANCE = /allocation|neurons|4006|quota|rate.?limit|too many/i;

/* Step 5. Turns what the provider returned (or the error it threw) into an answer. */
export function finishRequest(result = {}, plan = {}) {
  if (result.error !== undefined && result.error !== null) {
    const msg = String(result.error?.message || result.error);
    if (ALLOWANCE.test(msg)) return { status: 429, body: { error: MESSAGES.usedUp }, outcome: 'limit', outputChars: 0, detail: msg.slice(0, 300) };
    return { status: 502, body: { error: MESSAGES.failed }, outcome: 'error', outputChars: 0, detail: msg.slice(0, 300) };
  }
  const suggestion = tidy(readReply(result.out));
  if (!suggestion) return { status: 502, body: { error: MESSAGES.nothing }, outcome: 'empty', outputChars: 0 };
  return { status: 200, body: { ok: true, suggestion, flags: flagWording(suggestion, plan.flags || DEFAULT_FLAGS) }, outcome: 'ok', outputChars: suggestion.length };
}

/* ---- usage rows (SQL builders; the host runs them) ---------------------------------------- */

/* How many requests today count against the daily limit: those that got an answer. */
export function usageCountSql(day = utcDay(), prefix = '') {
  return { sql: `SELECT COUNT(*) AS n FROM ${tableNames(prefix).use} WHERE day = ? AND outcome IN ('ok','empty')`, values: [day] };
}

export function usageInsertSql({ day, mode, model, inputChars = 0, outputChars = 0, outcome, at = Date.now() } = {}, prefix = '') {
  return {
    sql: `INSERT INTO ${tableNames(prefix).use} (day, mode, model, input_chars, output_chars, outcome, created_at) VALUES (?,?,?,?,?,?,?)`,
    values: [day || utcDay(at), mode || null, model || null, Number(inputChars) || 0, Number(outputChars) || 0, outcome, toSqlTime(at)]
  };
}

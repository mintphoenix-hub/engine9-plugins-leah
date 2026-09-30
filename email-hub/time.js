/* Wall-clock times in a named time zone, without a library. The scheduling box asks for "10:00 on Saturday" in the
   site's own zone; the service wants a moment in UTC. Works in the browser, a Worker and Node. */

function offsetAt(utcMs, tz) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(utcMs));
  const g = (k) => Number(p.find((x) => x.type === k).value);
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - Math.floor(utcMs / 1000) * 1000;
}

/* 'YYYY-MM-DDTHH:mm' as read on a clock in `tz`, as UTC milliseconds. NaN if it is not a time. */
export function wallToUtc(value, tz = 'UTC') {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(value || ''));
  if (!m) return NaN;
  const [Y, M, D, h, mi] = m.slice(1).map(Number);
  const wall = Date.UTC(Y, M - 1, D, h, mi);
  let utc = wall;
  for (let i = 0; i < 3; i++) utc = wall - offsetAt(utc, tz);      // settles in one or two passes, DST included
  return utc;
}

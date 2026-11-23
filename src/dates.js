// All dates are plain 'YYYY-MM-DD' strings, so they compare and sort as text.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const cap = (s) => s[0].toUpperCase() + s.slice(1);

export const todayIso = (now, tz) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

export const timeHm = (now, tz) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(now);

export function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Inclusive day count: 25th to 27th = 3. */
export const dayCount = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 864e5) + 1;

function make(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

// No year given: use this year, unless that is long past (then it means next year).
function inferYear(m, d, today) {
  const y = Number(today.slice(0, 4));
  const iso = make(y, m, d);
  return iso && iso < addDays(today, -120) ? make(y + 1, m, d) : iso;
}

const fullYear = (y) => (y.length === 2 ? 2000 + Number(y) : Number(y));

/** Reads a date at the start of `str`. Returns { iso, rest } or null. */
export function takeDate(str, today) {
  const s = str.trimStart();
  let m;
  const done = (iso) => (iso ? { iso, rest: s.slice(m[0].length).trimStart() } : null);

  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})\b/))) return done(make(+m[1], +m[2], +m[3]));
  if ((m = s.match(/^(today|tod)\b/i))) return done(today);
  if ((m = s.match(/^(tomorrow|tmrw|tmr|tom)\b/i))) return done(addDays(today, 1));
  if ((m = s.match(/^(yesterday)\b/i))) return done(addDays(today, -1));
  if ((m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})(?:[\/.\-](\d{4}|\d{2}))?(?![\d\/.])/)))
    return done(m[3] ? make(fullYear(m[3]), +m[2], +m[1]) : inferYear(+m[2], +m[1], today));
  if ((m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:,?\s+(\d{4}))?\b/i))) {
    const mon = MONTHS.indexOf(m[2].toLowerCase()) + 1;
    return done(m[3] ? make(+m[3], mon, +m[1]) : inferYear(mon, +m[1], today));
  }
  return null;
}

/** Reads "<date>" or "<date> to <date>". Returns { from, to, rest, single }, { error } or null. */
export function takeRange(str, today) {
  const a = takeDate(str, today);
  if (!a) return null;
  const sep = a.rest.match(/^(?:to|till|until|upto|-|–|—)\s*/i);
  const b = sep && takeDate(a.rest.slice(sep[0].length), today);
  if (!b) return { from: a.iso, to: a.iso, rest: a.rest, single: true };
  if (b.iso < a.iso) return { error: 'The end date is before the start date.' };
  return { from: a.iso, to: b.iso, rest: b.rest, single: false };
}

/** Finds the first date anywhere in `str`. Returns { before, tail } or null. */
export function findDate(str, today) {
  const re = /(^|\s)(?=\S)/g;
  let m;
  while ((m = re.exec(str))) {
    const i = m.index + m[1].length;
    if (takeDate(str.slice(i), today)) return { before: str.slice(0, i).trim(), tail: str.slice(i) };
    if (re.lastIndex === m.index) re.lastIndex++;
  }
  return null;
}

/** '2026-11-25' -> 'Wed 25 Nov' (year added when it is not the current one). */
export function fmt(iso, today) {
  const d = new Date(iso + 'T00:00:00Z');
  const base = `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${cap(MONTHS[d.getUTCMonth()])}`;
  return today && iso.slice(0, 4) === today.slice(0, 4) ? base : `${base} ${iso.slice(0, 4)}`;
}

export function fmtRange(from, to, today) {
  if (!to) return `${fmt(from, today)} onwards`;
  return from === to ? fmt(from, today) : `${fmt(from, today)} → ${fmt(to, today)}`;
}

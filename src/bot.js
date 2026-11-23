// The whole brain of the bot. It knows nothing about WhatsApp: it takes an incoming
// message and returns the list of messages to send, so it can be tested and simulated.
import { todayIso, timeHm, addDays, dayCount, takeDate, takeRange, findDate, fmt, fmtRange } from './dates.js';

const FOREVER = '9999-12-31';
const LEVEL = /^(jr\s?[1-3]|sr|pg\s?[1-3]|faculty|fellow|intern)$/i;
const MAX_LEAVE_DAYS = 90;
const BACKDATE_DAYS = 7;

const dr = (u) => `Dr ${u.name}`;
const overlaps = (aFrom, aTo, bFrom, bTo) => aFrom <= (bTo ?? FOREVER) && bFrom <= (aTo ?? FOREVER);
const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const csv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';

export function createBot({ store, config }) {
  const db = store.db;
  const types = config.leaveTypes;
  const typeKeys = Object.keys(types);

  // ---------- lookups ----------
  const active = () => db.users.filter((u) => u.active);
  const admins = () => active().filter((u) => u.role === 'admin');
  const byId = (id) => db.users.find((u) => u.id === id);
  const live = (l) => l.status === 'pending' || l.status === 'approved';
  const leavesOn = (date, status = 'approved') =>
    db.leaves.filter((l) => l.status === status && l.from <= date && date <= l.to && byId(l.userId)?.active);
  const postingOn = (userId, date) =>
    db.postings.find((p) => p.userId === userId && p.from <= date && date <= (p.to ?? FOREVER));
  const usedDays = (userId, type, year) =>
    db.leaves
      .filter((l) => l.userId === userId && l.type === type && l.status === 'approved' && l.from.startsWith(year))
      .reduce((n, l) => n + dayCount(l.from, l.to), 0);

  /** Finds a resident named at the start of `str`; returns { user, rest } or { error }. */
  function matchUser(str) {
    const clean = str.trim().replace(/^dr\.?\s+/i, '');
    const s = clean.toLowerCase();
    if (!s) return { error: 'Which resident? Add a name.' };
    const full = active()
      .filter((u) => s === u.name.toLowerCase() || s.startsWith(u.name.toLowerCase() + ' '))
      .sort((a, b) => b.name.length - a.name.length)[0];
    if (full) return { user: full, rest: clean.slice(full.name.length).trim() };
    const word = s.split(/\s+/)[0];
    const hits = active().filter((u) => u.name.toLowerCase().split(/\s+/).some((part) => part.startsWith(word)));
    if (hits.length === 1) return { user: hits[0], rest: clean.slice(word.length).trim() };
    return {
      error: hits.length
        ? `"${word}" matches ${hits.map((u) => u.name).join(', ')}. Please use the full name.`
        : `No resident named "${word}". Send *residents* to see the list.`,
    };
  }

  /** Removes [from, to] from a resident's postings, trimming or splitting whatever it cuts through. */
  function carve(userId, from, to) {
    const end = to ?? FOREVER;
    const next = [];
    for (const p of db.postings) {
      const pEnd = p.to ?? FOREVER;
      if (p.userId !== userId || pEnd < from || p.from > end) {
        next.push(p);
        continue;
      }
      const keepHead = p.from < from;
      if (keepHead) next.push({ ...p, to: addDays(from, -1) });
      if (pEnd > end) next.push({ ...p, id: keepHead ? ++db.seq : p.id, from: addDays(end, 1) });
    }
    db.postings = next;
  }

  // ---------- text builders ----------
  function leaveLine(l, today, { withName = true, withReason = true } = {}) {
    const n = dayCount(l.from, l.to);
    const who = withName ? `${dr(byId(l.userId))} — ` : '';
    const why = withReason && l.reason ? ` — ${l.reason}` : '';
    return `#${l.id} ${who}${fmtRange(l.from, l.to, today)} (${n} day${n > 1 ? 's' : ''}, ${l.type})${why}`;
  }

  /** What an approver needs to see before deciding: who else is away, and what cover is left. */
  function context(l, today) {
    const lines = [];
    const user = byId(l.userId);
    const others = db.leaves.filter(
      (o) => o.id !== l.id && o.userId !== l.userId && live(o) && overlaps(l.from, l.to, o.from, o.to) && byId(o.userId)?.active,
    );
    if (others.length)
      lines.push(
        '⚠️ Also away then: ' +
          others.map((o) => `${dr(byId(o.userId))} (${fmtRange(o.from, o.to, today)}${o.status === 'pending' ? ', pending' : ''})`).join('; '),
      );
    const post = postingOn(user.id, l.from);
    if (post) {
      const mates = active().filter((u) => u.id !== user.id && postingOn(u.id, l.from)?.unit.toLowerCase() === post.unit.toLowerCase());
      lines.push(`Posting: ${post.unit} — ${mates.length ? 'also there: ' + mates.map(dr).join(', ') : '⚠️ nobody else posted there'}`);
    }
    for (const k of typeKeys) {
      if (k !== l.type || config.leaveLimits[k] == null) continue;
      const used = usedDays(user.id, k, l.from.slice(0, 4));
      lines.push(`${k} used this year: ${used} of ${config.leaveLimits[k]}`);
    }
    return lines.join('\n');
  }

  function rosterText(date, today) {
    const away = new Set(leavesOn(date).map((l) => l.userId));
    const units = new Map();
    const free = [];
    for (const u of active()) {
      const p = postingOn(u.id, date);
      const label = dr(u) + (away.has(u.id) ? ' _(leave)_' : '');
      if (!p) {
        if (u.role !== 'admin' || u.level) free.push(label);
        continue;
      }
      const key = [...units.keys()].find((k) => k.toLowerCase() === p.unit.toLowerCase()) ?? p.unit;
      units.set(key, [...(units.get(key) ?? []), label]);
    }
    const lines = [...units.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([unit, names]) => `*${unit}:* ${names.join(', ')}`);
    if (free.length) lines.push(`*Not posted:* ${free.join(', ')}`);
    return `📋 *Postings — ${fmt(date, today)}*\n` + (lines.length ? lines.join('\n') : 'No postings entered yet.');
  }

  function onLeaveText(date, today) {
    const list = leavesOn(date);
    if (!list.length) return `🏖️ *On leave — ${fmt(date, today)}*\nNobody.`;
    return (
      `🏖️ *On leave — ${fmt(date, today)}*\n` +
      list.map((l) => `• ${dr(byId(l.userId))} (${l.type}) — back ${fmt(addDays(l.to, 1), today)}`).join('\n')
    );
  }

  function helpText(user) {
    const t = typeKeys.join(' / ');
    let s =
      `*${config.department} — leave & postings bot*\n\n` +
      `*Leave*\n` +
      `• *leave 25/11 to 27/11 ${typeKeys[0]} family function* — apply (type: ${t})\n` +
      `• *leave tomorrow ${typeKeys[1] ?? typeKeys[0]} fever* — single day\n` +
      `• *my leaves* — your requests and balance\n` +
      `• *cancel 12* — cancel request #12\n` +
      `• *on leave* / *on leave 2/12* — who is away\n\n` +
      `*Postings*\n` +
      `• *my posting* — where you are posted\n` +
      `• *roster* / *roster 2/12* — everyone's posting`;
    if (user.role === 'admin')
      s +=
        `\n\n*Admin*\n` +
        `• *pending* — requests waiting\n` +
        `• *approve 12* / *reject 12 reason*\n` +
        `• *post Ravi OPD 1/12 to 31/12* — set a posting (several lines at once is fine)\n` +
        `• *unpost Ravi 1/12 to 31/12* — clear a posting\n` +
        `• *residents* · *remove Ravi* · *makeadmin Ravi*\n` +
        `• *summary* — leave taken this year\n` +
        `• *export* — leaves and postings as spreadsheet files\n` +
        `• *!setgroup* (sent inside the department group) — post announcements there`;
    return s + `\n\nIn the group, start commands with *!* (for example *!roster*).`;
  }

  // ---------- incoming message ----------
  /**
   * @param {{ ids: string[], chatId: string, isGroup: boolean, text: string, now?: Date }} msg
   * @returns {{ chat: string, text?: string, file?: { name: string, content: string } }[]}
   */
  function handle({ ids, chatId, isGroup, text, now = new Date() }) {
    const outs = [];
    const say = (chat, body) => chat && outs.push({ chat, text: body });
    const reply = (body) => say(chatId, body);
    const tell = (user, body) => say(user.dm, body);
    const tellAdmins = (body, except) => admins().forEach((a) => a.id !== except?.id && tell(a, body));
    const announce = (body) => say(db.groupId, body);

    let body = (text ?? '').trim();
    if (isGroup && !body.startsWith('!')) return outs; // ordinary group chatter is ignored
    body = body.replace(/^[!/]\s*/, '');
    if (!body) return outs;

    const today = todayIso(now, config.timezone);
    let user = db.users.find((u) => u.ids.some((id) => ids.includes(id)));
    if (user) {
      user.ids = [...new Set([...user.ids, ...ids])]; // WhatsApp may show the same person under two ids
      if (!isGroup) user.dm = chatId;
    }

    const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
    const batch = lines.length > 1 && lines.every((l) => /^(un)?post\s/i.test(l));
    for (const line of batch ? lines : [body]) command(line);
    store.save();
    return outs;

    function command(line) {
      const [, word, args = ''] = line.match(/^(\S+)\s*([\s\S]*)$/);
      const cmd = word.toLowerCase();
      const two = (cmd + ' ' + args.split(/\s+/)[0]).toLowerCase();

      if (cmd === 'join' || cmd === 'admin') return register(cmd, args);
      if (!user?.active) return; // strangers get no reply at all

      if (two === 'my leaves' || two === 'my leave' || ['myleaves', 'leaves', 'status', 'balance'].includes(cmd)) return myLeaves();
      if (two === 'my posting' || two === 'my postings' || ['myposting', 'posting'].includes(cmd)) return myPosting();
      if (two === 'on leave') return dated(args.replace(/^\S+\s*/, ''), onLeaveText);
      if (['onleave', 'who', 'away'].includes(cmd)) return dated(args, onLeaveText);
      if (['roster', 'postings', 'duty'].includes(cmd)) return dated(args, rosterText);
      if (['leave', 'apply'].includes(cmd)) return applyLeave(args);
      if (cmd === 'cancel') return cancel(args);
      if (['help', 'menu', 'hi', 'hello', 'start', '?'].includes(cmd)) return reply(helpText(user));

      if (user.role === 'admin') {
        if (cmd === 'pending') return pending();
        if (['approve', 'ok', 'yes', 'approved'].includes(cmd)) return decide(args, true);
        if (['reject', 'no', 'deny', 'rejected'].includes(cmd)) return decide(args, false);
        if (cmd === 'post') return post(args);
        if (cmd === 'unpost') return unpost(args);
        if (['residents', 'list', 'members'].includes(cmd)) return residents();
        if (cmd === 'remove') return remove(args);
        if (cmd === 'makeadmin') return makeAdmin(args);
        if (cmd === 'summary') return summary();
        if (cmd === 'export') return exportFiles();
        if (cmd === 'setgroup') return setGroup();
      }
      reply(`Sorry, I didn't understand "${word}". Send *help* to see what I can do.`);
    }

    function register(cmd, args) {
      if (isGroup) return reply('Please message me privately to register.');
      const [code = '', ...rest] = args.split(/\s+/).filter(Boolean);
      const wanted = cmd === 'admin' ? config.adminCode : config.joinCode;
      if (code.toLowerCase() !== wanted.toLowerCase()) return reply('That code is not correct. Please check with the department.');
      let level = '';
      if (rest.length > 1 && LEVEL.test(rest.at(-1))) level = rest.pop().toUpperCase();
      const name = rest.join(' ').replace(/^dr\.?\s+/i, '').trim();
      if (!name) return reply(`Please add your name, e.g. *${cmd} ${code} Ravi Kumar JR2*`);
      const clash = active().find((u) => u.name.toLowerCase() === name.toLowerCase() && u !== user);
      if (clash) return reply(`There is already a "${name}" registered. Please add an initial or surname.`);

      if (!user) {
        user = { id: ++db.seq, name, level, role: 'resident', ids, dm: chatId, active: true };
        db.users.push(user);
      }
      Object.assign(user, { name, active: true, dm: chatId, level: level || user.level });
      if (cmd === 'admin') user.role = 'admin';
      reply(
        `Welcome, ${dr(user)}! You are registered as ${user.role === 'admin' ? 'an *admin*' : 'a resident'}` +
          `${user.level ? ` (${user.level})` : ''}.\n\n` + helpText(user),
      );
      if (cmd === 'join') tellAdmins(`👤 ${dr(user)}${user.level ? ` (${user.level})` : ''} has joined the bot.`, user);
    }

    function dated(args, build) {
      const d = args.trim() ? takeDate(args, today) : { iso: today };
      if (!d) return reply("I couldn't read that date. Try *25/11*, *25 Nov* or *tomorrow*.");
      reply(build(d.iso, today));
    }

    function applyLeave(args) {
      const r = takeRange(args, today);
      if (!r)
        return reply(
          `To apply, send dates then the reason:\n*leave 25/11 to 27/11 ${typeKeys[0]} family function*\n*leave tomorrow ${typeKeys[1] ?? typeKeys[0]} fever*`,
        );
      if (r.error) return reply(r.error);
      if (r.from < addDays(today, -BACKDATE_DAYS)) return reply(`${fmt(r.from, today)} is too far in the past. Please check the date.`);
      if (dayCount(r.from, r.to) > MAX_LEAVE_DAYS) return reply(`That is more than ${MAX_LEAVE_DAYS} days. Please check the dates.`);

      let type = typeKeys[0];
      let reason = r.rest;
      const first = reason.match(/^(\S+)\s*([\s\S]*)$/);
      const key = first && typeKeys.find((k) => [k, types[k]].some((v) => v.toLowerCase() === first[1].toLowerCase()));
      if (key) [type, reason] = [key, first[2]];
      reason = reason.replace(/^(for|due to|-|:)\s+/i, '').trim();

      const clash = db.leaves.find((l) => l.userId === user.id && live(l) && overlaps(r.from, r.to, l.from, l.to));
      if (clash) return reply(`You already have a ${clash.status} leave on those dates:\n${leaveLine(clash, today, { withName: false })}\nCancel it first with *cancel ${clash.id}*.`);

      const leave = { id: ++db.seq, userId: user.id, from: r.from, to: r.to, type, reason, status: 'pending', createdAt: now.toISOString() };
      db.leaves.push(leave);
      const approvers = admins().filter((a) => a.id !== user.id || admins().length === 1);
      reply(
        `📝 Leave request submitted:\n${leaveLine(leave, today, { withName: false })}\n` +
          (approvers.length ? "You'll get a message when it is decided." : '⚠️ No admin is registered yet, so nobody can approve it.'),
      );
      const extra = context(leave, today);
      approvers.forEach((a) =>
        tell(a, `📝 *Leave request*\n${leaveLine(leave, today)}${extra ? '\n' + extra : ''}\n\nReply *approve ${leave.id}* or *reject ${leave.id} reason*`),
      );
    }

    function cancel(args) {
      const id = Number(args.match(/\d+/)?.[0]);
      const mine = db.leaves.filter((l) => l.userId === user.id && live(l) && l.to >= today);
      const leave = id ? db.leaves.find((l) => l.id === id) : mine.length === 1 ? mine[0] : null;
      if (!leave) return reply(id ? `There is no leave #${id}.` : 'Which one? Send *cancel* with the request number, e.g. *cancel 12*. See *my leaves*.');
      if (leave.userId !== user.id && user.role !== 'admin') return reply(`Leave #${leave.id} is not yours.`);
      if (!live(leave)) return reply(`Leave #${leave.id} is already ${leave.status}.`);
      const wasApproved = leave.status === 'approved';
      Object.assign(leave, { status: 'cancelled', decidedBy: user.id, decidedAt: now.toISOString() });
      const owner = byId(leave.userId);
      reply(`Leave #${leave.id} cancelled.`);
      if (owner.id !== user.id) tell(owner, `Your leave was cancelled by ${dr(user)}:\n${leaveLine(leave, today, { withName: false })}`);
      tellAdmins(`↩️ Leave cancelled:\n${leaveLine(leave, today, { withReason: false })}`, user);
      if (wasApproved) announce(`↩️ ${dr(owner)}'s leave (${fmtRange(leave.from, leave.to, today)}) is cancelled.`);
    }

    function myLeaves() {
      const year = today.slice(0, 4);
      const mine = db.leaves.filter((l) => l.userId === user.id && (l.to >= today || l.from.startsWith(year))).sort((a, b) => a.from.localeCompare(b.from));
      const icon = { pending: '⏳', approved: '✅', rejected: '❌', cancelled: '↩️' };
      const lines = mine.map((l) => `${icon[l.status]} ${leaveLine(l, today, { withName: false, withReason: false })} — ${l.status}`);
      const totals = typeKeys
        .map((k) => [k, usedDays(user.id, k, year)])
        .filter(([k, n]) => n || config.leaveLimits[k] != null)
        .map(([k, n]) => (config.leaveLimits[k] != null ? `${k} ${n}/${config.leaveLimits[k]}` : `${k} ${n}`));
      reply(`*Your leaves (${year})*\n` + (lines.length ? lines.join('\n') : 'None yet.') + (totals.length ? `\n\nDays taken: ${totals.join(' · ')}` : ''));
    }

    function myPosting() {
      const mine = db.postings.filter((p) => p.userId === user.id && (p.to ?? FOREVER) >= today).sort((a, b) => a.from.localeCompare(b.from));
      if (!mine.length) return reply('No posting has been entered for you yet.');
      reply('*Your postings*\n' + mine.map((p) => `${p.from <= today ? '▶️' : '•'} ${p.unit} — ${fmtRange(p.from, p.to, today)}`).join('\n'));
    }

    function pending() {
      const list = db.leaves.filter((l) => l.status === 'pending');
      if (!list.length) return reply('No pending requests. 🎉');
      reply(`*Pending requests (${list.length})*\n` + list.map((l) => leaveLine(l, today)).join('\n') + '\n\nReply *approve <no>* or *reject <no> reason*');
    }

    function decide(args, approve) {
      const waiting = db.leaves.filter((l) => l.status === 'pending');
      const m = args.match(/^#?(\d+)\s*([\s\S]*)$/);
      const leave = m ? db.leaves.find((l) => l.id === Number(m[1])) : waiting.length === 1 ? waiting[0] : null;
      if (!leave) return reply(m ? `There is no leave #${m[1]}.` : 'Which request? e.g. *approve 12*. Send *pending* to see them.');
      if (leave.status !== 'pending') return reply(`Leave #${leave.id} is already ${leave.status}.`);
      const owner = byId(leave.userId);
      if (owner.id === user.id && admins().length > 1) return reply('Another admin needs to decide your own request.');
      const note = (m ? m[2] : args).trim();
      Object.assign(leave, { status: approve ? 'approved' : 'rejected', decidedBy: user.id, decidedAt: now.toISOString(), note });
      const line = leaveLine(leave, today, { withName: false, withReason: false });
      reply(`${approve ? '✅ Approved' : '❌ Rejected'}: ${leaveLine(leave, today, { withReason: false })}`);
      if (owner.id !== user.id) tell(owner, `${approve ? '✅ Your leave is *approved*' : '❌ Your leave is *not approved*'} by ${dr(user)}:\n${line}${note ? `\nNote: ${note}` : ''}`);
      tellAdmins(`${approve ? '✅' : '❌'} ${dr(user)} ${leave.status} ${leaveLine(leave, today, { withReason: false })}`, user);
      // The group sees dates only, never the reason.
      if (approve) announce(`🏖️ ${dr(owner)} will be on leave ${fmtRange(leave.from, leave.to, today)}.`);
    }

    function post(args) {
      const who = matchUser(args);
      if (who.error) return reply(who.error);
      const found = findDate(who.rest, today);
      const range = found && takeRange(found.tail, today);
      const unit = found?.before.replace(/\s*\bfrom$/i, '').trim();
      if (!range || !unit) return reply('Use: *post Ravi OPD 1/12 to 31/12*\n(leave out the end date for an open-ended posting)');
      if (range.error) return reply(range.error);
      const to = range.single ? null : range.to;
      carve(who.user.id, range.from, to);
      db.postings.push({ id: ++db.seq, userId: who.user.id, unit, from: range.from, to });
      reply(`📌 ${dr(who.user)} → *${unit}*, ${fmtRange(range.from, to, today)}`);
      if (who.user.id !== user.id) tell(who.user, `📌 Your posting: *${unit}*, ${fmtRange(range.from, to, today)}`);
    }

    function unpost(args) {
      const who = matchUser(args);
      if (who.error) return reply(who.error);
      const range = takeRange(who.rest, today);
      if (!range || range.error) return reply(range?.error ?? 'Use: *unpost Ravi 1/12 to 31/12*');
      const to = range.single ? null : range.to;
      carve(who.user.id, range.from, to);
      reply(`Cleared ${dr(who.user)}'s postings for ${fmtRange(range.from, to, today)}.`);
    }

    function residents() {
      const list = active().sort((a, b) => a.name.localeCompare(b.name));
      reply(
        `*Registered (${list.length})*\n` +
          list.map((u) => `• ${dr(u)}${u.level ? ` (${u.level})` : ''}${u.role === 'admin' ? ' — admin' : ''}`).join('\n') +
          `\n\nJoin code for new residents: *${config.joinCode}*`,
      );
    }

    function remove(args) {
      const who = matchUser(args);
      if (who.error) return reply(who.error);
      if (who.user.id === user.id) return reply("You can't remove yourself.");
      who.user.active = false;
      db.leaves.filter((l) => l.userId === who.user.id && l.status === 'pending').forEach((l) => (l.status = 'cancelled'));
      carve(who.user.id, today, null);
      reply(`${dr(who.user)} has been removed. Past records are kept.`);
    }

    function makeAdmin(args) {
      const who = matchUser(args);
      if (who.error) return reply(who.error);
      who.user.role = 'admin';
      reply(`${dr(who.user)} is now an admin.`);
      tell(who.user, `You are now an admin of the ${config.department} bot. Send *help* to see admin commands.`);
    }

    function summary() {
      const year = today.slice(0, 4);
      const rows = active()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((u) => {
          const parts = typeKeys.map((k) => [k, usedDays(u.id, k, year)]).filter(([, n]) => n);
          const total = parts.reduce((n, [, d]) => n + d, 0);
          return `• ${dr(u)}: ${total ? `*${total}* (${parts.map(([k, n]) => `${k} ${n}`).join(', ')})` : '0'}`;
        });
      reply(`*Approved leave days in ${year}*\n` + (rows.join('\n') || 'Nobody registered yet.'));
    }

    function exportFiles() {
      const name = (id) => byId(id)?.name ?? '';
      outs.push({
        chat: chatId,
        file: {
          name: `leaves-${today}.csv`,
          content: csv([
            ['No', 'Resident', 'Level', 'From', 'To', 'Days', 'Type', 'Reason', 'Status', 'Decided by', 'Note', 'Applied on'],
            ...db.leaves.map((l) => [l.id, name(l.userId), byId(l.userId)?.level, l.from, l.to, dayCount(l.from, l.to), l.type, l.reason, l.status, name(l.decidedBy), l.note, l.createdAt.slice(0, 10)]),
          ]),
        },
      });
      outs.push({
        chat: chatId,
        file: {
          name: `postings-${today}.csv`,
          content: csv([
            ['Resident', 'Level', 'Unit', 'From', 'To'],
            ...[...db.postings].sort((a, b) => a.from.localeCompare(b.from)).map((p) => [name(p.userId), byId(p.userId)?.level, p.unit, p.from, p.to ?? '']),
          ]),
        },
      });
    }

    function setGroup() {
      if (!isGroup) return reply('Send *!setgroup* inside the department group.');
      db.groupId = chatId;
      reply(`Done. Approved leaves and the ${config.summaryTime} daily summary will be posted in this group.`);
    }
  }

  // ---------- once-a-day summary ----------
  /** Call every minute. Returns the morning messages the first time it is called after summaryTime each day. */
  function daily(now = new Date()) {
    const today = todayIso(now, config.timezone);
    if (db.lastSummary === today || timeHm(now, config.timezone) < config.summaryTime) return [];
    db.lastSummary = today;
    const outs = [];
    const tomorrow = addDays(today, 1);

    if (active().length) {
      const starting = db.leaves.filter((l) => l.status === 'approved' && l.from === tomorrow && byId(l.userId)?.active);
      let text = `☀️ *${config.department} — ${fmt(today, today)}*\n\n${onLeaveText(today, today)}`;
      if (starting.length) text += `\n_From tomorrow:_ ${starting.map((l) => dr(byId(l.userId))).join(', ')}`;
      text += `\n\n${rosterText(today, today)}`;
      const target = db.groupId ? [db.groupId] : admins().map((a) => a.dm);
      target.filter(Boolean).forEach((chat) => outs.push({ chat, text }));
    }

    const waiting = db.leaves.filter((l) => l.status === 'pending').length;
    if (waiting) admins().forEach((a) => a.dm && outs.push({ chat: a.dm, text: `⏳ ${waiting} leave request${waiting > 1 ? 's' : ''} waiting. Send *pending* to review.` }));

    for (const u of active()) {
      const next = db.postings.find((p) => p.userId === u.id && p.from === tomorrow);
      if (next && u.dm && postingOn(u.id, today)?.unit !== next.unit) outs.push({ chat: u.dm, text: `📌 Reminder: from tomorrow you are posted in *${next.unit}*.` });
    }
    store.save();
    return outs;
  }

  return { handle, daily };
}

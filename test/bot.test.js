import test from 'node:test';
import assert from 'node:assert/strict';
import { createBot } from '../src/bot.js';
import { memoryStore, DEFAULT_CONFIG } from '../src/store.js';
import { takeDate, takeRange, dayCount } from '../src/dates.js';

const NOW = new Date('2026-11-23T06:00:00Z'); // 11:30 IST, Monday
const config = { ...DEFAULT_CONFIG, joinCode: 'DERM1', adminCode: 'HOD1', leaveLimits: { CL: 12 } };

function setup() {
  const store = memoryStore();
  const bot = createBot({ store, config });
  const dm = (who, text, now = NOW) => bot.handle({ ids: [who], chatId: who, isGroup: false, text, now });
  const group = (who, text) => bot.handle({ ids: [who], chatId: 'G', isGroup: true, text, now: NOW });
  dm('hod', 'admin HOD1 Dr Sharma');
  dm('ravi', 'join DERM1 Ravi Kumar JR2');
  dm('sita', 'join derm1 Sita JR1');
  return { store, bot, dm, group, db: store.db };
}
const to = (outs, chat) => outs.filter((o) => o.chat === chat).map((o) => o.text).join('\n');

test('dates', () => {
  const t = '2026-11-23';
  assert.equal(takeDate('25/11 x', t).iso, '2026-11-25');
  assert.equal(takeDate('5/1', t).iso, '2027-01-05');
  assert.equal(takeDate('1st Dec', t).iso, '2026-12-01');
  assert.equal(takeDate('2 dec 2027', t).iso, '2027-12-02');
  assert.equal(takeDate('31/02', t), null);
  assert.equal(takeDate('tomorrow', t).iso, '2026-11-24');
  assert.deepEqual(takeRange('25/11-27/11 CL trip', t), { from: '2026-11-25', to: '2026-11-27', rest: 'CL trip', single: false });
  assert.equal(takeRange('25/11 to attend wedding', t).rest, 'to attend wedding');
  assert.ok(takeRange('27/11 to 25/11', t).error);
  assert.equal(dayCount('2026-11-25', '2026-11-27'), 3);
});

test('registration: codes, names, strangers', () => {
  const { dm, db } = setup();
  assert.equal(db.users.length, 3);
  assert.deepEqual(db.users.map((u) => [u.name, u.level, u.role]), [['Sharma', '', 'admin'], ['Ravi Kumar', 'JR2', 'resident'], ['Sita', 'JR1', 'resident']]);
  assert.match(to(dm('x', 'join WRONG Bob'), 'x'), /not correct/);
  assert.deepEqual(dm('x', 'hello there'), []); // strangers are ignored
  assert.match(to(dm('y', 'join DERM1 sita'), 'y'), /already/);
});

test('leave: apply → approve → announce, with privacy in the group', () => {
  const { dm, group, db } = setup();
  group('hod', '!setgroup');
  const a = dm('ravi', 'leave 25/11 to 27/11 CL sister wedding');
  assert.match(to(a, 'ravi'), /submitted/);
  assert.match(to(a, 'hod'), /Dr Ravi Kumar.*3 days, CL.*sister wedding/s);
  assert.match(to(a, 'hod'), /CL used this year: 0 of 12/);
  const id = db.leaves[0].id;

  assert.match(to(dm('ravi', 'leave 26/11 SL fever'), 'ravi'), /already have a pending leave/);
  assert.match(to(dm('ravi', `approve ${id}`), 'ravi'), /didn't understand/); // residents can't approve

  const b = dm('hod', `approve ${id}`);
  assert.equal(db.leaves[0].status, 'approved');
  assert.match(to(b, 'ravi'), /approved/);
  assert.match(to(b, 'G'), /Dr Ravi Kumar will be on leave/);
  assert.doesNotMatch(to(b, 'G'), /wedding/);
  assert.match(to(dm('ravi', 'my leaves'), 'ravi'), /CL 3\/12/);
  assert.match(to(dm('sita', 'on leave 26/11'), 'sita'), /Dr Ravi Kumar/);
  assert.match(to(dm('sita', 'on leave'), 'sita'), /Nobody/);

  const c = dm('ravi', `cancel ${id}`);
  assert.equal(db.leaves[0].status, 'cancelled');
  assert.match(to(c, 'G'), /cancelled/);
  assert.match(to(c, 'hod'), /cancelled/);
});

test('leave: reject with note, type by full word, default type, overlap warning', () => {
  const { dm, db } = setup();
  dm('ravi', 'leave tomorrow sick fever');
  assert.deepEqual([db.leaves[0].type, db.leaves[0].reason, db.leaves[0].from], ['SL', 'fever', '2026-11-24']);
  const a = dm('sita', 'leave 24/11 to attend conference');
  assert.deepEqual([db.leaves[1].type, db.leaves[1].reason], ['CL', 'to attend conference']);
  assert.match(to(a, 'hod'), /Also away then: Dr Ravi Kumar/);
  const b = dm('hod', `reject ${db.leaves[1].id} too many away`);
  assert.match(to(b, 'sita'), /not approved.*too many away/s);
  assert.match(to(dm('hod', 'approve'), 'hod'), /Approved.*Ravi/); // only one pending → no number needed
  assert.match(to(dm('ravi', 'leave 1/1/2020 CL x'), 'ravi'), /too far in the past/);
});

test('postings: set, override, split, roster, bulk', () => {
  const { dm, group, db } = setup();
  const a = dm('hod', 'post ravi OPD 1/11 to 30/11');
  assert.match(to(a, 'ravi'), /OPD/);
  dm('hod', 'post Sita Leprosy clinic from 1/11');
  assert.equal(db.postings[1].to, null);
  assert.match(to(group('sita', '!roster'), 'G'), /\*Leprosy clinic:\* Dr Sita\n\*OPD:\* Dr Ravi Kumar/);
  assert.deepEqual(group('sita', 'roster please'), []); // no "!" → ignored in group

  dm('hod', 'post ravi Ward 10/11 to 15/11'); // splits the OPD posting
  const ravi = db.postings.filter((p) => p.userId === 2).sort((x, y) => x.from.localeCompare(y.from));
  assert.deepEqual(ravi.map((p) => [p.unit, p.from, p.to]), [
    ['OPD', '2026-11-01', '2026-11-09'],
    ['Ward', '2026-11-10', '2026-11-15'],
    ['OPD', '2026-11-16', '2026-11-30'],
  ]);
  assert.equal(new Set(db.postings.map((p) => p.id)).size, db.postings.length);

  const bulk = dm('hod', 'post ravi Procedure room 1/12 to 31/12\npost sita OPD 1/12 to 31/12');
  assert.equal(bulk.filter((o) => o.chat === 'hod').length, 2);
  assert.match(to(dm('sita', 'my posting'), 'sita'), /Leprosy clinic.*30 Nov\n• OPD/s);
  assert.match(to(dm('hod', 'post nobody OPD 1/12'), 'hod'), /No resident named/);
  dm('hod', 'unpost sita 1/12 to 31/12');
  assert.doesNotMatch(to(dm('sita', 'roster 5/12'), 'sita'), /OPD:\* Dr Sita/);
});

test('approver sees cover in the same unit', () => {
  const { dm } = setup();
  dm('hod', 'post ravi OPD 1/11 to 30/11');
  assert.match(to(dm('ravi', 'leave 25/11 CL x'), 'hod'), /nobody else posted there/);
  dm('hod', 'post sita opd 1/11 to 30/11');
  assert.match(to(dm('ravi', 'leave 28/11 CL x'), 'hod'), /also there: Dr Sita/);
});

test('daily summary goes out once, after the set time', () => {
  const { dm, group, bot } = setup();
  group('hod', '!setgroup');
  dm('hod', 'post ravi OPD 1/11 to 23/11\npost ravi Ward 24/11 to 30/11');
  dm('sita', 'leave today SL fever');
  assert.deepEqual(bot.daily(new Date('2026-11-23T01:00:00Z')), []); // 06:30 IST: too early
  const outs = bot.daily(new Date('2026-11-23T02:30:00Z'));
  assert.match(to(outs, 'G'), /On leave[^]*Nobody[^]*\*OPD:\* Dr Ravi Kumar/);
  assert.match(to(outs, 'hod'), /1 leave request waiting/);
  assert.match(to(outs, 'ravi'), /from tomorrow you are posted in \*Ward\*/);
  assert.deepEqual(bot.daily(new Date('2026-11-23T05:00:00Z')), []);
});

test('admin tools: residents, remove, summary, export', () => {
  const { dm, db } = setup();
  dm('ravi', 'leave 25/11 to 26/11 CL x');
  dm('hod', 'approve');
  assert.match(to(dm('hod', 'summary'), 'hod'), /Dr Ravi Kumar: \*2\* \(CL 2\)/);
  const files = dm('hod', 'export').map((o) => o.file);
  assert.match(files[0].content, /"Ravi Kumar","JR2","2026-11-25","2026-11-26","2","CL","x","approved","Sharma"/);
  assert.match(to(dm('hod', 'residents'), 'hod'), /Registered \(3\)[^]*DERM1/);
  dm('hod', 'remove sita');
  assert.equal(db.users[2].active, false);
  assert.deepEqual(dm('sita', 'help'), []);
  assert.match(to(dm('sita', 'join DERM1 Sita JR1'), 'sita'), /Welcome/); // can re-join
});

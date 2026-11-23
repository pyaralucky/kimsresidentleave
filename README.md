# Resident leave & postings bot — Dept. of Dermatology

A WhatsApp bot that handles resident **leave requests** and **postings** by plain chat messages.

- **No WhatsApp Cloud API, no Meta business account, no fees.** The bot links to an ordinary
  WhatsApp number as a "Linked device", exactly like WhatsApp Web.
- **No database to install.** Everything is kept in one file, `data/db.json`.
- Residents apply by message, admins approve by message, the department group gets the
  announcement and a morning summary.

## What it looks like

```
Resident → bot     leave 25/11 to 27/11 CL sister's wedding
Bot → resident     📝 Leave request submitted: #12 Wed 25 Nov → Fri 27 Nov (3 days, CL)
Bot → admins       📝 Leave request #12 Dr Ravi — Wed 25 Nov → Fri 27 Nov (3 days, CL) — sister's wedding
                   ⚠️ Also away then: Dr Sita (Thu 26 Nov)
                   Posting: OPD — also there: Dr Anil
                   Reply approve 12 or reject 12 reason
Admin → bot        approve 12
Bot → resident     ✅ Your leave is approved by Dr Sharma
Bot → group        🏖️ Dr Ravi will be on leave Wed 25 Nov → Fri 27 Nov.
```

The group only ever sees names and dates — never the reason for leave.

## Setup (about 10 minutes)

You need:

1. **A spare SIM / WhatsApp number for the bot** (strongly recommended — see *Important* below).
2. **A computer that stays on** (a department PC, an old laptop, or a ₹400/month cloud server)
   with [Node.js 20 or newer](https://nodejs.org) installed.

Then, in a terminal inside this folder:

```bash
npm install
```

```bash
npm start
```

A QR code appears. On the bot's phone: **WhatsApp → Linked devices → Link a device** → scan it.
That's it — the terminal prints `✅ Connected to WhatsApp`. The link is remembered, so next time
`npm start` connects straight away.

The terminal also prints two codes (also saved in `data/config.json`):

| Who | What they send to the bot's number (private chat) |
| --- | --- |
| HOD / faculty / chief resident | `admin HOD123456 Dr Sharma` |
| Each resident | `join DERM1234 Ravi Kumar JR2` |

Finally, add the bot's number to the department WhatsApp group and have an admin send
`!setgroup` in that group. Approved leaves and the daily summary will be posted there.

> Can't scan a QR code? Put the bot's number (with country code, e.g. `919876543210`) in
> `pairingPhone` in `data/config.json` and restart — the terminal shows an 8-character code to
> type into *Link a device → Link with phone number instead*.

### Try it first without WhatsApp

```bash
npm run sim
```

Type `hod: admin <code> Sharma`, `ravi: join <code> Ravi JR2`, `ravi: leave tomorrow SL fever`,
`hod: approve`, `daily` … and see exactly what the bot would send.

## Commands

In a private chat with the bot just type the command. In the group, start with `!` (e.g. `!roster`).
Dates can be written `25/11`, `25/11/2026`, `25 Nov`, `today`, `tomorrow`.

**Everyone**

| Message | What it does |
| --- | --- |
| `leave 25/11 to 27/11 CL family function` | Apply for leave (type is optional; default CL) |
| `leave tomorrow SL fever` | Single day |
| `my leaves` | Your requests, their status, days taken this year |
| `cancel 12` | Cancel your request #12 (pending or approved) |
| `on leave` / `on leave 2/12` | Who is away today / on a date |
| `my posting` | Your current and upcoming postings |
| `roster` / `roster 2/12` | Everyone's posting, with people on leave marked |
| `help` | The command list |

**Admins**

| Message | What it does |
| --- | --- |
| `pending` | Requests waiting for a decision |
| `approve 12` / `reject 12 reason` | Decide a request (just `approve` works if only one is pending) |
| `post Ravi OPD 1/12 to 31/12` | Set a posting. It replaces whatever was there for those dates |
| `post Ravi Ward from 1/12` | Open-ended posting |
| several `post …` lines in one message | Enter the whole month's rotation at once |
| `unpost Ravi 1/12 to 31/12` | Clear a posting |
| `residents` · `remove Ravi` · `makeadmin Ravi` | Manage people |
| `summary` | Approved leave days per resident this year |
| `export` | Sends `leaves.csv` and `postings.csv` (open in Excel) |
| `!setgroup` (inside the group) | Use this group for announcements |

**Automatic, every morning (07:30 by default)**

- Group: who is on leave today, who starts leave tomorrow, today's roster.
- Admins: reminder if requests are still pending.
- Residents: reminder the day before their posting changes.

## Settings — `data/config.json`

| Setting | Meaning |
| --- | --- |
| `joinCode`, `adminCode` | Registration codes. Change them any time |
| `summaryTime` | Time of the morning message, 24-hour `HH:MM` |
| `timezone` | Default `Asia/Kolkata` |
| `leaveTypes` | e.g. `{ "CL": "Casual", "SL": "Sick", "AL": "Academic", "EL": "Earned" }` — first one is the default |
| `leaveLimits` | Optional yearly limits, e.g. `{ "CL": 20 }` — shown as "CL 3/20" to residents and approvers |
| `pairingPhone` | Bot's number, only if you want code pairing instead of QR |

Restart the bot after editing.

## Keeping it running

- Simplest: leave the terminal window open.
- Better: `npm install -g pm2`, then `pm2 start src/index.js --name derm-bot` and `pm2 save` —
  it restarts automatically after a crash or reboot.
- **Backup:** copy the `data` folder now and then. `data/db.json` is all your records;
  `data/auth` is the WhatsApp link (keep it private — anyone with it can use the bot's WhatsApp).

## Important

- **This is not an official WhatsApp integration.** It uses the open-source
  [Baileys](https://github.com/WhiskeySockets/Baileys) library, which behaves like WhatsApp Web.
  WhatsApp's terms do not permit unofficial automation, and numbers are occasionally banned.
  The risk is low for a small department bot that only replies to people who message it, but
  **use a spare number, not your personal one.** If the number is ever banned, link a new one —
  your records in `data/db.json` are unaffected (residents just send `join …` again).
- The bot's phone must come online at least once every ~14 days or WhatsApp unlinks the device.
- The bot never replies to unregistered people (unless they send a `join`/`admin` code) and
  ignores normal group conversation.
- Leave reasons can be sensitive. They are shown only to the applicant and admins, and are stored
  in `data/db.json` on the computer running the bot — keep that computer access-controlled.

## For developers

```
src/bot.js       all the logic; pure function: incoming message → messages to send
src/dates.js     date parsing/formatting
src/store.js     JSON file storage and config
src/whatsapp.js  Baileys connection (QR / pairing code, reconnect, send queue)
src/index.js     entry point and terminal simulator
test/            npm test
```

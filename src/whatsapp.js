// Connects to WhatsApp the same way WhatsApp Web does ("Linked devices"), so no
// Cloud API, no Meta business account and no fees. Uses the open-source Baileys library.
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  jidNormalizedUser,
  isJidGroup,
} from 'baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function textOf(message) {
  const m = message?.ephemeralMessage?.message ?? message?.viewOnceMessage?.message ?? message;
  return m?.conversation ?? m?.extendedTextMessage?.text ?? '';
}

export async function startWhatsApp({ bot, config, authDir }) {
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const version = await fetchLatestBaileysVersion().then((v) => v.version).catch(() => undefined);
  let sock;
  let queue = Promise.resolve();
  let retries = 0;

  // Messages go out one at a time with a short human-like pause between them.
  function deliver(outs, quoted) {
    for (const out of outs) {
      queue = queue
        .then(async () => {
          await sleep(600 + Math.random() * 900);
          const content = out.file
            ? { document: Buffer.from(out.file.content, 'utf8'), fileName: out.file.name, mimetype: 'text/csv' }
            : { text: out.text };
          const quote = quoted && isJidGroup(out.chat) && out.chat === quoted.key.remoteJid ? { quoted } : undefined;
          await sock.sendMessage(out.chat, content, quote);
        })
        .catch((err) => console.error('Could not send a message:', err.message));
    }
  }

  function connect() {
    sock = makeWASocket({
      auth: state,
      version,
      logger: pino({ level: 'silent' }),
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });
    let askedForCode = false;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        const phone = String(config.pairingPhone ?? '').replace(/\D/g, '');
        if (!phone) {
          console.log('\nOn the bot phone open WhatsApp → Linked devices → Link a device, and scan:\n');
          qrcode.generate(qr, { small: true });
        } else if (!askedForCode) {
          askedForCode = true;
          const code = await sock.requestPairingCode(phone);
          console.log(`\nOn the bot phone open WhatsApp → Linked devices → Link a device → "Link with phone number instead"\nand enter this code:  ${code}\n`);
        }
      }
      if (connection === 'open') retries = 0;
      if (connection === 'open') console.log('✅ Connected to WhatsApp. The bot is running.');
      if (connection === 'close') {
        const status = lastDisconnect?.error?.output?.statusCode;
        if (status === DisconnectReason.loggedOut) {
          console.log(`❌ Logged out from the phone. Delete the folder "${authDir}" and start again to re-link.`);
          process.exit(1);
        }
        retries++;
        const wait = Math.min(60, 3 * 2 ** Math.min(retries - 1, 5));
        const why = lastDisconnect?.error?.message ?? 'unknown reason';
        console.log(`Not connected (${why}). Check the internet connection. Retrying in ${wait}s…`);
        setTimeout(connect, wait * 1000);
      }
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        try {
          const { remoteJid, remoteJidAlt, participant, participantAlt, fromMe } = msg.key;
          const isGroup = Boolean(isJidGroup(remoteJid));
          if (fromMe || !remoteJid || (!isGroup && !/@(s\.whatsapp\.net|lid)$/.test(remoteJid))) continue;
          const text = textOf(msg.message);
          if (!text) continue;
          // A person can appear under a phone-number id or a hidden "lid" id; pass every one we see.
          const ids = (isGroup ? [participant, participantAlt] : [remoteJid, remoteJidAlt]).filter(Boolean).map(jidNormalizedUser);
          deliver(bot.handle({ ids, chatId: remoteJid, isGroup, text }), msg);
        } catch (err) {
          console.error('Could not handle a message:', err);
        }
      }
    });
  }

  connect();
  setInterval(() => {
    try {
      if (sock?.user) deliver(bot.daily());
    } catch (err) {
      console.error('Daily summary failed:', err);
    }
  }, 60_000);
}

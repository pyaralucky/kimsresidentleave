import path from 'node:path';
import fs from 'node:fs';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { openStore, loadConfig } from './store.js';
import { createBot } from './bot.js';

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const sim = process.argv.includes('--sim');

const config = loadConfig(path.join(dataDir, 'config.json'));
const store = openStore(path.join(dataDir, sim ? 'sim-db.json' : 'db.json'));
const bot = createBot({ store, config });

console.log(`${config.department} leave & postings bot`);
console.log(`  Residents register by messaging the bot:  join ${config.joinCode} <name> <JR1/JR2/JR3>`);
console.log(`  Admins (HOD / faculty / chief resident):  admin ${config.adminCode} <name>`);
console.log(`  Settings: ${path.join(dataDir, 'config.json')}\n`);

if (sim) simulate();
else {
  const { startWhatsApp } = await import('./whatsapp.js');
  await startWhatsApp({ bot, config, authDir: path.join(dataDir, 'auth') });
}

/** Try the bot in the terminal without WhatsApp. Type "name: message"; prefix with "group " for the group. */
function simulate() {
  console.log('SIMULATOR — type  "ravi: help"  or  "group ravi: !roster"  or  "daily". Ctrl+C to quit.\n');
  const show = (outs) =>
    outs.forEach((o) => {
      const to = o.chat.replace('@sim', '');
      if (o.file) {
        const file = path.join(dataDir, o.file.name);
        fs.writeFileSync(file, o.file.content);
        console.log(`  → [${to}] (file saved: ${file})`);
      } else console.log(`  → [${to}] ${o.text.replace(/\n/g, '\n      ')}`);
    });
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (line.trim() === 'daily') return show(bot.daily(new Date(Date.now() + 864e5)));
    const m = line.match(/^(group\s+)?(\w+):\s*(.*)$/);
    if (!m) return console.log('  (type "name: message")');
    const who = m[2].toLowerCase() + '@sim';
    show(bot.handle({ ids: [who], chatId: m[1] ? 'GROUP@sim' : who, isGroup: Boolean(m[1]), text: m[3].replace(/\\n/g, '\n') }));
  });
}

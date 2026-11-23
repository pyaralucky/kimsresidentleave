import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const EMPTY = { seq: 0, groupId: null, lastSummary: null, users: [], leaves: [], postings: [] };

function readJson(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file); // atomic: a crash never leaves a half-written file
}

/** Everything lives in one JSON file. Easy to back up, easy to read. */
export function openStore(file) {
  const db = { ...structuredClone(EMPTY), ...(readJson(file) ?? {}) };
  return { db, save: () => writeJson(file, db) };
}

export function memoryStore() {
  return { db: structuredClone(EMPTY), save() {} };
}

export const DEFAULT_CONFIG = {
  department: 'Dermatology',
  joinCode: '',
  adminCode: '',
  timezone: 'Asia/Kolkata',
  summaryTime: '07:30',
  pairingPhone: '',
  leaveTypes: { CL: 'Casual', SL: 'Sick', AL: 'Academic', EL: 'Earned' },
  leaveLimits: {},
};

/** Creates data/config.json on first run with random codes; fills in new defaults later. */
export function loadConfig(file) {
  const saved = readJson(file);
  const config = { ...DEFAULT_CONFIG, ...(saved ?? {}) };
  if (!config.joinCode) config.joinCode = 'DERM' + crypto.randomInt(1000, 10000);
  if (!config.adminCode) config.adminCode = 'HOD' + crypto.randomInt(100000, 1000000);
  if (JSON.stringify(saved) !== JSON.stringify(config)) writeJson(file, config);
  return config;
}

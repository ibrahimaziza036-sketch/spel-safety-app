// Photo-directory accounting, used to enforce a total storage cap on the public
// upload endpoint. The size is cached because stat-ing the whole directory on
// every request would be wasteful.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { uploadDir } from '../utils/paths.js';

let cachedBytes = null;
let cachedAt = 0;
const TTL_MS = 60000;

function measure() {
  try {
    return fs.readdirSync(uploadDir).reduce((sum, f) => {
      try { return sum + fs.statSync(path.join(uploadDir, f)).size; } catch { return sum; }
    }, 0);
  } catch { return 0; }
}

export function photoStorageUsed() {
  if (cachedBytes === null || Date.now() - cachedAt > TTL_MS) {
    cachedBytes = measure();
    cachedAt = Date.now();
  }
  return cachedBytes;
}

/** Adjust the cached total after a known add/remove, avoiding a full re-scan. */
export function bumpStorageUsed(bytes) {
  if (cachedBytes !== null) cachedBytes = Math.max(0, cachedBytes + bytes);
}

export function invalidateStorageCache() {
  cachedBytes = null;
}

export function storageIsFull() {
  return photoStorageUsed() >= config.intake.maxUploadDirBytes;
}

export function storageStatus() {
  const used = photoStorageUsed();
  const cap = config.intake.maxUploadDirBytes;
  return {
    usedBytes: used,
    capBytes: cap,
    usedPct: cap > 0 ? Math.round((used / cap) * 100) : 0,
    full: used >= cap,
  };
}

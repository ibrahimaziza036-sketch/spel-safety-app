// Shared filesystem locations. Kept in its own module so both the upload route
// and the notifier can resolve photo paths without importing each other.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const rootDir = path.join(__dirname, '..');
export const dataDir = path.join(rootDir, 'data');

// Incident photos live OUTSIDE the static web root, so they can only be served
// through the authenticated /uploads/:file route. Point UPLOAD_DIR at a path on
// a SEPARATE volume in production so a full photo directory can never break the
// database.
export const uploadDir = config.uploadDir
  ? path.resolve(config.uploadDir)
  : path.join(dataDir, 'uploads');

fs.mkdirSync(uploadDir, { recursive: true });

/** Absolute path of a stored photo, resolved safely by basename only. */
export function photoAbsPath(photoPath) {
  if (!photoPath) return null;
  return path.join(uploadDir, path.basename(photoPath));
}

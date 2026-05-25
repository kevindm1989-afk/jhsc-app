import { fileURLToPath } from 'node:url';
import path from 'node:path';

// This file lives at apps/web/test/_helpers/paths.ts.
// apps/web is two levels up; the repo root is four levels up.
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to apps/web, resolved from this file's location (portable across machines + CI). */
export const WEB_ROOT = path.resolve(HERE, '..', '..');

/** Absolute path to the repository root. */
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');

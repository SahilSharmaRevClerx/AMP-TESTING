import { join } from 'node:path';

/** Folders the tool reads and writes, relative to where `npm start` runs (the repo root). */
export const ROOT = process.cwd();
export const RULEBOOK_DIR = join(ROOT, 'rulebook');
export const OUTPUT_DIR = join(ROOT, 'output');
export const DEBUG_DIR = join(ROOT, 'debug');

/** The local server: only ever on this machine. */
export const PORT = Number(process.env.PORT ?? 4545);
export const HOST = '127.0.0.1';

/**
 * The data directory: one BIP39 mnemonic (created on first run, mode 0600) and the order/trust state per network.
 * The mnemonic is never logged or returned, except by the export_backup tool with confirm: true.
 */
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { generateMnemonic, isValidMnemonic, normalizeMnemonic } from '@proxy-shopping/core/node';

export function dataDirFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env.PS_DATA_DIR?.trim() || join(homedir(), '.proxy-shopping-mcp');
}

export const mnemonicPath = (dir: string) => join(dir, 'mnemonic');
export const statePath = (dir: string, network: string) => join(dir, `state-${network.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);

/** Read the data dir's mnemonic, creating the dir (0700) and a new 12-word mnemonic (0600) when there is none. */
export async function loadOrCreateMnemonic(dir: string): Promise<{ mnemonic: string; created: boolean }> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = mnemonicPath(dir);
  try {
    const m = normalizeMnemonic(await readFile(path, 'utf8'));
    if (!isValidMnemonic(m)) throw new Error(`${path} does not hold a valid BIP39 mnemonic`);
    // Tighten permissions of a file someone created by hand.
    const mode = (await stat(path)).mode & 0o777;
    if (mode & 0o077) await chmod(path, 0o600).catch(() => undefined);
    return { mnemonic: m, created: false };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const mnemonic = generateMnemonic(12);
  // 'wx': never overwrite a mnemonic another process just created.
  await writeFile(path, `${mnemonic}\n`, { mode: 0o600, flag: 'wx' }).catch(async (err) => {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  });
  const m = normalizeMnemonic(await readFile(path, 'utf8'));
  return { mnemonic: m, created: m === mnemonic };
}

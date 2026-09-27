import { generateMnemonic as gen, validateMnemonic as validate, entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';

export function generateMnemonic(words: 12 | 24 = 12): string {
  return gen(wordlist, words === 12 ? 128 : 256);
}

export function normalizeMnemonic(m: string): string {
  return m.trim().toLowerCase().split(/\s+/).join(' ');
}

export function isValidMnemonic(m: string): boolean {
  const n = normalizeMnemonic(m);
  const count = n.split(' ').length;
  return (count === 12 || count === 24) && validate(n, wordlist);
}

export function mnemonicFromEntropy(entropy: Uint8Array): string {
  return entropyToMnemonic(entropy, wordlist);
}

import { finalizeEvent, getPublicKey, type EventTemplate, type NostrEvent } from 'nostr-tools/pure';
import * as nip44 from 'nostr-tools/nip44';

/**
 * Identity signer: signs events and does NIP-44 v2 with the identity key.
 * Implemented locally (from the mnemonic) or by a NIP-07 browser extension.
 */
export interface IdentitySigner {
  getPublicKey(): Promise<string>;
  signEvent(template: EventTemplate): Promise<NostrEvent>;
  nip44Encrypt(peer: string, plaintext: string): Promise<string>;
  nip44Decrypt(peer: string, ciphertext: string): Promise<string>;
}

export class LocalSigner implements IdentitySigner {
  readonly pubkey: string;
  private readonly convKeys = new Map<string, Uint8Array>();

  constructor(private readonly secretKey: Uint8Array) {
    this.pubkey = getPublicKey(secretKey);
  }

  async getPublicKey() {
    return this.pubkey;
  }

  async signEvent(template: EventTemplate): Promise<NostrEvent> {
    return finalizeEvent(template, this.secretKey);
  }

  async nip44Encrypt(peer: string, plaintext: string) {
    return nip44.encrypt(plaintext, this.conversationKey(peer));
  }

  async nip44Decrypt(peer: string, ciphertext: string) {
    return nip44.decrypt(ciphertext, this.conversationKey(peer));
  }

  private conversationKey(peer: string): Uint8Array {
    let k = this.convKeys.get(peer);
    if (!k) this.convKeys.set(peer, (k = nip44.getConversationKey(this.secretKey, peer)));
    return k;
  }
}

/** Shape of `window.nostr` (NIP-07) that we rely on. */
export interface Nip07Provider {
  getPublicKey(): Promise<string>;
  signEvent(event: EventTemplate): Promise<NostrEvent>;
  nip44?: {
    encrypt(pubkey: string, plaintext: string): Promise<string>;
    decrypt(pubkey: string, ciphertext: string): Promise<string>;
  };
}

export class Nip07Signer implements IdentitySigner {
  private pubkey?: string;

  constructor(private readonly provider: Nip07Provider) {
    if (!provider.nip44) throw new Error('NIP-07 extension does not support NIP-44');
  }

  async getPublicKey() {
    return (this.pubkey ??= await this.provider.getPublicKey());
  }

  signEvent(template: EventTemplate) {
    return this.provider.signEvent(template);
  }

  nip44Encrypt(peer: string, plaintext: string) {
    return this.provider.nip44!.encrypt(peer, plaintext);
  }

  nip44Decrypt(peer: string, ciphertext: string) {
    return this.provider.nip44!.decrypt(peer, ciphertext);
  }
}

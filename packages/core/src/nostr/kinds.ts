export const KIND = {
  seal: 13,
  giftWrap: 1059,
  inboxRelays: 10050,
  inner: 5400,
  status: 5401,
  delegation: 30500,
  operatorList: 30501,
  shopperProfile: 30502,
  escrowProfile: 30503,
} as const;

export type { NostrEvent, EventTemplate } from 'nostr-tools/pure';

export function tagValue(tags: string[][], name: string): string | undefined {
  return tags.find((t) => t[0] === name)?.[1];
}

export function tagValues(tags: string[][], name: string): string[] {
  return tags.filter((t) => t[0] === name && t[1] !== undefined).map((t) => t[1]);
}

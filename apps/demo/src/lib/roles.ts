/** Roles whose keys live in this browser; each runs its own Session. */
export const SESSION_ROLES = ['user', 'escrow', 'operator', 'coordinator'] as const;
export type SessionRole = (typeof SESSION_ROLES)[number];

/** Tabs of the page: the session roles plus the always-online Go shopper node and the lab controls. */
export const TABS = ['user', 'shopper', 'escrow', 'operator', 'coordinator', 'lab'] as const;
export type TabId = (typeof TABS)[number];

/** Who acts in a guide step: a tab's role, or the chain (waiting for confirmations). */
export type Actor = TabId | 'chain';

// Role names and one-line descriptions are in the message catalogs (i18n: roles.label, roles.about).

export const isSessionRole = (r: string): r is SessionRole => (SESSION_ROLES as readonly string[]).includes(r);

/**
 * `?role=user` or `?role=escrow,operator` runs only those roles in this window (the "separate windows" mode);
 * without the parameter every role runs here.
 */
export function rolesFromQuery(search: string): { roles: SessionRole[]; separate: boolean } {
  const raw = new URLSearchParams(search).get('role');
  if (!raw) return { roles: [...SESSION_ROLES], separate: false };
  const roles = raw.split(',').map((r) => r.trim()).filter(isSessionRole);
  return { roles: SESSION_ROLES.filter((r) => roles.includes(r)), separate: true };
}

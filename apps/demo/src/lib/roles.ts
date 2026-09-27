/** Roles whose keys live in this browser; each runs its own Session. */
export const SESSION_ROLES = ['user', 'escrow', 'operator', 'coordinator'] as const;
export type SessionRole = (typeof SESSION_ROLES)[number];

/** Tabs of the page: the session roles plus the always-online Go shopper node and the lab controls. */
export const TABS = ['user', 'shopper', 'escrow', 'operator', 'coordinator', 'lab'] as const;
export type TabId = (typeof TABS)[number];

/** Who acts in a guide step: a tab's role, or the chain (waiting for confirmations). */
export type Actor = TabId | 'chain';

export const ROLE_LABEL: Record<Actor, string> = {
  user: '利用者',
  shopper: 'shopper（ノード）',
  escrow: 'escrow',
  operator: 'operator',
  coordinator: 'coordinator',
  lab: 'lab 操作',
  chain: 'チェーン',
};

/** One line on what each role is, for the tab headers. */
export const ROLE_ABOUT: Record<TabId, string> = {
  user: '買い物を頼む人。暗号通貨を 2-of-3 のマルチシグに預け、届いたら支払いに署名します。',
  shopper: '常時オンラインの Go ノード（shopper-1）。見積・代理購入・配送の報告を自動で行います。ここでは状態を見るだけです。',
  escrow: '紛争のときだけ出てくる第三者。前払い手数料を受けた注文について、証拠を見て配分を決め、署名します。',
  operator: '地域ごとに信頼できる shopper × escrow の組み合わせ一覧に署名して公開します。通報を受けて一覧から外します。',
  coordinator: 'operator に一覧を作る権限を委任します。利用者とノードは coordinator の鍵を信頼の起点にします。',
  lab: 'docker compose の lab を操作します（採掘・時刻送り・shopper の一時停止・レート）。実際の網には無い、デモ専用の操作です。',
};

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

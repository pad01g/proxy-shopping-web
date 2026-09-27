import { fundingStarted, type UserOrder } from '@proxy-shopping/core/browser';
import { ActionButton, Explain, Mono, Section, type ConfirmSpec } from '../../components/ui';
import { formatAsset } from '../../lib/format';
import { useRuntime } from '../../state';

const LABEL: Record<string, string> = { escrow: '預け先（マルチシグ）', 'escrow fee': 'escrow の前払い手数料' };

export function FundSection({ o }: { o: UserOrder }) {
  const rt = useRuntime('user');
  const q = o.quote!;
  const isBtc = o.payment === 'btc-signet';
  if (fundingStarted(o)) {
    return (
      <Section title="入金" testid="fund">
        <p className="banner warn" data-testid="fund-in-progress">
          入金が途中で止まりました。続きを実行すると、同じ取引をチェーンで確かめ、shopper と escrow に知らせます（二重には払いません）。
        </p>
        <ActionButton testid="order-fund" confirm={{ title: '入金の続きを実行します', recipient: q.escrow_address, okLabel: '続ける' }} onClick={() => rt.client.fund(o.id)}>
          入金を再開する
        </ActionButton>
      </Section>
    );
  }
  const confirm = async (): Promise<ConfirmSpec> => {
    const p = await rt.client.previewFunding(o.id);
    return {
      title: isBtc ? '2-of-3 のマルチシグに入金します' : 'Safe を作って入金します',
      amount: formatAsset(p.total, o.payment),
      recipient: p.recipients[0].address,
      details: (
        <ul data-testid="confirm-details">
          {p.recipients.map((r) => <li key={r.label}>{LABEL[r.label] ?? r.label}: {formatAsset(r.amount, o.payment)} → <Mono>{r.address}</Mono></li>)}
          {p.networkFee !== undefined && <li>送金手数料: {formatAsset(p.networkFee, o.payment)}（{p.feeRate} sat/vB）</li>}
          {!isBtc && <li>ほかにガス代（ETH）がかかります（Safe の作成・送金 2 回）</li>}
        </ul>
      ),
      okLabel: '入金する',
    };
  };
  return (
    <Section title="入金" testid="fund">
      <Explain>
        {isBtc
          ? '入金先は利用者・shopper・escrow の 3 つの鍵のうち 2 つで使える P2WSH です。同じ取引で escrow に前払い手数料も払います（払わない注文について escrow は裁定の義務を負いません）。'
          : '注文ごとの Safe（所有者 3 人、しきい値 2）を作り、USDC を送ります。escrow の前払い手数料は別の USDC の送金です。'}
      </Explain>
      <p>必要な額: {formatAsset(BigInt(q.lock_amount ?? '0') + BigInt(q.escrow_upfront_fee ?? '0'), o.payment)}（{isBtc ? '+ 送金手数料' : '+ ガス代'}）</p>
      <div className="row">
        <ActionButton testid="order-fund" confirm={confirm} onClick={() => rt.client.fund(o.id)}>
          {isBtc ? 'マルチシグに入金する' : 'Safe を作って入金する'}
        </ActionButton>
        <ActionButton testid="fund-cancel" kind="plain" onClick={() => rt.client.cancel(o.id)}>取り消す</ActionButton>
      </div>
    </Section>
  );
}

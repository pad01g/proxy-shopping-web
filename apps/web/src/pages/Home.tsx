import { Link } from 'react-router-dom';
import { Copyable, Section } from '../components/ui';
import { short } from '../lib/format';
import { useLive, useRuntime } from '../state';

export function HomePage() {
  const rt = useRuntime();
  const [snap, refresh] = useLive(
    async () => rt.session.directory.current ?? (await rt.session.directory.load()),
    (cb) => {
      const t = setInterval(cb, 5000);
      return () => clearInterval(t);
    },
  );
  return (
    <div data-testid="home">
      <h1>代理購入</h1>
      <p className="muted">
        暗号通貨で、現金や特定の決済しか使えない店の買い物を代行してもらえます。資金は 2-of-3 の多重署名（あなた・shopper・escrow）に預けます。
      </p>
      <Section title="あなたの身元">
        <p>
          Nostr 公開鍵: <Copyable value={rt.pubkey} testid="home-pubkey" />
        </p>
        <p className="muted">ネットワーク {rt.config.network} ・ リレー {rt.config.relays.length} 個 ・ coordinator {rt.config.coordinators.length} 人</p>
        {rt.deploymentsError && <p className="banner warn" data-testid="home-deployments-error">EVM のコントラクト情報を読めません: {rt.deploymentsError}</p>}
      </Section>
      <Section title="信頼の一覧">
        <p data-testid="home-effective-count" data-count={snap?.entries.length ?? 0}>
          実効の組み合わせ: {snap?.entries.length ?? 0} 件（オペレータ {snap?.lists.size ?? 0}）
        </p>
        <ul>
          {snap?.entries.slice(0, 10).map((e) => (
            <li key={`${e.region}${e.shopper}${e.escrow}`} className="muted">
              {e.region} ・ shopper {snap.shoppers.get(e.shopper)?.content.name ?? short(e.shopper)} × escrow {snap.escrows.get(e.escrow)?.content.name ?? short(e.escrow)}
            </li>
          ))}
        </ul>
        <button type="button" className="plain" data-testid="home-refresh-trust" onClick={() => void rt.session.directory.refresh().then(refresh)}>
          一覧を再取得
        </button>
      </Section>
      <div className="row">
        <Link to="/user/new"><button type="button" className="primary">注文する</button></Link>
        <Link to="/wallet"><button type="button">財布</button></Link>
      </div>
    </div>
  );
}

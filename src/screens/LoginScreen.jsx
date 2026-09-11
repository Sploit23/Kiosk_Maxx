import { useEffect, useState } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import { autenticar, LOJA, USERS } from '../catalog';
import portalApi from '@shared/api/portalApi';
import { formatarCodigoKiosk, garantirIdentidade } from '@shared/api/kiosk';

export default function LoginScreen({ onLogin, showToast }) {
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [error, setError] = useState('');
  const [shake, setShake] = useState(false);
  const [busy, setBusy] = useState(false);
  const [full, setFull] = useState(false);
  const [kioskPar, setKioskPar] = useState(() => (typeof window !== 'undefined' ? window.kioskPair : null) || null);
  const [kioskCode, setKioskCode] = useState('');

  useEffect(() => {
    garantirIdentidade().then(({ kioskCode: code }) => setKioskCode(formatarCodigoKiosk(code))).catch(() => {});
    const onPair = () => setKioskPar(window.kioskPair || null);
    window.addEventListener('kiosk:pair', onPair);
    return () => window.removeEventListener('kiosk:pair', onPair);
  }, []);

  const toggleFullscreen = () => {
    setFull((prev) => {
      const next = !prev;
      window.natal?.ipcInvoke(next ? 'natal:enterFullscreen' : 'natal:exitFullscreen').catch(() => {});
      return next;
    });
  };

  const invalid = () => {
    setError('Usuário ou senha inválidos.');
    setShake(true);
    setTimeout(() => setShake(false), 350);
    setBusy(false);
  };

  const entrar = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    const usuario = user.trim();

    let u = null;
    try {
      const res = await portalApi.login(usuario, pass);
      if (res.ok) {
        u = { ...res.user, origem: 'portal' };
      } else if (!res.offline) {
        invalid();
        return;
      }
    } catch {
      /* sem conexão com o portal → usa o cadastro local abaixo */
    }

    if (!u) {
      const local = autenticar(usuario, pass);
      if (!local) { invalid(); return; }
      u = { ...local, origem: 'offline' };
      showToast('Sem conexão com o portal — usando cadastro local.');
    } else {
      showToast(`Bem-vindo(a), ${u.nome}`);
    }

    setBusy(false);
    onLogin(u);
  };

  const selecionarUsuario = (nome) => {
    const card = USERS.find((x) => x.nome === nome || x.user === nome);
    if (card) setUser(card.user);
    setPass('');
  };

  return (
    <div className="login-overlay screen-enter">
      <span className="k-chip icon login-fs-btn" onClick={toggleFullscreen} title={full ? 'Sair da tela cheia' : 'Tela cheia'}>
        {full ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
      </span>
      <form
        className="login-box"
        onSubmit={(e) => { e.preventDefault(); entrar(); }}
      >
        <div className="login-mark">M</div>
        <h1>Painel de Vendas</h1>
        <p className="login-sub">{LOJA.marca} · {LOJA.evento} · {LOJA.local}</p>

        <div className="login-users">
          {USERS.map((u) => {
            const active = user === u.user;
            return (
              <button
                type="button"
                key={u.user}
                className={`login-user-card${active ? ' selected' : ''}`}
                onClick={() => selecionarUsuario(u.nome)}
              >
                <div className="login-user-avatar">{u.nome.charAt(0)}</div>
                <div>
                  <div className="login-user-nome">{u.nome}</div>
                  <div className="login-user-funcao">Operador · acesso ao PDV</div>
                </div>
                {active && <span style={{ marginLeft: 'auto', color: 'var(--gold-300)', fontWeight: 800 }}>✓</span>}
              </button>
            );
          })}
        </div>

        <div className="field" style={{ textAlign: 'left' }}>
          <label>Usuário</label>
          <input autoFocus value={user} onChange={(e) => { setUser(e.target.value); setError(''); }} placeholder="ex.: admin" />
        </div>
        <div className="login-pass-row">
          <input
            type="password"
            value={pass}
            onChange={(e) => { setPass(e.target.value); setError(''); }}
            placeholder="Senha"
            inputMode="numeric"
            maxLength="6"
          />
          <button type="submit" className="btn-primary" disabled={busy || !user.trim()}>
            {busy ? 'VERIFICANDO…' : 'Entrar'}
          </button>
        </div>

        <div className={`login-error${shake ? ' login-err-shake' : ''}`}>{error}</div>
        <p className="login-sub" style={{ margin: '18px 0 0', fontSize: '11px', letterSpacing: '.8px' }}>
          {LOJA.nome} · {LOJA.tagline}
        </p>
        <p className="login-kiosk">
          🖥️ Código do kiosk: <b>{kioskCode || '—'}</b>
          <br />
          <span className={kioskPar && kioskPar.ok ? 'pair-ok' : 'pair-no'}>
            {kioskPar && kioskPar.ok
              ? `✔ Emparelhado — ${kioskPar.loja ? kioskPar.loja.nome : ''}`
              : 'Aguardando emparelhar — informe este código no portal de gestão'}
          </span>
        </p>
      </form>
    </div>
  );
}
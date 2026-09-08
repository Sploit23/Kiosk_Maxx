import { useState } from 'react';
import { autenticar, LOJA } from '../catalog';

export default function LoginScreen({ onLogin, showToast }) {
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [error, setError] = useState('');
  const [shake, setShake] = useState(false);

  const entrar = () => {
    const u = autenticar(user.trim(), pass);
    if (!u) {
      setError('Usuário ou senha inválidos.');
      setShake(true);
      setTimeout(() => setShake(false), 350);
      return;
    }
    setError('');
    onLogin(u);
    showToast(`Bem-vindo(a), ${u.nome}`);
  };

  return (
    <div className="login-screen screen-enter">
      <form
        className="login-card"
        onSubmit={(e) => { e.preventDefault(); entrar(); }}
      >
        <div className="login-logo">
          <div className="mark">M</div>
          <div className="brand">{LOJA.marca.replace(/ /g, '')}</div>
          <div className="sub">{LOJA.evento} · {LOJA.local}</div>
        </div>
        <h1>Painel de Vendas</h1>
        <p className="tag">Acesse com suas credenciais para iniciar o atendimento.</p>

        {error && <div className={`login-error${shake ? ' login-err-shake' : ''}`}>{error}</div>}

        <div className="field">
          <label>Usuário</label>
          <input autoFocus value={user} onChange={(e) => setUser(e.target.value)} placeholder="ex.: admin" />
        </div>
        <div className="field" style={{ marginBottom: '22px' }}>
          <label>Senha</label>
          <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="••••" />
        </div>
        <button type="submit" className="btn-gold" style={{ width: '100%' }}>
          ENTRAR
        </button>
        <p className="muted small center" style={{ margin: '16px 0 0', fontSize: '10px', letterSpacing: '1px' }}>
          {LOJA.nome} · {LOJA.tagline}
        </p>
      </form>
    </div>
  );
}
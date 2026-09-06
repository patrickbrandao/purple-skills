import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  changePassword,
  createKey,
  formatDateTime,
  getKeys,
  revokeKey,
  type ApiKeySummary,
  type SessionUser,
} from '../api.js';
import { Button, Field, Panel } from '../components/ui.js';
import { CopyIcon, KeyIcon, LockIcon, TrashIcon } from '../components/Icons.js';
import { useToast } from '../components/Toast.js';

/** Minha conta: troca de senha e chaves do MCP administrativo. */
export function AccountPage({ user, onChanged }: { user: SessionUser; onChanged: () => void }) {
  const toast = useToast();
  const [keys, setKeys] = useState<ApiKeySummary[]>([]);
  const [keyName, setKeyName] = useState('');
  const [issued, setIssued] = useState<string | null>(null);
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNew] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setKeys((await getKeys()).items);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submitPassword(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await changePassword({ currentPassword, newPassword });
      setCurrent('');
      setNew('');
      toast.success('Senha alterada. As suas outras sessões foram encerradas.');
      onChanged();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function submitKey(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await createKey(keyName);
      setIssued(result.token);
      setKeyName('');
      await load();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(key: ApiKeySummary) {
    if (!window.confirm(`Revogar a chave "${key.name}"? Quem a estiver usando perde o acesso.`)) {
      return;
    }
    try {
      await revokeKey(key.id);
      toast.success('Chave revogada.');
      await load();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="display">Minha conta</h1>
          <p className="sub">
            {user.email || 'sessão de bootstrap'} — papel <strong>{user.role}</strong>
          </p>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel title="Trocar senha" icon={<LockIcon />}>
          <form onSubmit={submitPassword} className="grid gap-4">
            <Field label="Senha atual">
              <input
                type="password"
                className="field"
                value={currentPassword}
                onChange={(event) => setCurrent(event.target.value)}
                autoComplete="current-password"
              />
            </Field>
            <Field label="Nova senha" hint="Mínimo de 10 caracteres.">
              <input
                type="password"
                className="field"
                value={newPassword}
                onChange={(event) => setNew(event.target.value)}
                autoComplete="new-password"
              />
            </Field>
            <Button type="submit" disabled={busy || !newPassword}>
              Salvar senha
            </Button>
          </form>
        </Panel>

        <Panel title="Chaves do MCP administrativo" icon={<KeyIcon />}>
          <p className="panel-hint">
            Uma chave carrega o <strong>seu papel</strong> e aparece na auditoria com o seu nome.
            Use-a no lugar do <code>MCP_ADMIN_TOKEN</code> ao configurar um agente.
          </p>

          <form onSubmit={submitKey} className="flex gap-2">
            <input
              className="field"
              value={keyName}
              onChange={(event) => setKeyName(event.target.value)}
              placeholder="Nome da chave (ex.: notebook do trabalho)"
              aria-label="Nome da chave"
            />
            <Button type="submit" disabled={busy || !keyName.trim()}>
              Emitir
            </Button>
          </form>

          {issued && (
            <div className="key-reveal">
              <p className="t">Copie agora — esta é a única vez que a chave aparece.</p>
              <div className="row">
                <code>{issued}</code>
                <button
                  type="button"
                  className="row-action"
                  title="Copiar"
                  onClick={() => {
                    void navigator.clipboard?.writeText(issued);
                    toast.success('Chave copiada.');
                  }}
                >
                  <CopyIcon />
                </button>
              </div>
              <button type="button" className="dismiss" onClick={() => setIssued(null)}>
                Já copiei, pode esconder
              </button>
            </div>
          )}

          <div className="table-wrap mt-4">
            <table className="data">
              <thead>
                <tr>
                  <th>Chave</th>
                  <th className="hidden sm:table-cell">Último uso</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {keys.map((key) => (
                  <tr key={key.id}>
                    <td>
                      <span className="row-title">{key.name}</span>
                      <span className="row-sub">
                        psk_{key.prefix}_… · criada em {formatDateTime(key.createdAt)}
                        {key.revokedAt && ' · revogada'}
                      </span>
                    </td>
                    <td className="hidden sm:table-cell">
                      <span className="row-sub">
                        {key.lastUsedAt ? formatDateTime(key.lastUsedAt) : 'nunca usada'}
                      </span>
                    </td>
                    <td className="num">
                      {!key.revokedAt && (
                        <button
                          type="button"
                          className="row-action"
                          title="Revogar chave"
                          onClick={() => void remove(key)}
                        >
                          <TrashIcon />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {keys.length === 0 && (
                  <tr>
                    <td colSpan={3}>
                      <p className="list-empty">Nenhuma chave emitida.</p>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>
    </>
  );
}

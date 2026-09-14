import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { KeyRound, Lock, Trash2 } from 'lucide-react';
import {
  ROLE_LABEL,
  changePassword,
  createKey,
  formatDateTime,
  getKeys,
  revokeKey,
  type ApiKeySummary,
  type SessionUser,
} from '../api.js';
import { Button, CopyButton, EmptyRow, Field, Panel, useConfirm } from '../components/ui.js';
import { useToast } from '../components/Toast.js';

/** Minha conta: troca de senha e chaves do MCP administrativo. */
export function AccountPage({ user, onChanged }: { user: SessionUser; onChanged: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
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
    const ok = await confirm({
      title: `Revogar a chave "${key.name}"?`,
      description: 'Quem a estiver usando perde o acesso na chamada seguinte.',
      confirmLabel: 'Revogar',
      danger: true,
    });
    if (!ok) return;
    try {
      await revokeKey(key.id);
      toast.success('Chave revogada.');
      await load();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Minha conta</h1>
          <p className="sub">
            {user.email || 'sessão de bootstrap'} · {ROLE_LABEL[user.role]}
          </p>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Trocar senha" icon={<Lock />}>
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
            <div>
              <Button type="submit" disabled={busy || !newPassword}>
                Salvar senha
              </Button>
            </div>
          </form>
        </Panel>

        <Panel title="Chaves do MCP administrativo" icon={<KeyRound />}>
          <p className="panel-hint">
            Uma chave carrega o <strong>seu papel</strong> e aparece na auditoria com o seu nome. Use-a
            no lugar do <code>MCP_ADMIN_TOKEN</code> ao configurar um agente.
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
                <CopyButton text={issued} />
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
                  <tr key={key.id} className={key.revokedAt ? 'is-off' : undefined}>
                    <td>
                      <span className="row-title">{key.name}</span>
                      <span className="row-sub">
                        psk_{key.prefix}_… · criada em {formatDateTime(key.createdAt)}
                        {key.revokedAt && ' · revogada'}
                      </span>
                    </td>
                    <td className="hidden sm:table-cell">
                      <span className="row-sub">{key.lastUsedAt ? formatDateTime(key.lastUsedAt) : 'nunca usada'}</span>
                    </td>
                    <td className="num">
                      {!key.revokedAt && (
                        <button type="button" className="row-action danger" title="Revogar chave" onClick={() => void remove(key)}>
                          <Trash2 />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {keys.length === 0 && <EmptyRow colSpan={3}>Nenhuma chave ainda</EmptyRow>}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>
    </div>
  );
}

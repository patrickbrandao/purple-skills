import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { KeyRound, Plus, Trash2 } from 'lucide-react';
import {
  ROLE_LABEL,
  createKey,
  formatDateTime,
  getKeys,
  revokeKey,
  type ApiKeySummary,
  type SessionUser,
} from '../api.js';
import { Button, CopyButton, EmptyRow, Panel, Skel, useConfirm } from '../components/ui.js';
import { useToast } from '../components/Toast.js';

/**
 * Configurações → Adm MCP Keys: a tela das chaves `psk_` da própria conta.
 * Emitir, listar e revogar ficam aqui, fora de Minha conta, que voltou a ser
 * só a senha. Renomear não existe: a chave nasce com um nome e morre com ele
 * (`docs/10-admin-canvas-e-sessoes.md` §3.4).
 *
 * As `psv_` de servidor não entram: elas aparecem na tela vizinha, Chaves
 * emitidas, ao lado destas, porque lá o recorte é "o que eu emiti".
 */
export function AdminKeysPage({ user }: { user: SessionUser }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [keys, setKeys] = useState<ApiKeySummary[] | null>(null);
  const [keyName, setKeyName] = useState('');
  const [issued, setIssued] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setKeys((await getKeys()).items);
    } catch (err) {
      toast.error((err as Error).message);
      setKeys([]);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await createKey(keyName);
      setIssued(result.token);
      setKeyName('');
      await load();
      toast.success('Chave emitida.');
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(key: ApiKeySummary) {
    const ok = await confirm({
      title: `Revogar a chave "${key.name}"?`,
      description: 'Quem a estiver usando perde o acesso ao MCP administrativo na chamada seguinte.',
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

  const active = (keys ?? []).filter((key) => !key.revokedAt).length;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Adm MCP Keys</h1>
          <p className="sub">
            As chaves <code>psk_</code> desta conta · {ROLE_LABEL[user.role]}
          </p>
        </div>
      </div>

      <div className="grid content-start gap-4">
        <Panel title="Emitir uma chave" icon={<Plus />}>
          <p className="panel-hint">
            Uma chave carrega o <strong>seu papel</strong> e aparece na auditoria com o seu nome. Use-a
            no lugar do <code>MCP_ADMIN_TOKEN</code> ao configurar um agente.
          </p>

          <form onSubmit={submit} className="flex gap-2">
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
        </Panel>

        <Panel
          title="Chaves"
          icon={<KeyRound />}
          actions={
            <Link to="/account/chaves-emitidas" className="btn btn-ghost btn-sm">
              Ver também as de servidor
            </Link>
          }
        >
          <p className="panel-hint">
            Revogar é imediato e não tem volta; a chave revogada fica na lista como registro.
            {keys && ` ${active} ativa${active === 1 ? '' : 's'}.`}
          </p>
          {keys === null ? (
            <Skel h={160} />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Chave</th>
                    <th className="hidden sm:table-cell">Criada</th>
                    <th className="hidden sm:table-cell">Último uso</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {keys.map((key) => (
                    <tr key={key.id} className={key.revokedAt ? 'is-off' : undefined}>
                      <td>
                        <span className="row-title">{key.name}</span>
                        <span className="row-sub mono">
                          psk_{key.prefix}_…{key.revokedAt && ` · revogada em ${formatDateTime(key.revokedAt)}`}
                        </span>
                      </td>
                      <td className="hidden sm:table-cell">
                        <span className="row-sub">{formatDateTime(key.createdAt)}</span>
                      </td>
                      <td className="hidden sm:table-cell">
                        <span className="row-sub">{key.lastUsedAt ? formatDateTime(key.lastUsedAt) : 'nunca usada'}</span>
                      </td>
                      <td className="num">
                        {!key.revokedAt && (
                          <button
                            type="button"
                            className="row-action danger"
                            title="Revogar chave"
                            onClick={() => void remove(key)}
                          >
                            <Trash2 />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {keys.length === 0 && <EmptyRow colSpan={4}>Nenhuma chave ainda</EmptyRow>}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}

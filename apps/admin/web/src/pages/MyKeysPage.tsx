import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { KeyRound, Server, Trash2 } from 'lucide-react';
import {
  formatDateTime,
  getKeys,
  getMyMcpKeys,
  revokeKey,
  revokeMcpKey,
  type ApiKeySummary,
  type IssuedMcpKey,
  type SessionUser,
} from '../api.js';
import { EmptyRow, Panel, Skel, useConfirm } from '../components/ui.js';
import { useToast } from '../components/Toast.js';

/**
 * Meu espaço → Chaves emitidas: tudo o que a conta emitiu, dos dois tipos.
 * As `psk_` (MCP administrativo) são dela; as `psv_` pertencem a um servidor
 * e aparecem aqui porque foi ela quem as emitiu — revogar uma delas ainda
 * exige `manage` no servidor, e o servidor diz não se a conta o perdeu.
 */
export function MyKeysPage({ user }: { user: SessionUser }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [adminKeys, setAdminKeys] = useState<ApiKeySummary[] | null>(null);
  const [mcpKeys, setMcpKeys] = useState<IssuedMcpKey[] | null>(null);

  const load = useCallback(async () => {
    // A sessão de bootstrap não tem conta: não há chave dela para listar.
    const [own, issued] = await Promise.all([
      user.legacy ? Promise.resolve({ items: [] }) : getKeys().catch((err: Error) => (toast.error(err.message), { items: [] })),
      getMyMcpKeys().catch((err: Error) => (toast.error(err.message), { items: [] })),
    ]);
    setAdminKeys(own.items);
    setMcpKeys(issued.items);
  }, [toast, user.legacy]);

  useEffect(() => {
    void load();
  }, [load]);

  async function revokeAdmin(key: ApiKeySummary) {
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

  async function revokeServer(key: IssuedMcpKey) {
    const ok = await confirm({
      title: `Revogar a chave "${key.name}" de ${key.virtualMcpName}?`,
      description: 'Quem a estiver usando perde o acesso ao servidor na chamada seguinte.',
      confirmLabel: 'Revogar',
      danger: true,
    });
    if (!ok) return;
    try {
      await revokeMcpKey(key.virtualMcpSlug, key.id);
      toast.success('Chave revogada.');
      await load();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  const activeAdmin = (adminKeys ?? []).filter((key) => !key.revokedAt).length;
  const activeMcp = (mcpKeys ?? []).filter((key) => !key.revokedAt).length;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Chaves emitidas</h1>
          <p className="sub">As chaves de API que você emitiu, ativas e revogadas.</p>
        </div>
      </div>

      <div className="grid gap-4">
        <Panel
          title="MCP administrativo (psk_)"
          icon={<KeyRound />}
          actions={
            !user.legacy && (
              <Link to="/account" className="btn btn-ghost btn-sm">
                Emitir em Minha conta
              </Link>
            )
          }
        >
          <p className="panel-hint">
            Carregam o seu papel e aparecem na auditoria com o seu nome.
            {adminKeys && ` ${activeAdmin} ativa${activeAdmin === 1 ? '' : 's'}.`}
          </p>
          {adminKeys === null ? (
            <Skel h={120} />
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
                  {adminKeys.map((key) => (
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
                          <button type="button" className="row-action danger" title="Revogar chave" onClick={() => void revokeAdmin(key)}>
                            <Trash2 />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {adminKeys.length === 0 && (
                    <EmptyRow colSpan={4}>{user.legacy ? 'A sessão de bootstrap não emite chaves' : 'Nenhuma chave emitida'}</EmptyRow>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel title="Servidores MCP (psv_)" icon={<Server />}>
          <p className="panel-hint">
            Dão acesso a um servidor virtual; revogar uma delas exige gerenciar o servidor.
            {mcpKeys && ` ${activeMcp} ativa${activeMcp === 1 ? '' : 's'}.`}
          </p>
          {mcpKeys === null ? (
            <Skel h={120} />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Chave</th>
                    <th>Servidor</th>
                    <th className="hidden sm:table-cell">Criada</th>
                    <th className="hidden md:table-cell">Último uso</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {mcpKeys.map((key) => (
                    <tr key={key.id} className={key.revokedAt ? 'is-off' : undefined}>
                      <td>
                        <span className="row-title">{key.name}</span>
                        <span className="row-sub mono">
                          psv_{key.prefix}_…{key.revokedAt && ` · revogada em ${formatDateTime(key.revokedAt)}`}
                        </span>
                      </td>
                      <td>
                        <Link to={`/mcps/${key.virtualMcpSlug}/chaves`} className="block no-underline">
                          <span className="row-title">{key.virtualMcpName}</span>
                          <span className="row-sub">{key.virtualMcpSlug}</span>
                        </Link>
                      </td>
                      <td className="hidden sm:table-cell">
                        <span className="row-sub">{formatDateTime(key.createdAt)}</span>
                      </td>
                      <td className="hidden md:table-cell">
                        <span className="row-sub">{key.lastUsedAt ? formatDateTime(key.lastUsedAt) : 'nunca usada'}</span>
                      </td>
                      <td className="num">
                        {!key.revokedAt && (
                          <button type="button" className="row-action danger" title="Revogar chave" onClick={() => void revokeServer(key)}>
                            <Trash2 />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {mcpKeys.length === 0 && <EmptyRow colSpan={5}>Nenhuma chave de servidor emitida por você</EmptyRow>}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}

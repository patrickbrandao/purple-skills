import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  canCreateVirtualMcp,
  canManageUsers,
  createMcp,
  createPublicKey,
  formatDateTime,
  getMcps,
  getPublicKeys,
  revokePublicKey,
  type PublicMcpKeySummary,
  type SessionUser,
  type VirtualMcpSummary,
} from '../api.js';
import { Button, Field, Panel } from '../components/ui.js';
import { CopyIcon, KeyIcon, PlusIcon, ServerIcon, TrashIcon } from '../components/Icons.js';
import { useToast } from '../components/Toast.js';
import { useNavigate } from 'react-router-dom';

/**
 * MCPs virtuais: recortes do catálogo com endereço, chaves e dono próprios
 * (`docs/08-mcp-virtual.md`). Admin vê todos; os demais, só os seus.
 */
export function McpsPage({ user }: { user: SessionUser }) {
  const toast = useToast();
  const navigate = useNavigate();
  const podeCriar = canCreateVirtualMcp(user.role);
  const [items, setItems] = useState<VirtualMcpSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setItems((await getMcps()).items);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const created = await createMcp({
        name,
        slug: slug.trim() || undefined,
        description: description.trim() || undefined,
      });
      toast.success(`MCP virtual "${created.name}" criado. Agora escolha as skills.`);
      navigate(`/mcps/${created.slug}`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="display">MCPs virtuais</h1>
          <p className="sub">
            {loading
              ? 'Carregando…'
              : user.role === 'admin'
                ? `${items.length} servidor${items.length === 1 ? '' : 'es'} — você vê todos, como administrador`
                : `${items.length} servidor${items.length === 1 ? '' : 'es'} seu${items.length === 1 ? '' : 's'}`}
          </p>
        </div>
      </div>

      <div className={`grid gap-5 ${podeCriar ? 'lg:grid-cols-[1fr_340px]' : ''}`}>
        <Panel title="Servidores" icon={<ServerIcon />}>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Servidor</th>
                  <th>Estado</th>
                  <th className="num hidden sm:table-cell">Skills</th>
                  <th className="num hidden sm:table-cell">Chaves</th>
                  <th className="hidden md:table-cell">Dono</th>
                  <th className="hidden lg:table-cell">Atualizado</th>
                </tr>
              </thead>
              <tbody>
                {items.map((mcp) => (
                  <tr key={mcp.uuid} className={mcp.isActive ? undefined : 'is-off'}>
                    <td>
                      <Link to={`/mcps/${mcp.slug}`} className="block">
                        <span className="row-title">{mcp.name}</span>
                        <span className="row-sub break-all">/virtual/{mcp.slug}/mcp</span>
                      </Link>
                    </td>
                    <td>
                      <div className="flex flex-wrap items-center gap-1.5 whitespace-nowrap">
                        <span className={`badge ${mcp.isActive ? 'public' : 'private'}`}>
                          <span className="dot" />
                          {mcp.isActive ? 'ligado' : 'desligado'}
                        </span>
                        {mcp.isOpen && (
                          <span
                            className={`badge surface ${mcp.privateSkillCount > 0 ? 'off' : ''}`}
                            title={
                              mcp.privateSkillCount > 0
                                ? `Aberto com ${mcp.privateSkillCount} skill(s) privada(s) legível(is) sem chave`
                                : 'Sem chave: qualquer cliente conecta'
                            }
                          >
                            aberto
                          </span>
                        )}
                      </div>
                    </td>
                    <td
                      className="num hidden whitespace-nowrap sm:table-cell"
                      title={
                        mcp.privateSkillCount > 0
                          ? `${mcp.privateSkillCount} delas privada(s)`
                          : undefined
                      }
                    >
                      {mcp.skillCount}
                      {mcp.privateSkillCount > 0 && (
                        // `.row-sub` é `display: block` (é a segunda linha de
                        // uma célula); aqui ela é o resto da mesma linha.
                        <span className="row-sub !mt-0 inline"> · {mcp.privateSkillCount} priv.</span>
                      )}
                    </td>
                    <td className="num hidden sm:table-cell">{mcp.activeKeyCount}</td>
                    <td className="hidden md:table-cell">
                      <span className="row-sub">{mcp.ownerEmail ?? 'sem dono (só admin)'}</span>
                    </td>
                    <td className="hidden lg:table-cell">
                      <span className="row-sub whitespace-nowrap">{formatDateTime(mcp.updatedAt)}</span>
                    </td>
                  </tr>
                ))}
                {!loading && items.length === 0 && (
                  <tr>
                    <td colSpan={6}>
                      <p className="list-empty">
                        {podeCriar
                          ? 'Nenhum MCP virtual ainda. Crie o primeiro ao lado.'
                          : 'Nenhum MCP virtual é seu. Um administrador pode transferir um para você.'}
                      </p>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Panel>

        {podeCriar && (
          <Panel title="Novo MCP virtual" icon={<PlusIcon />}>
            <form onSubmit={submit} className="grid gap-4">
              <Field label="Nome">
                <input
                  className="field"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Ex.: Time de dados"
                />
              </Field>
              <Field label="Slug" hint="Vira o endereço: /virtual/<slug>/mcp. Gerado do nome se ficar vazio.">
                <input
                  className="field mono"
                  value={slug}
                  onChange={(event) => setSlug(event.target.value)}
                  placeholder="time-de-dados"
                />
              </Field>
              <Field label="Descrição" hint="Vai para as instruções do servidor: é como o agente sabe do que este MCP trata.">
                <textarea
                  className="field"
                  rows={3}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="Skills do projeto X, para quem trabalha no repositório Y."
                />
              </Field>
              <Button type="submit" disabled={busy || !name.trim()}>
                Criar
              </Button>
              <p className="panel-hint">
                O servidor nasce ligado, sem skills e exigindo chave. Você é o dono: só você e os
                administradores mexem nele.
              </p>
            </form>
          </Panel>
        )}
      </div>

      {canManageUsers(user.role) && !user.legacy && <PublicKeysPanel />}
    </>
  );
}

/**
 * Chaves `psp_` do MCP principal — a terceira forma de protegê-lo
 * (`docs/08-mcp-virtual.md` §7). Só admin; e só valem quando o mcp-public
 * roda com `MCP_PUBLIC_AUTH=managed`, o que o painel não tem como saber.
 */
function PublicKeysPanel() {
  const toast = useToast();
  const [keys, setKeys] = useState<PublicMcpKeySummary[]>([]);
  const [name, setName] = useState('');
  const [issued, setIssued] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setKeys((await getPublicKeys()).items);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await createPublicKey(name);
      setIssued(result.token);
      setName('');
      await load();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(key: PublicMcpKeySummary) {
    if (!window.confirm(`Revogar a chave "${key.name}"? Quem a estiver usando perde o acesso.`)) return;
    try {
      await revokePublicKey(key.id);
      toast.success('Chave revogada.');
      await load();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  return (
    <Panel title="Chaves do MCP principal" icon={<KeyIcon />} className="mt-5">
      <p className="panel-hint">
        Chaves <code>psp_…</code> para o MCP público principal (<code>/mcp</code>). Só valem com{' '}
        <code>MCP_PUBLIC_AUTH=managed</code> no mcp-public — nesse modo a <code>MCP_PUBLIC_KEY</code>,
        se definida, continua valendo também. Não abrem MCP virtual nenhum.
      </p>

      <form onSubmit={submit} className="flex max-w-xl gap-2">
        <input
          className="field"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Nome da chave (ex.: agentes do time X)"
          aria-label="Nome da chave"
        />
        <Button type="submit" disabled={busy || !name.trim()}>
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
              <tr key={key.id} className={key.revokedAt ? 'is-off' : undefined}>
                <td>
                  <span className="row-title">{key.name}</span>
                  <span className="row-sub">
                    psp_{key.prefix}_… · criada em {formatDateTime(key.createdAt)}
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
                    <button type="button" className="row-action" title="Revogar chave" onClick={() => void revoke(key)}>
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
  );
}

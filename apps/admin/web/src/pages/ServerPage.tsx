import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, KeyRound, LayoutTemplate, Radio, Settings, Trash2 } from 'lucide-react';
import {
  canManageVirtualMcp,
  createMcpKey,
  deleteMcp,
  formatDateTime,
  getMcp,
  getMcpKeys,
  getMcpSessions,
  getUsers,
  revokeMcpKey,
  updateMcp,
  type Session,
  type SessionUser,
  type UserSummary,
  type VirtualMcpDetail,
  type VirtualMcpKeySummary,
} from '../api.js';
import { Button, CopyButton, Field, McpStateBadges, Panel, Skel, Tabs, useConfirm } from '../components/ui.js';
import { useToast } from '../components/Toast.js';
import { useRegisterCommands } from '../components/commands.js';
import { SessionsTable } from '../components/SessionsTable.js';
import { ServerCanvas } from '../components/canvas/ServerCanvas.js';

/**
 * Um servidor MCP virtual: o canvas (skills ligadas às portas), as sessões,
 * as chaves e a configuração. Quem chega aqui é o dono ou um admin — o
 * servidor recusa os demais.
 */
export function ServerPage({ session, user }: { session: Session; user: SessionUser }) {
  const { slug = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const [detail, setDetail] = useState<VirtualMcpDetail | null>(null);

  const load = useCallback(async () => {
    try {
      setDetail(await getMcp(slug));
    } catch (err) {
      toast.error((err as Error).message);
      navigate('/mcps');
    }
  }, [slug, toast, navigate]);

  useEffect(() => {
    setDetail(null);
    void load();
  }, [load]);

  const tail = location.pathname.slice(`/mcps/${slug}`.length).replace(/^\//, '');
  const tab = tail === 'sessoes' || tail === 'chaves' || tail === 'configuracoes' ? tail : 'canvas';
  const canEdit = detail ? canManageVirtualMcp(user.role, detail.ownerUserUuid, user.uuid) : false;
  const base = session.mcpPublicUrl || 'https://<MCP_PUBLIC_URL>';

  useRegisterCommands(
    detail
      ? [
          { id: 'mcp-canvas', label: 'Ir para o canvas', group: 'Ir para', icon: <LayoutTemplate />, run: () => navigate(`/mcps/${detail.slug}`) },
          { id: 'mcp-sessions', label: 'Sessões deste servidor', group: 'Ir para', icon: <Radio />, run: () => navigate(`/mcps/${detail.slug}/sessoes`) },
          { id: 'mcp-keys', label: 'Chaves deste servidor', group: 'Ir para', icon: <KeyRound />, run: () => navigate(`/mcps/${detail.slug}/chaves`) },
          { id: 'mcp-settings', label: 'Configurações deste servidor', group: 'Ir para', icon: <Settings />, run: () => navigate(`/mcps/${detail.slug}/configuracoes`) },
        ]
      : [],
    [detail?.slug],
  );

  if (!detail) {
    return (
      <div className="p-6">
        <Skel h={20} w={140} className="mb-3" />
        <Skel h={32} w={320} className="mb-5" />
        <Skel h="60vh" />
      </div>
    );
  }

  return (
    <>
      <div className="stage-head">
        <div className="tt">
          <Link to="/mcps" className="icon-btn" title="Servidores MCP">
            <ArrowLeft />
          </Link>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1>{detail.name}</h1>
              <McpStateBadges mcp={detail} />
            </div>
            <div className="url">
              {base}/virtual/{detail.slug}/mcp
              {detail.isDefault && ` · ${base}/mcp`}
              {' · '}
              {detail.skillCount} skill{detail.skillCount === 1 ? '' : 's'} · dono: {detail.ownerEmail ?? 'nenhum (só admin)'}
            </div>
          </div>
        </div>
        <Tabs
          className="in-stage !mb-0 !border-0"
          value={tab}
          items={[
            { key: 'canvas', label: 'Canvas', icon: <LayoutTemplate />, to: `/mcps/${detail.slug}` },
            { key: 'sessoes', label: 'Sessões', icon: <Radio />, to: `/mcps/${detail.slug}/sessoes`, count: detail.onlineSessions || undefined },
            { key: 'chaves', label: 'Chaves', icon: <KeyRound />, to: `/mcps/${detail.slug}/chaves`, count: detail.activeKeyCount || undefined },
            { key: 'configuracoes', label: 'Configurações', icon: <Settings />, to: `/mcps/${detail.slug}/configuracoes` },
          ]}
        />
      </div>

      <Routes>
        <Route
          index
          element={
            <ServerCanvas
              detail={detail}
              onDetail={setDetail}
              canEdit={canEdit}
              onlineWindowMs={session.onlineWindowMs}
              onOpenSessions={() => navigate(`/mcps/${detail.slug}/sessoes`)}
            />
          }
        />
        <Route
          path="sessoes"
          element={
            <div className="stage-body">
              <div className="page wide">
                <SessionsTable load={(query) => getMcpSessions(detail.slug, query)} onlineWindowMs={session.onlineWindowMs} />
              </div>
            </div>
          }
        />
        <Route
          path="chaves"
          element={
            <div className="stage-body">
              <div className="page">
                <KeysPanel mcp={detail} canEdit={canEdit} base={base} />
              </div>
            </div>
          }
        />
        <Route
          path="configuracoes"
          element={
            <div className="stage-body">
              <div className="page">
                <SettingsPanel mcp={detail} user={user} canEdit={canEdit} onSaved={setDetail} />
              </div>
            </div>
          }
        />
      </Routes>
    </>
  );
}

// --------------------------------------------------------------- chaves ----

function KeysPanel({ mcp, canEdit, base }: { mcp: VirtualMcpDetail; canEdit: boolean; base: string }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [keys, setKeys] = useState<VirtualMcpKeySummary[] | null>(null);
  const [name, setName] = useState('');
  const [issued, setIssued] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setKeys((await getMcpKeys(mcp.slug)).items);
    } catch (err) {
      toast.error((err as Error).message);
      setKeys([]);
    }
  }, [mcp.slug, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await createMcpKey(mcp.slug, name);
      setIssued(result.token);
      setName('');
      await load();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(key: VirtualMcpKeySummary) {
    const ok = await confirm({
      title: `Revogar a chave "${key.name}"?`,
      description: 'Quem a estiver usando perde o acesso na chamada seguinte.',
      confirmLabel: 'Revogar',
      danger: true,
    });
    if (!ok) return;
    try {
      await revokeMcpKey(mcp.slug, key.id);
      toast.success('Chave revogada.');
      await load();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  const url = `${base}/virtual/${mcp.slug}/mcp`;
  const snippet = JSON.stringify(
    {
      mcpServers: {
        [mcp.slug]: {
          type: 'http',
          url,
          ...(mcp.isOpen ? {} : { headers: { Authorization: 'Bearer <cole aqui a chave psv_…>' } }),
        },
      },
    },
    null,
    2,
  );

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)]">
      <Panel title="Chaves de acesso" icon={<KeyRound />}>
        <p className="panel-hint">
          A chave é <strong>deste servidor</strong>, não de uma pessoa: vale só em <code>/virtual/{mcp.slug}/</code>
          {mcp.isDefault && ' e em /mcp'} e não abre o MCP administrativo.
          {mcp.isOpen && ' Este servidor está aberto: as chaves continuam valendo, mas ninguém precisa delas.'}
        </p>

        {canEdit && (
          <form onSubmit={submit} className="flex gap-2">
            <input className="field" value={name} onChange={(event) => setName(event.target.value)} placeholder="Nome da chave (ex.: CI do projeto X)" aria-label="Nome da chave" />
            <Button type="submit" disabled={busy || !name.trim()}>
              Emitir
            </Button>
          </form>
        )}

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
              {(keys ?? []).map((key) => (
                <tr key={key.id} className={key.revokedAt ? 'is-off' : undefined}>
                  <td>
                    <span className="row-title">{key.name}</span>
                    <span className="row-sub">
                      psv_{key.prefix}_… · criada em {formatDateTime(key.createdAt)}
                      {key.revokedAt && ' · revogada'}
                    </span>
                  </td>
                  <td className="hidden sm:table-cell">
                    <span className="row-sub">{key.lastUsedAt ? formatDateTime(key.lastUsedAt) : 'nunca usada'}</span>
                  </td>
                  <td className="num">
                    {!key.revokedAt && canEdit && (
                      <button type="button" className="row-action danger" title="Revogar chave" onClick={() => void revoke(key)}>
                        <Trash2 />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {keys !== null && keys.length === 0 && (
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

      <Panel title="Conectar" icon={<Settings />} actions={<CopyButton text={snippet} label="Copiar" />}>
        <p className="panel-hint">
          Cole no <code>mcp.json</code> do cliente{mcp.isOpen ? '.' : ' e troque o placeholder pela chave emitida.'}
          {!base.startsWith('http') || base.includes('<') ? (
            <>
              {' '}
              Defina <code>MCP_PUBLIC_URL</code> no <code>.env</code> para o endereço sair completo.
            </>
          ) : null}
        </p>
        <div className="snippet">
          <pre>{snippet}</pre>
        </div>
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------- configuração ---

function SettingsPanel({ mcp, user, canEdit, onSaved }: { mcp: VirtualMcpDetail; user: SessionUser; canEdit: boolean; onSaved: (detail: VirtualMcpDetail) => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const [name, setName] = useState(mcp.name);
  const [slug, setSlug] = useState(mcp.slug);
  const [description, setDescription] = useState(mcp.description);
  const [isOpen, setIsOpen] = useState(mcp.isOpen);
  const [isActive, setIsActive] = useState(mcp.isActive);
  const [owner, setOwner] = useState(mcp.ownerUserUuid ?? '');
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setName(mcp.name);
    setSlug(mcp.slug);
    setDescription(mcp.description);
    setIsOpen(mcp.isOpen);
    setIsActive(mcp.isActive);
    setOwner(mcp.ownerUserUuid ?? '');
  }, [mcp]);

  useEffect(() => {
    if (user.role !== 'admin' || user.legacy) return;
    getUsers()
      .then((data) => setUsers(data.items))
      .catch(() => void 0);
  }, [user.role, user.legacy]);

  const dirty =
    name !== mcp.name ||
    slug !== mcp.slug ||
    description !== mcp.description ||
    isOpen !== mcp.isOpen ||
    isActive !== mcp.isActive ||
    owner !== (mcp.ownerUserUuid ?? '');

  async function save(event: FormEvent) {
    event.preventDefault();
    if (mcp.isDefault && !isActive && mcp.isActive) {
      const ok = await confirm({
        title: 'Desligar o MCP padrão?',
        description: 'Este servidor responde em /mcp. Desligado, /mcp passa a responder 404 até religá-lo ou escolher outro padrão.',
        confirmLabel: 'Desligar',
        danger: true,
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const saved = await updateMcp(mcp.slug, {
        name: name !== mcp.name ? name : undefined,
        slug: slug !== mcp.slug ? slug : undefined,
        description: description !== mcp.description ? description : undefined,
        isOpen: isOpen !== mcp.isOpen ? isOpen : undefined,
        isActive: isActive !== mcp.isActive ? isActive : undefined,
        ...(user.role === 'admin' && owner !== (mcp.ownerUserUuid ?? '') ? { ownerUserUuid: owner || null } : {}),
      });
      onSaved(saved);
      toast.success('Servidor salvo.');
      if (saved.slug !== mcp.slug) navigate(`/mcps/${saved.slug}/configuracoes`, { replace: true });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    const ok = await confirm({
      title: `Remover o servidor "${mcp.name}"?`,
      description: `As chaves e os vínculos somem; as skills continuam no catálogo.${mcp.isDefault ? ' Ele é o MCP padrão: /mcp passa a responder 404.' : ''}`,
      confirmLabel: 'Remover',
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteMcp(mcp.slug);
      toast.success('Servidor removido.');
      navigate('/mcps');
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,320px)]">
      <Panel title="Configuração" icon={<Settings />}>
        <form onSubmit={save} className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Nome">
              <input className="field" value={name} onChange={(event) => setName(event.target.value)} disabled={!canEdit} />
            </Field>
            <Field label="Slug" hint="Mudar o slug muda o endereço: clientes configurados com o antigo param de conectar.">
              <input className="field field-mono" value={slug} onChange={(event) => setSlug(event.target.value)} disabled={!canEdit} />
            </Field>
          </div>
          <Field label="Descrição" hint="Vai para as instruções do servidor: é como o agente sabe do que este MCP trata.">
            <textarea className="field" rows={3} value={description} onChange={(event) => setDescription(event.target.value)} disabled={!canEdit} />
          </Field>
          <label className="check">
            <input type="checkbox" checked={isOpen} onChange={(event) => setIsOpen(event.target.checked)} disabled={!canEdit} />
            Aberto: qualquer cliente conecta sem chave, e o site lista o servidor e as skills dele
          </label>
          <label className="check">
            <input type="checkbox" checked={isActive} onChange={(event) => setIsActive(event.target.checked)} disabled={!canEdit} />
            Ligado: desligado, tudo sob o endereço dele responde 404 (chaves e vínculos ficam)
          </label>
          {user.role === 'admin' && !user.legacy && (
            <Field label="Dono" hint="Só um administrador transfere o dono. Sem dono, só administradores mexem no servidor.">
              <select className="field" value={owner} onChange={(event) => setOwner(event.target.value)}>
                <option value="">— sem dono (só admin) —</option>
                {users.map((item) => (
                  <option key={item.uuid} value={item.uuid}>
                    {item.name} ({item.email}){item.isActive ? '' : ' · desativada'}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {canEdit && (
            <div className="flex items-center gap-3">
              <Button type="submit" disabled={busy || !dirty}>
                Salvar
              </Button>
              {dirty && <span className="row-sub">Alterações ainda não salvas.</span>}
            </div>
          )}
        </form>
      </Panel>

      <div className="grid content-start gap-4">
        <Panel title="Sobre" icon={<Settings />}>
          <dl className="kv">
            <dt>Criado em</dt>
            <dd>{formatDateTime(mcp.createdAt)}</dd>
            <dt>Atualizado</dt>
            <dd>{formatDateTime(mcp.updatedAt)}</dd>
            <dt>Skills</dt>
            <dd>
              {mcp.skillCount} ({mcp.toolCount} tools, {mcp.resourceCount} resources, {mcp.promptCount} prompts)
            </dd>
            <dt>Padrão</dt>
            <dd>{mcp.isDefault ? 'sim — responde em /mcp' : 'não'}</dd>
          </dl>
        </Panel>
        {canEdit && (
          <Panel title="Zona de perigo" icon={<Trash2 />}>
            <p className="panel-hint">Remover apaga o servidor, as chaves e os vínculos. As skills continuam no catálogo.</p>
            <Button variant="danger" onClick={() => void remove()}>
              <Trash2 /> Remover servidor
            </Button>
          </Panel>
        )}
      </div>
    </div>
  );
}

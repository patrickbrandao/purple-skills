import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, KeyRound, LayoutTemplate, Radio, Settings, Trash2, Users } from 'lucide-react';
import {
  canEdit as canEditAccess,
  canManage,
  canOwn,
  createMcpKey,
  deleteMcp,
  formatDateTime,
  getMcp,
  getMcpKeys,
  getMcpOnline,
  getMcpSessions,
  revokeMcpKey,
  updateMcp,
  type Session,
  type SessionUser,
  type VirtualMcpDetail,
  type VirtualMcpKeySummary,
} from '../api.js';
import { Button, CopyButton, EmptyRow, Field, McpStateBadges, Panel, Skel, Tabs, useConfirm } from '../components/ui.js';
import { AccessBadge, AccessTab, accessSentence } from '../components/AccessPanel.js';
import { useToast } from '../components/Toast.js';
import { useRegisterCommands } from '../components/commands.js';
import { SessionsTable } from '../components/SessionsTable.js';
import { ServerCanvas } from '../components/canvas/ServerCanvas.js';

/**
 * Um servidor MCP virtual: o canvas (skills ligadas às portas), as sessões,
 * as chaves, o acesso (dono e concessões) e a configuração. O que a sessão pode vem em `access`
 * (`docs/12-acesso-granular.md` §3.2): `view` lê o canvas; `edit` mexe nos
 * vínculos; `manage` vê sessões e chaves e muda a configuração; o dono apaga.
 */
export function ServerPage({ session, user }: { session: Session; user: SessionUser }) {
  const { slug = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const [detail, setDetail] = useState<VirtualMcpDetail | null>(null);

  // Fora de um data router, `navigate` muda a cada troca de caminho: se a carga
  // dependesse dele, cada troca de guia buscaria o servidor de novo, piscaria o
  // esqueleto e remontaria o canvas.
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  // Uma carga por servidor. O cleanup descarta a resposta atrasada: trocando de
  // servidor com a página montada, a do anterior podia chegar por último.
  useEffect(() => {
    let active = true;
    setDetail(null);
    getMcp(slug)
      .then((fresh) => active && setDetail(fresh))
      .catch((err) => {
        if (!active) return;
        toast.error((err as Error).message);
        navigateRef.current('/mcps');
      });
    return () => {
      active = false;
    };
  }, [slug, toast]);

  // Estável entre renders: a `SessionsTable` recomeça (esqueleto e consulta)
  // quando a `load` muda, e esta página renderiza de novo a cada abertura ou
  // fechamento do ⌘K — o valor do `CommandContext`, que `useRegisterCommands`
  // consome, muda junto. Fica aqui em cima porque hook não vem depois do
  // `if (!detail)`.
  const sessionsSlug = detail?.slug ?? slug;
  const loadSessions = useCallback(
    (query: { online?: boolean; limit: number; offset: number }) => getMcpSessions(sessionsSlug, query),
    [sessionsSlug],
  );

  // Trocar de guia não recarrega mais o servidor: o que uma guia muda e outra
  // mostra precisa chegar ao detalhe por aqui. Devolve o mesmo objeto quando o
  // total não mudou, para não renderizar à toa.
  const onActiveKeys = useCallback((activeKeyCount: number) => {
    setDetail((current) => (current && current.activeKeyCount !== activeKeyCount ? { ...current, activeKeyCount } : current));
  }, []);

  const tail = location.pathname.slice(`/mcps/${slug}`.length).replace(/^\//, '');
  const tab = tail === 'sessoes' || tail === 'chaves' || tail === 'acesso' || tail === 'configuracoes' ? tail : 'canvas';
  const canEdit = detail ? canEditAccess(detail.access) : false;
  const manages = detail ? canManage(detail.access) : false;
  const base = session.mcpPublicUrl || 'https://<MCP_PUBLIC_URL>';

  // O selo da guia Sessões só andava em dia porque trocar de guia recarregava o
  // servidor inteiro. Agora a troca pede só o contador — sem esqueleto e sem
  // remontar o canvas. Em Configurações não: o formulário de lá se repõe quando
  // o detalhe muda, e um número novo chegando no meio da digitação a apagaria.
  // Falha aqui não importa: o número é informativo.
  const loadedSlug = detail?.slug;
  useEffect(() => {
    if (!loadedSlug || !manages || tab === 'configuracoes') return;
    let active = true;
    getMcpOnline(loadedSlug)
      .then(({ total }) => {
        if (active) setDetail((current) => (current && current.onlineSessions !== total ? { ...current, onlineSessions: total } : current));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [loadedSlug, manages, tab]);

  useRegisterCommands(
    detail
      ? [
          { id: 'mcp-canvas', label: 'Ir para o canvas', group: 'Ir para', icon: <LayoutTemplate />, run: () => navigate(`/mcps/${detail.slug}`) },
          ...(manages
            ? [
                { id: 'mcp-sessions', label: 'Sessões deste servidor', group: 'Ir para' as const, icon: <Radio />, run: () => navigate(`/mcps/${detail.slug}/sessoes`) },
                { id: 'mcp-keys', label: 'Chaves deste servidor', group: 'Ir para' as const, icon: <KeyRound />, run: () => navigate(`/mcps/${detail.slug}/chaves`) },
              ]
            : []),
          { id: 'mcp-access', label: 'Acesso a este servidor', group: 'Ir para', icon: <Users />, keywords: ['dono', 'compartilhar', 'concessão'], run: () => navigate(`/mcps/${detail.slug}/acesso`) },
          { id: 'mcp-settings', label: 'Configurações deste servidor', group: 'Ir para', icon: <Settings />, run: () => navigate(`/mcps/${detail.slug}/configuracoes`) },
        ]
      : [],
    [detail?.slug, manages],
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
              <AccessBadge object={detail} user={user} publicLabel="aberto" />
            </div>
            <div className="url">
              {base}/virtual/{detail.slug}/mcp
              {detail.isDefault && ` · ${base}/mcp`}
              {' · '}
              {detail.skillCount} skill{detail.skillCount === 1 ? '' : 's'}
              {detail.catalogCount > 0 && ` · ${detail.catalogCount} catálogo${detail.catalogCount === 1 ? '' : 's'}`} · dono:{' '}
              {detail.ownerEmail ?? 'nenhum (só admin)'}
              {user.role !== 'admin' && ` · ${accessSentence(detail.access)}`}
            </div>
          </div>
        </div>
        <Tabs
          className="in-stage !mb-0 !border-0"
          value={tab}
          items={[
            { key: 'canvas', label: 'Canvas', icon: <LayoutTemplate />, to: `/mcps/${detail.slug}` },
            // Sessões (IPs, nomes de chave) e chaves são operação: só `manage`.
            ...(manages
              ? [
                  { key: 'sessoes', label: 'Sessões', icon: <Radio />, to: `/mcps/${detail.slug}/sessoes`, count: detail.onlineSessions || undefined },
                  { key: 'chaves', label: 'Chaves', icon: <KeyRound />, to: `/mcps/${detail.slug}/chaves`, count: detail.activeKeyCount || undefined },
                ]
              : []),
            { key: 'acesso', label: 'Acesso', icon: <Users />, to: `/mcps/${detail.slug}/acesso` },
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
        {manages && (
          <Route
            path="sessoes"
            element={
              <div className="stage-body">
                <div className="page wide">
                  <SessionsTable load={loadSessions} onlineWindowMs={session.onlineWindowMs} />
                </div>
              </div>
            }
          />
        )}
        {manages && (
          <Route
            path="chaves"
            element={
              <div className="stage-body">
                <div className="page">
                  <KeysPanel mcp={detail} canEdit={manages} base={base} onActiveKeys={onActiveKeys} />
                </div>
              </div>
            }
          />
        )}
        <Route
          path="acesso"
          element={
            <div className="stage-body">
              <div className="page wide">
                <AccessTab
                  kind="mcp"
                  object={detail}
                  user={user}
                  mode="live"
                  onPatch={(body) => updateMcp(detail.slug, body)}
                  onChanged={setDetail}
                  visibility={<OpenState mcp={detail} manages={manages} />}
                />
              </div>
            </div>
          }
        />
        <Route
          path="configuracoes"
          element={
            <div className="stage-body">
              <div className="page">
                <SettingsPanel mcp={detail} onSaved={setDetail} />
              </div>
            </div>
          }
        />
      </Routes>
    </>
  );
}

// --------------------------------------------------------------- chaves ----

function KeysPanel({
  mcp,
  canEdit,
  base,
  onActiveKeys,
}: {
  mcp: VirtualMcpDetail;
  canEdit: boolean;
  base: string;
  /** Quantas chaves valem agora: o selo da guia e a gaveta do canvas leem do detalhe da página. */
  onActiveKeys: (count: number) => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [keys, setKeys] = useState<VirtualMcpKeySummary[] | null>(null);
  const [name, setName] = useState('');
  const [issued, setIssued] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const { items } = await getMcpKeys(mcp.slug);
      setKeys(items);
      // A mesma conta do servidor (`revoked_at IS NULL`). Antes o total só se
      // corrigia porque trocar de guia recarregava o servidor inteiro.
      onActiveKeys(items.filter((key) => !key.revokedAt).length);
    } catch (err) {
      toast.error((err as Error).message);
      setKeys([]);
    }
  }, [mcp.slug, toast, onActiveKeys]);

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
              {keys !== null && keys.length === 0 && <EmptyRow colSpan={3}>Nenhuma chave ainda</EmptyRow>}
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

/**
 * O "público" de um servidor é o aberto (`docs/12` decisão 4), que mora na
 * configuração: na guia Acesso ele só é dito.
 */
function OpenState({ mcp, manages }: { mcp: VirtualMcpDetail; manages: boolean }) {
  return (
    <>
      <p className="mb-0">
        {mcp.isOpen ? (
          <>
            <strong>Aberto</strong>: qualquer cliente conecta sem chave, e o site lista o servidor e as skills dele — toda
            skill dentro fica pública por aqui.
          </>
        ) : (
          <>
            <strong>Fechado</strong>: o cliente precisa de uma chave <code>psv_</code> deste servidor; no painel, só o dono, os
            administradores e as contas com concessão o veem.
          </>
        )}
      </p>
      {!mcp.isActive && <p className="hint">Desligado: tudo sob o endereço dele responde 404.</p>}
      <p className="hint">
        {manages ? (
          <>
            Abrir e fechar é em <Link to={`/mcps/${mcp.slug}/configuracoes`} className="link">Configurações</Link>.
          </>
        ) : (
          'Só quem administra o servidor o abre ou fecha.'
        )}
      </p>
    </>
  );
}

/** Nome, slug, descrição, aberto e ligado são `manage`; apagar é do dono; o dono e as concessões ficam na guia Acesso. */
function SettingsPanel({ mcp, onSaved }: { mcp: VirtualMcpDetail; onSaved: (detail: VirtualMcpDetail) => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const canEdit = canManage(mcp.access);
  const owns = canOwn(mcp.access);
  const [name, setName] = useState(mcp.name);
  const [slug, setSlug] = useState(mcp.slug);
  const [description, setDescription] = useState(mcp.description);
  const [isOpen, setIsOpen] = useState(mcp.isOpen);
  const [isActive, setIsActive] = useState(mcp.isActive);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setName(mcp.name);
    setSlug(mcp.slug);
    setDescription(mcp.description);
    setIsOpen(mcp.isOpen);
    setIsActive(mcp.isActive);
  }, [mcp]);

  const dirty =
    name !== mcp.name ||
    slug !== mcp.slug ||
    description !== mcp.description ||
    isOpen !== mcp.isOpen ||
    isActive !== mcp.isActive;

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
      description: `As chaves e os vínculos somem; as skills e os catálogos continuam existindo.${mcp.isDefault ? ' Ele é o MCP padrão: /mcp passa a responder 404.' : ''}`,
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
            <span>
              Aberto: qualquer cliente conecta sem chave, e o site lista o servidor e as skills dele
              {isOpen && !mcp.isOpen && mcp.skillCount + mcp.catalogCount > 0 && (
                <span className="hint block">
                  Ao abrir, toda skill dentro — direta ou por catálogo — fica pública por aqui, mesmo as privadas.
                </span>
              )}
            </span>
          </label>
          <label className="check">
            <input type="checkbox" checked={isActive} onChange={(event) => setIsActive(event.target.checked)} disabled={!canEdit} />
            Ligado: desligado, tudo sob o endereço dele responde 404 (chaves e vínculos ficam)
          </label>
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
            <dt>Catálogos</dt>
            <dd>
              {mcp.catalogCount}
              {mcp.catalogs.length > 0 && ` (${mcp.catalogs.map((catalog) => catalog.name).join(', ')})`}
            </dd>
            <dt>Padrão</dt>
            <dd>{mcp.isDefault ? 'sim — responde em /mcp' : 'não'}</dd>
            <dt>Dono</dt>
            <dd>
              {mcp.ownerEmail ?? 'nenhum (só administradores)'} ·{' '}
              <Link to={`/mcps/${mcp.slug}/acesso`} className="link">
                acesso
              </Link>
            </dd>
          </dl>
        </Panel>
        {owns && (
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

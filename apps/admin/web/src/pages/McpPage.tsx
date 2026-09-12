import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  createMcpKey,
  deleteMcp,
  formatDateTime,
  getMcp,
  getMcpKeys,
  getUsers,
  listSkills,
  revokeMcpKey,
  setMcpSkills,
  updateMcp,
  type Session,
  type SessionUser,
  type SkillSummary,
  type UserSummary,
  type VirtualMcpDetail,
  type VirtualMcpKeySummary,
  type VirtualMcpSkillInput,
} from '../api.js';
import { Button, Field, Panel } from '../components/ui.js';
import {
  ArrowLeftIcon,
  CopyIcon,
  KeyIcon,
  SearchIcon,
  ServerIcon,
  StackIcon,
  TrashIcon,
} from '../components/Icons.js';
import { useToast } from '../components/Toast.js';
import { SURFACES } from '../components/SkillMcps.js';

type SkillLink = VirtualMcpSkillInput & { name: string };

/**
 * Um MCP virtual: configuração, skills vinculadas (com as três superfícies
 * escolhidas por vínculo), chaves e o snippet para conectar. Quem chega aqui
 * é o dono ou um admin — o servidor recusa os demais.
 */
export function McpPage({ session, user }: { session: Session; user: SessionUser }) {
  const { slug = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();

  const [mcp, setMcp] = useState<VirtualMcpDetail | null>(null);
  const [keys, setKeys] = useState<VirtualMcpKeySummary[]>([]);
  const [users, setUsers] = useState<UserSummary[]>([]);

  const load = useCallback(async () => {
    try {
      const [detail, issued] = await Promise.all([getMcp(slug), getMcpKeys(slug)]);
      setMcp(detail);
      setKeys(issued.items);
    } catch (err) {
      toast.error((err as Error).message);
      navigate('/mcps');
    }
  }, [slug, toast, navigate]);

  useEffect(() => {
    setMcp(null);
    void load();
  }, [load]);

  useEffect(() => {
    if (user.role !== 'admin') return;
    getUsers()
      .then((data) => setUsers(data.items))
      .catch(() => void 0);
  }, [user.role]);

  if (!mcp) return <div className="skel-block" style={{ height: '18rem' }} />;

  return (
    <>
      <div className="page-head">
        <div className="min-w-0">
          <Link to="/mcps" className="back-link">
            <ArrowLeftIcon /> MCPs virtuais
          </Link>
          <h1 className="display mt-1 flex flex-wrap items-center gap-3">
            <span className="truncate">{mcp.name}</span>
            <span className={`badge ${mcp.isActive ? 'public' : 'private'}`}>
              <span className="dot" />
              {mcp.isActive ? 'ligado' : 'desligado'}
            </span>
            {mcp.isDefault && (
              <span className="badge surface" title="Responde também em /mcp, o MCP público desta instalação">
                padrão
              </span>
            )}
            {mcp.isOpen && (
              <span className="badge surface" title="Sem chave: qualquer cliente conecta, e o site o lista">
                aberto
              </span>
            )}
          </h1>
          <p className="sub mono flex flex-wrap items-center gap-x-3">
            <span className="break-all">/virtual/{mcp.slug}/mcp</span>
            <span>
              · {mcp.skillCount} skill{mcp.skillCount === 1 ? '' : 's'}
            </span>
            <span>· dono: {mcp.ownerEmail ?? 'nenhum (só admin)'}</span>
          </p>
        </div>
      </div>

      {/* `minmax(0,…)` nas duas colunas: sem isso o `min-width: auto` do grid
          deixa o snippet de `mcp.json`, que não quebra linha, esticar a coluna
          da direita e empurrar a página inteira para fora da viewport. */}
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)]">
        <div className="grid min-w-0 content-start gap-5">
          <SkillsPanel mcp={mcp} onSaved={setMcp} />
          <KeysPanel mcp={mcp} keys={keys} onChanged={load} />
        </div>
        <div className="grid min-w-0 content-start gap-5">
          <ConnectPanel mcp={mcp} mcpPublicUrl={session.mcpPublicUrl} />
          <SettingsPanel mcp={mcp} user={user} users={users} onSaved={setMcp} />
        </div>
      </div>
    </>
  );
}

// -------------------------------------------------------------- skills ----

function SkillsPanel({
  mcp,
  onSaved,
}: {
  mcp: VirtualMcpDetail;
  onSaved: (detail: VirtualMcpDetail) => void;
}) {
  const toast = useToast();
  const [links, setLinks] = useState<SkillLink[]>(() => fromDetail(mcp));
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SkillSummary[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setLinks(fromDetail(mcp));
  }, [mcp]);

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    const timer = setTimeout(() => {
      listSkills({ q: query, limit: 20 })
        .then((data) => setResults(data.items))
        .catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  const linked = useMemo(() => new Set(links.map((link) => link.slug)), [links]);
  const dirty = useMemo(() => JSON.stringify(links) !== JSON.stringify(fromDetail(mcp)), [links, mcp]);

  function add(skill: SkillSummary) {
    // Nasce nas ferramentas — a porta que o agente descobre sozinho. As outras
    // duas ficam para quem quiser; salvar sem nenhuma é recusado abaixo.
    setLinks((current) => [
      ...current,
      { slug: skill.slug, name: skill.name, asSkill: true, asPrompt: false, asResource: false },
    ]);
  }

  function toggle(slug: string, key: 'asSkill' | 'asPrompt' | 'asResource') {
    setLinks((current) =>
      current.map((link) => (link.slug === slug ? { ...link, [key]: !link[key] } : link)),
    );
  }

  async function save() {
    const semSuperficie = links.filter((link) => !link.asSkill && !link.asPrompt && !link.asResource);
    if (semSuperficie.length > 0) {
      toast.error(
        `Escolha ao menos uma superfície para: ${semSuperficie.map((link) => link.slug).join(', ')}.`,
      );
      return;
    }

    setBusy(true);
    try {
      const saved = await setMcpSkills(
        mcp.slug,
        links.map(({ slug, asSkill, asPrompt, asResource }) => ({ slug, asSkill, asPrompt, asResource })),
      );
      onSaved(saved);
      toast.success('Skills do MCP virtual salvas.');
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Skills publicadas" icon={<StackIcon />}>
      <p className="panel-hint">
        Qualquer skill do catálogo entra. Para cada uma, marque por quais superfícies ela sai{' '}
        <strong>neste servidor</strong>: é o vínculo que a exibe — uma skill sem vínculo nenhum não
        aparece em lugar algum. A mesma lista também se edita na página de cada skill.
      </p>

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Skill</th>
              <th>Superfícies</th>
              <th className="num hidden sm:table-cell">Acessos</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {links.map((link) => {
              const stats = mcp.skills.find((skill) => skill.slug === link.slug);
              return (
                <tr key={link.slug}>
                  <td>
                    <Link to={`/skills/${link.slug}`} className="row-title">
                      {link.name}
                    </Link>
                    <span className="row-sub">{link.slug}</span>
                  </td>
                  <td>
                    <div className="flex flex-wrap gap-2">
                      {SURFACES.map((surface) => (
                        <label key={surface.key} className="flex cursor-pointer items-center gap-1 text-xs" title={surface.title}>
                          <input
                            type="checkbox"
                            checked={link[surface.key]}
                            onChange={() => toggle(link.slug, surface.key)}
                          />
                          {surface.label}
                        </label>
                      ))}
                    </div>
                  </td>
                  <td className="num hidden sm:table-cell">
                    {stats ? `${stats.viewCount} / ${stats.downloadCount}` : '—'}
                  </td>
                  <td className="num">
                    <button
                      type="button"
                      className="row-action"
                      title="Tirar deste MCP"
                      onClick={() => setLinks((current) => current.filter((item) => item.slug !== link.slug))}
                    >
                      <TrashIcon />
                    </button>
                  </td>
                </tr>
              );
            })}
            {links.length === 0 && (
              <tr>
                <td colSpan={4}>
                  <p className="list-empty">Nenhuma skill ainda. Busque abaixo para adicionar.</p>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <label className="search-bar mt-4 block">
        <SearchIcon />
        <span className="sr-only">Buscar skills para adicionar</span>
        <input
          type="search"
          className="field"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Buscar skill para adicionar…"
        />
      </label>

      {results.filter((skill) => !linked.has(skill.slug)).length > 0 && (
        <ul className="mt-2 grid gap-1">
          {results
            .filter((skill) => !linked.has(skill.slug))
            .map((skill) => (
              <li key={skill.uuid} className="flex items-center justify-between gap-3 text-sm">
                <span className="min-w-0 truncate">
                  {skill.name}{' '}
                  <span className="row-sub">
                    {skill.slug}
                    {skill.mcps.length === 0 ? ' · sem vínculo' : ` · em ${skill.mcps.length} MCP(s)`}
                  </span>
                </span>
                <button type="button" className="link-action" onClick={() => add(skill)}>
                  Adicionar
                </button>
              </li>
            ))}
        </ul>
      )}

      <div className="mt-4 flex items-center gap-3">
        <Button type="button" disabled={busy || !dirty} onClick={() => void save()}>
          Salvar skills
        </Button>
        {dirty && <span className="row-sub">Alterações ainda não salvas.</span>}
      </div>
    </Panel>
  );
}

function fromDetail(mcp: VirtualMcpDetail): SkillLink[] {
  return mcp.skills.map((skill) => ({
    slug: skill.slug,
    name: skill.name,
    asSkill: skill.asSkill,
    asPrompt: skill.asPrompt,
    asResource: skill.asResource,
  }));
}

// --------------------------------------------------------------- chaves ----

function KeysPanel({
  mcp,
  keys,
  onChanged,
}: {
  mcp: VirtualMcpDetail;
  keys: VirtualMcpKeySummary[];
  onChanged: () => Promise<void>;
}) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [issued, setIssued] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await createMcpKey(mcp.slug, name);
      setIssued(result.token);
      setName('');
      await onChanged();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(key: VirtualMcpKeySummary) {
    if (!window.confirm(`Revogar a chave "${key.name}"? Quem a estiver usando perde o acesso.`)) return;
    try {
      await revokeMcpKey(mcp.slug, key.id);
      toast.success('Chave revogada.');
      await onChanged();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  return (
    <Panel title="Chaves de acesso" icon={<KeyIcon />}>
      <p className="panel-hint">
        A chave é <strong>deste servidor</strong>, não de uma pessoa: vale só em{' '}
        <code>/virtual/{mcp.slug}/</code> e não abre o MCP principal nem o administrativo.
        {mcp.isOpen && ' Este servidor está aberto: as chaves continuam valendo, mas ninguém precisa delas.'}
      </p>

      <form onSubmit={submit} className="flex gap-2">
        <input
          className="field"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Nome da chave (ex.: CI do projeto X)"
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
                    psv_{key.prefix}_… · criada em {formatDateTime(key.createdAt)}
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

// ------------------------------------------------------------- conectar ----

function ConnectPanel({ mcp, mcpPublicUrl }: { mcp: VirtualMcpDetail; mcpPublicUrl: string }) {
  const toast = useToast();
  const base = mcpPublicUrl || 'https://<MCP_PUBLIC_URL>';
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
    <Panel title="Conectar" icon={<ServerIcon />}>
      <p className="panel-hint">
        Cole no <code>mcp.json</code> do cliente
        {mcp.isOpen ? '.' : ' e troque o placeholder pela chave emitida.'}
        {!mcpPublicUrl && (
          <>
            {' '}
            Defina <code>MCP_PUBLIC_URL</code> no <code>.env</code> para o endereço sair completo.
          </>
        )}
      </p>
      {/* O JSON não quebra linha: rola dentro do próprio bloco, e o botão de
          copiar fica fixo fora da área rolável. */}
      <div className="snippet">
        <pre>{snippet}</pre>
        <button
          type="button"
          className="row-action"
          title="Copiar"
          onClick={() => {
            void navigator.clipboard?.writeText(snippet);
            toast.success('Snippet copiado.');
          }}
        >
          <CopyIcon />
        </button>
      </div>
      <p className="panel-hint mt-3 break-words">
        Também respondem <code>{url}/stateless</code> e o SSE legado em{' '}
        <code>/virtual/{mcp.slug}/sse</code>. Os downloads de <code>download_skill</code> aceitam a
        mesma chave.
      </p>
      {mcp.isDefault && (
        <p className="panel-hint mt-3 break-words">
          Este é o <strong>MCP padrão</strong>: responde também em <code>{base}/mcp</code>, o endereço
          do MCP público desta instalação, com as mesmas skills, chaves e regra de acesso.
        </p>
      )}
    </Panel>
  );
}

// ------------------------------------------------------------- ajustes ----

function SettingsPanel({
  mcp,
  user,
  users,
  onSaved,
}: {
  mcp: VirtualMcpDetail;
  user: SessionUser;
  users: UserSummary[];
  onSaved: (detail: VirtualMcpDetail) => void;
}) {
  const toast = useToast();
  const navigate = useNavigate();
  const [name, setName] = useState(mcp.name);
  const [slug, setSlug] = useState(mcp.slug);
  const [description, setDescription] = useState(mcp.description);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setName(mcp.name);
    setSlug(mcp.slug);
    setDescription(mcp.description);
  }, [mcp]);

  async function patch(body: Parameters<typeof updateMcp>[1], successMessage: string) {
    setBusy(true);
    try {
      const saved = await updateMcp(mcp.slug, body);
      onSaved(saved);
      toast.success(successMessage);
      if (saved.slug !== mcp.slug) navigate(`/mcps/${saved.slug}`, { replace: true });
      return true;
    } catch (err) {
      toast.error((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (
      slug !== mcp.slug &&
      !window.confirm(
        `Trocar o slug muda o endereço para /virtual/${slug}/mcp. Todo cliente configurado com o endereço antigo para de funcionar. Continuar?`,
      )
    ) {
      return;
    }
    await patch({ name, slug, description }, 'MCP virtual atualizado.');
  }

  async function remove() {
    const aviso = mcp.isDefault
      ? ' Ele é o MCP padrão: /mcp passa a responder 404 até outro ser escolhido em Configurações.'
      : '';
    if (!window.confirm(`Remover o MCP virtual "${mcp.name}", seus vínculos e suas chaves? Irreversível.${aviso}`)) return;
    try {
      await deleteMcp(mcp.slug);
      toast.success('MCP virtual removido.');
      navigate('/mcps');
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  return (
    <Panel title="Configuração" icon={<ServerIcon />}>
      <form onSubmit={submit} className="grid gap-4">
        <Field label="Nome">
          <input className="field" value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="Slug" hint="Muda o endereço: avise quem já conectou.">
          <input className="field mono" value={slug} onChange={(event) => setSlug(event.target.value)} />
        </Field>
        <Field label="Descrição" hint="Entra nas instruções que o agente recebe ao conectar.">
          <textarea
            className="field"
            rows={3}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
        <Button type="submit" disabled={busy}>
          Salvar
        </Button>
      </form>

      <div className="mt-5 grid gap-3">
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={mcp.isOpen}
            disabled={busy}
            onChange={(event) =>
              void patch(
                { isOpen: event.target.checked },
                event.target.checked ? 'Servidor aberto: não exige mais chave.' : 'Servidor fechado: exige chave.',
              )
            }
          />
          <span className="min-w-0">
            <span className="block text-sm">Aberto, sem chave</span>
            <span className="row-sub block">
              Qualquer cliente conecta sem credencial, e o site passa a listar este servidor e as
              skills dele. Aberto é público.
            </span>
          </span>
        </label>

        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={mcp.isActive}
            disabled={busy}
            onChange={(event) =>
              void patch(
                { isActive: event.target.checked },
                event.target.checked ? 'Servidor ligado.' : 'Servidor desligado: responde 404 até religar.',
              )
            }
          />
          <span className="min-w-0">
            <span className="block text-sm">Ligado</span>
            <span className="row-sub block">
              Desligado, tudo sob /virtual/{mcp.slug} responde 404. As chaves ficam.
              {mcp.isDefault && ' Como é o MCP padrão, /mcp também passa a responder 404.'}
            </span>
          </span>
        </label>

        {user.role === 'admin' && (
          <Field label="Dono" hint="Só administradores transferem. Sem dono, só admin administra.">
            <select
              className="field"
              value={mcp.ownerUserUuid ?? ''}
              disabled={busy}
              onChange={(event) =>
                void patch({ ownerUserUuid: event.target.value || null }, 'Dono atualizado.')
              }
            >
              <option value="">— sem dono —</option>
              {users.map((option) => (
                <option key={option.uuid} value={option.uuid}>
                  {option.name} ({option.email}){option.isActive ? '' : ' · desativada'}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>

      <div className="mt-5">
        <Button type="button" variant="danger" onClick={() => void remove()}>
          <TrashIcon /> Remover MCP virtual
        </Button>
      </div>
    </Panel>
  );
}

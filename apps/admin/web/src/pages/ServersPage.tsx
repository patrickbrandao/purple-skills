import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ChevronDown, LayoutGrid, List, Plus, Search, Star } from 'lucide-react';
import {
  canCreate,
  canManageUsers,
  createMcp,
  formatRelative,
  getMcps,
  getStats,
  num,
  type AccessScope,
  type Session,
  type SessionUser,
  type VirtualMcpSummary,
} from '../api.js';
import { AccessBadge } from '../components/AccessPanel.js';
import { Button, EmptyRow, Field, Kbd, McpStateBadges, Menu, MenuItem, Modal, Skel, Status, useStored } from '../components/ui.js';
import { Honeycomb } from '../components/Honeycomb.js';
import { usePalette, useRegisterCommands } from '../components/commands.js';
import { useToast } from '../components/Toast.js';

type Sort = 'skills' | 'name' | 'online' | 'updated';
const SORT_LABEL: Record<Sort, string> = {
  skills: 'Quantidade de skills',
  name: 'Nome',
  online: 'Clientes online',
  updated: 'Atualização',
};
type Scope = 'todos' | AccessScope;
const SCOPE_LABEL: Record<Scope, string> = { todos: 'Tudo que vejo', mine: 'Meus', shared: 'Compartilhados comigo', public: 'Abertos' };

/**
 * A home do painel: os servidores MCP virtuais como cards, cada um com a
 * miniatura das skills e o estado. Admin vê todos; os demais, só os seus. Um
 * deles pode ser o padrão — o que responde em `/mcp`.
 */
export function ServersPage({ session, user }: { session: Session; user: SessionUser }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { open: openPalette } = usePalette();
  const podeCriar = canCreate(user.role);
  const [items, setItems] = useState<VirtualMcpSummary[] | null>(null);
  const scope = (params.get('acesso') as Scope | null) ?? 'todos';
  const [openSkills, setOpenSkills] = useState<number | null>(null);
  const [sort, setSort] = useStored<Sort>('purple-skills-admin:mcps-sort', 'skills');
  const [view, setView] = useStored<'grid' | 'list'>('purple-skills-admin:mcps-view', 'grid');
  const [favorites, setFavorites] = useStored<string[]>('purple-skills-admin:mcps-favorites', []);
  const creating = params.get('novo') === '1';

  // Uma busca por recorte. O cleanup descarta a resposta atrasada: trocando de
  // recorte depressa, a consulta antiga podia chegar por último e repor a lista
  // do recorte anterior sob o filtro novo — e aqui nada recarrega sozinho.
  useEffect(() => {
    let active = true;
    Promise.all([getMcps(scope === 'todos' ? '' : scope), getStats().catch(() => null)])
      .then(([list, stats]) => {
        if (!active) return;
        setItems(list.items);
        if (stats) setOpenSkills(stats.openSkills);
      })
      .catch((err) => {
        if (!active) return;
        toast.error((err as Error).message);
        setItems([]);
      });
    return () => {
      active = false;
    };
  }, [toast, scope]);

  useRegisterCommands(
    [{ id: 'mcps-view', label: view === 'grid' ? 'Ver servidores em lista' : 'Ver servidores em cards', group: 'Recurso', icon: view === 'grid' ? <List /> : <LayoutGrid />, run: () => setView(view === 'grid' ? 'list' : 'grid') }],
    [view],
  );

  const sorted = useMemo(() => {
    const list = [...(items ?? [])];
    const fav = new Set(favorites);
    list.sort((a, b) => {
      const fa = fav.has(a.uuid) ? 0 : 1;
      const fb = fav.has(b.uuid) ? 0 : 1;
      if (fa !== fb) return fa - fb;
      switch (sort) {
        case 'name':
          return a.name.localeCompare(b.name);
        case 'online':
          return b.onlineSessions - a.onlineSessions || b.skillCount - a.skillCount;
        case 'updated':
          return b.updatedAt.localeCompare(a.updatedAt);
        default:
          return b.skillCount - a.skillCount || a.name.localeCompare(b.name);
      }
    });
    return list;
  }, [items, sort, favorites]);

  function toggleFavorite(mcp: VirtualMcpSummary) {
    setFavorites((current) => (current.includes(mcp.uuid) ? current.filter((id) => id !== mcp.uuid) : [...current, mcp.uuid]));
  }

  const online = (items ?? []).reduce((sum, mcp) => sum + mcp.onlineSessions, 0);

  return (
    <div className="page">
      <div className="page-head">
        <h1>Servidores MCP</h1>
        <div className="page-actions">
          <button type="button" className="search-trigger" onClick={() => openPalette()}>
            <Search />
            <span className="ph">Procurar MCP</span>
            <span className="keys">
              <Kbd>⌘</Kbd>
              <Kbd>K</Kbd>
            </span>
          </button>
          {podeCriar && (
            <Button onClick={() => setParams({ novo: '1' })}>
              <Plus /> Novo vMCP
            </Button>
          )}
        </div>
      </div>

      <div className="meta-line">
        <span className="stat">
          <LayoutGrid />
          {/* `openSkills` nulo é "não veio" (a busca dos números é tolerada a
              falha): a frase some, em vez de anunciar "0 Skills publicadas". */}
          {items
            ? `${num(items.length)} Servidor${items.length === 1 ? '' : 'es'}${openSkills === null ? '' : `, ${num(openSkills)} Skills publicadas`}${online > 0 ? `, ${num(online)} online` : ''}`
            : 'Carregando…'}
        </span>
        <span className="sep" />
        <Menu
          trigger={(props) => (
            <button type="button" className="sort" {...props}>
              Ordenar por: <b>{SORT_LABEL[sort]}</b> <ChevronDown />
            </button>
          )}
        >
          {(Object.keys(SORT_LABEL) as Sort[]).map((key) => (
            <MenuItem key={key} onSelect={() => setSort(key)}>
              {SORT_LABEL[key]}
            </MenuItem>
          ))}
        </Menu>
        {user.role !== 'admin' && (
          <Menu
            trigger={(props) => (
              <button type="button" className="sort" {...props}>
                Acesso: <b>{SCOPE_LABEL[scope]}</b> <ChevronDown />
              </button>
            )}
          >
            {(Object.keys(SCOPE_LABEL) as Scope[]).map((key) => (
              <MenuItem key={key} onSelect={() => setParams(key === 'todos' ? {} : { acesso: key })}>
                {SCOPE_LABEL[key]}
              </MenuItem>
            ))}
          </Menu>
        )}
        <span className="end">
          <div className="segmented icons">
            <button type="button" className={view === 'grid' ? 'active' : ''} onClick={() => setView('grid')} title="Cards">
              <LayoutGrid />
            </button>
            <button type="button" className={view === 'list' ? 'active' : ''} onClick={() => setView('list')} title="Lista">
              <List />
            </button>
          </div>
        </span>
      </div>

      {items === null && (
        <div className="card-grid">
          {[0, 1].map((i) => (
            <Skel key={i} h={288} />
          ))}
        </div>
      )}

      {items !== null && items.length > 0 && view === 'grid' && (
        <div className="card-grid">
          {sorted.map((mcp, index) => (
            <ServerCard key={mcp.uuid} mcp={mcp} user={user} index={index} favorite={favorites.includes(mcp.uuid)} onFavorite={() => toggleFavorite(mcp)} />
          ))}
        </div>
      )}

      {/* Sem servidores, a lista vale para as duas vistas: cards vazios não mostram nada. */}
      {items !== null && (items.length === 0 || view === 'list') && (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th />
                <th>Servidor</th>
                <th>Estado</th>
                <th className="num">Skills</th>
                <th className="num hidden sm:table-cell">Online</th>
                <th className="num hidden sm:table-cell">Chaves</th>
                <th className="hidden md:table-cell">Dono</th>
                <th className="hidden lg:table-cell">Atualizado</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((mcp) => (
                <tr key={mcp.uuid} className={mcp.isActive ? undefined : 'is-off'}>
                  <td style={{ width: 36 }}>
                    <button type="button" className={`row-action star${favorites.includes(mcp.uuid) ? ' on' : ''}`} onClick={() => toggleFavorite(mcp)} title="Favorito">
                      <Star fill={favorites.includes(mcp.uuid) ? 'currentColor' : 'none'} />
                    </button>
                  </td>
                  <td>
                    <Link to={`/mcps/${mcp.slug}`} className="block no-underline">
                      <span className="row-title">{mcp.name}</span>
                      <span className="row-sub">/virtual/{mcp.slug}/mcp</span>
                    </Link>
                  </td>
                  <td>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Status tone={mcp.isActive ? 'ok' : 'off'}>{mcp.isActive ? 'Online' : 'Desativado'}</Status>
                      <McpStateBadges mcp={mcp} withActive={false} />
                      <AccessBadge object={mcp} user={user} publicLabel="aberto" />
                    </div>
                  </td>
                  <td className="num">{mcp.skillCount}</td>
                  <td className="num hidden sm:table-cell">{mcp.onlineSessions}</td>
                  <td className="num hidden sm:table-cell">{mcp.activeKeyCount}</td>
                  <td className="hidden md:table-cell">
                    <span className="row-sub">{mcp.ownerEmail ?? 'sem dono (só admin)'}</span>
                  </td>
                  <td className="hidden lg:table-cell">
                    <span className="row-sub whitespace-nowrap">{formatRelative(mcp.updatedAt)}</span>
                  </td>
                </tr>
              ))}
              {sorted.length === 0 && <EmptyRow colSpan={8}>{scope !== 'todos' ? 'Nenhum servidor nesse recorte' : podeCriar ? 'Nenhum servidor ainda' : 'Nenhum servidor é seu, compartilhado com você ou aberto'}</EmptyRow>}
            </tbody>
          </table>
        </div>
      )}

      {canManageUsers(user.role) && items !== null && items.length > 0 && (
        <p className="panel-hint mt-5">
          Qual destes responde em <code>{session.mcpPublicUrl || '<MCP_PUBLIC_URL>'}/mcp</code>, o MCP público da instalação, é
          escolhido em <Link to="/configuracoes/mcp-padrao" className="link">Configurações → MCP padrão</Link>.
        </p>
      )}

      <NewServerModal
        open={creating && podeCriar}
        onClose={() => setParams({})}
        onCreated={(slug) => navigate(`/mcps/${slug}`)}
      />
    </div>
  );
}

function ServerCard({ mcp, user, index, favorite, onFavorite }: { mcp: VirtualMcpSummary; user: SessionUser; index: number; favorite: boolean; onFavorite: () => void }) {
  return (
    <Link to={`/mcps/${mcp.slug}`} className={`server-card${mcp.isActive ? '' : ' is-off'}`} style={{ animationDelay: `${Math.min(index, 8) * 30}ms` }}>
      <div className="head">
        <span className="nm">{mcp.name}</span>
        <McpStateBadges mcp={mcp} withActive={false} />
        <AccessBadge object={mcp} user={user} publicLabel="aberto" />
        <button
          type="button"
          className={`row-action star${favorite ? ' on' : ''}`}
          title={favorite ? 'Tirar dos favoritos' : 'Favoritar (fica no topo)'}
          onClick={(event) => {
            event.preventDefault();
            onFavorite();
          }}
        >
          <Star fill={favorite ? 'currentColor' : 'none'} />
        </button>
      </div>
      <div className="preview">
        {/* A colmeia: um hexágono por skill direta e por catálogo, até 19, e o "+N" com o resto. */}
        {mcp.skillCount + mcp.catalogCount > 0 ? (
          <Honeycomb mcp={mcp} />
        ) : (
          <span className="none">{mcp.isActive ? 'Nenhuma skill ainda' : ''}</span>
        )}
        <div className="foot">
          <Status tone={mcp.isActive ? 'ok' : 'off'}>{mcp.isActive ? 'Online' : 'Desativado'}</Status>
          {mcp.isActive && (
            <span className="counts">
              · {mcp.skillCount} Skills, {mcp.resourceCount} Resources, {mcp.promptCount} Prompts
              {mcp.catalogCount > 0 && `, ${mcp.catalogCount} Catálogo${mcp.catalogCount === 1 ? '' : 's'}`}
            </span>
          )}
          {mcp.onlineSessions > 0 && <span className="live">{mcp.onlineSessions} online</span>}
        </div>
      </div>
    </Link>
  );
}

function NewServerModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (slug: string) => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const created = await createMcp({ name, slug: slug.trim() || undefined, description: description.trim() || undefined, isOpen });
      toast.success(`Servidor "${created.name}" criado. Agora adicione skills no canvas.`);
      setName('');
      setSlug('');
      setDescription('');
      setIsOpen(false);
      onCreated(created.slug);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} title="Novo servidor MCP virtual" onClose={onClose}>
      <form onSubmit={submit} className="mt-3 grid gap-4">
        <Field label="Nome">
          <input className="field" value={name} onChange={(event) => setName(event.target.value)} placeholder="Ex.: Time de dados" autoFocus />
        </Field>
        <Field label="Slug" hint="Vira o endereço: /virtual/<slug>/mcp. Gerado do nome se ficar vazio.">
          <input className="field field-mono" value={slug} onChange={(event) => setSlug(event.target.value)} placeholder="time-de-dados" />
        </Field>
        <Field label="Descrição" hint="Vai para as instruções do servidor: é como o agente sabe do que este MCP trata.">
          <textarea className="field" rows={3} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Skills do projeto X, para quem trabalha no repositório Y." />
        </Field>
        <label className="check">
          <input type="checkbox" checked={isOpen} onChange={(event) => setIsOpen(event.target.checked)} />
          Aberto: qualquer cliente conecta sem chave, e o site lista o servidor
        </label>
        <p className="hint">
          O servidor nasce ligado e sem skills. Você é o dono: compartilhe-o em Configurações → Acesso para outras contas mexerem nele.
        </p>
        <div className="actions">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button type="submit" disabled={busy || !name.trim()}>
            {busy ? 'Criando…' : 'Criar'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

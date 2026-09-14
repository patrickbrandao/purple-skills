import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ChevronDown, LayoutGrid, List, Plus, Search, Table2, Trash2, Upload } from 'lucide-react';
import {
  canCreate,
  canOwn,
  deleteSkill,
  formatRelative,
  listSkills,
  num,
  type AccessScope,
  type SessionUser,
  type SkillSummary,
} from '../api.js';
import { AccessBadge } from '../components/AccessPanel.js';
import { Badge, EmptyRow, McpChips, Menu, MenuItem, Skel, noSite, useConfirm, useDebounced, useStored } from '../components/ui.js';
import { SkillIcon } from '../components/SkillIcon.js';
import { useRegisterCommands } from '../components/commands.js';
import { useToast } from '../components/Toast.js';

type Sort = 'recent' | 'score' | 'name';
type Filter = 'todas' | 'sem-vinculo' | 'no-site' | 'desligadas';
type Scope = 'todos' | AccessScope;

const SORT_LABEL: Record<Sort, string> = { recent: 'Atualização', score: 'Mais acessadas', name: 'Nome' };
const FILTER_LABEL: Record<Filter, string> = { todas: 'Todas', 'sem-vinculo': 'Sem vínculo', 'no-site': 'No site', desligadas: 'Desligadas' };
/** O recorte de acesso (`docs/12-acesso-granular.md` decisão 19): quem vê tudo não precisa dele. */
export const SCOPE_LABEL: Record<Scope, string> = { todos: 'Tudo que vejo', mine: 'Minhas', shared: 'Compartilhadas comigo', public: 'Públicas' };

export function SkillsPage({ user }: { user: SessionUser }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [params, setParams] = useSearchParams();
  const podeCriar = canCreate(user.role);
  const [items, setItems] = useState<SkillSummary[] | null>(null);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState('');
  const dq = useDebounced(query, 300);
  const [sort, setSort] = useStored<Sort>('purple-skills-admin:skills-sort', 'recent');
  const [view, setView] = useStored<'grid' | 'list'>('purple-skills-admin:skills-view', 'grid');
  const filter = (params.get('filtro') as Filter | null) ?? 'todas';
  const scope = (params.get('acesso') as Scope | null) ?? 'todos';

  const load = useCallback(async () => {
    try {
      const data = await listSkills({
        q: dq,
        limit: 100,
        sort: dq ? undefined : sort === 'name' ? undefined : sort,
        scope: scope === 'todos' ? '' : scope,
      });
      setItems(data.items);
      setTotal(data.total);
    } catch (err) {
      toast.error((err as Error).message);
      setItems([]);
    }
  }, [dq, sort, scope, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  useRegisterCommands(
    [
      { id: 'skills-grid', label: view === 'grid' ? 'Ver skills em lista' : 'Ver skills em cards', group: 'Recurso', icon: view === 'grid' ? <List /> : <LayoutGrid />, run: () => setView(view === 'grid' ? 'list' : 'grid') },
      { id: 'skills-unlinked', label: 'Mostrar skills sem vínculo', group: 'Recurso', icon: <Table2 />, run: () => setParams({ filtro: 'sem-vinculo' }) },
    ],
    [view],
  );

  const visible = useMemo(() => {
    let list = items ?? [];
    if (filter === 'sem-vinculo') list = list.filter((skill) => skill.mcps.length === 0);
    if (filter === 'no-site') list = list.filter(noSite);
    if (filter === 'desligadas') list = list.filter((skill) => !skill.isActive);
    if (sort === 'name') list = [...list].sort((a, b) => a.name.localeCompare(b.name));
    return list;
  }, [items, filter, sort]);

  const unlinked = (items ?? []).filter((skill) => skill.mcps.length === 0).length;
  const onSite = (items ?? []).filter(noSite).length;
  const off = (items ?? []).filter((skill) => !skill.isActive).length;

  async function remove(skill: SkillSummary) {
    const ok = await confirm({
      title: `Remover a skill "${skill.name}"?`,
      description: 'Todos os arquivos dela e os vínculos com servidores somem. Não dá para desfazer.',
      confirmLabel: 'Remover',
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteSkill(skill.slug);
      setItems((current) => (current ?? []).filter((item) => item.uuid !== skill.uuid));
      setTotal((current) => current - 1);
      toast.success(`"${skill.name}" removida.`);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1>Skills</h1>
        <div className="page-actions">
          <label className="search-bar">
            <Search />
            <input
              type="search"
              className="field"
              style={{ minWidth: 240 }}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Procurar skill"
            />
          </label>
          {podeCriar && (
            <>
              <Link to="/skills/new?modo=zip" className="btn btn-ghost">
                <Upload /> Importar
              </Link>
              <Link to="/skills/new" className="btn btn-primary">
                <Plus /> Nova skill
              </Link>
            </>
          )}
        </div>
      </div>

      <div className="meta-line">
        <span className="stat">
          <Table2 />
          {items
            ? `${num(total)} skill${total === 1 ? '' : 's'}, ${num(onSite)} no site, ${num(unlinked)} sem vínculo${off > 0 ? `, ${num(off)} desligada${off === 1 ? '' : 's'}` : ''}`
            : 'Carregando…'}
        </span>
        <span className="sep" />
        <Menu
          trigger={(props) => (
            <button type="button" className="sort" {...props}>
              Filtro: <b>{FILTER_LABEL[filter]}</b> <ChevronDown />
            </button>
          )}
        >
          {(Object.keys(FILTER_LABEL) as Filter[]).map((key) => (
            <MenuItem key={key} onSelect={() => setParams({ ...(key === 'todas' ? {} : { filtro: key }), ...(scope === 'todos' ? {} : { acesso: scope }) })}>
              {FILTER_LABEL[key]}
            </MenuItem>
          ))}
        </Menu>
        <Menu
          trigger={(props) => (
            <button type="button" className="sort" {...props}>
              Acesso: <b>{SCOPE_LABEL[scope]}</b> <ChevronDown />
            </button>
          )}
        >
          {(Object.keys(SCOPE_LABEL) as Scope[]).map((key) => (
            <MenuItem key={key} onSelect={() => setParams({ ...(filter === 'todas' ? {} : { filtro: filter }), ...(key === 'todos' ? {} : { acesso: key }) })}>
              {SCOPE_LABEL[key]}
            </MenuItem>
          ))}
        </Menu>
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
          {[0, 1, 2].map((i) => (
            <Skel key={i} h={168} />
          ))}
        </div>
      )}

      {items !== null && visible.length > 0 && view === 'grid' && (
        <div className="card-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
          {visible.map((skill, index) => (
            <Link key={skill.uuid} to={`/skills/${skill.slug}`} className="card flex flex-col gap-3 p-4 no-underline" style={{ animationDelay: `${Math.min(index, 12) * 25}ms` }}>
              <div className="flex items-start gap-3">
                <SkillIcon icon={skill.icon} name={skill.name} slug={skill.slug} />
                <div className="min-w-0 flex-1">
                  <span className="row-title truncate">{skill.name}</span>
                  <span className="row-sub truncate">{skill.slug}</span>
                </div>
                {canOwn(skill.access) && (
                  <button
                    type="button"
                    className="row-action danger"
                    title="Remover skill"
                    onClick={(event) => {
                      event.preventDefault();
                      void remove(skill);
                    }}
                  >
                    <Trash2 />
                  </button>
                )}
              </div>
              <p className="line-clamp-2 text-[12.5px]" style={{ color: 'var(--text-muted)', minHeight: 36 }}>
                {skill.description || 'Sem descrição.'}
              </p>
              <div className="mt-auto flex flex-wrap items-center gap-1.5">
                <AccessBadge object={skill} user={user} />
                <McpChips skill={skill} />
                {skill.tags.slice(0, 2).map((tag) => (
                  <Badge key={tag} tone="outline">{tag}</Badge>
                ))}
                <span className="ml-auto mono text-[11px]" style={{ color: 'var(--text-faint)' }} title={`${skill.viewCount} acessos · ${skill.downloadCount} downloads`}>
                  {num(skill.viewCount)} · {num(skill.downloadCount)}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}

      {/* Sem skills, a lista vale para as duas vistas: cards vazios não mostram nada. */}
      {items !== null && (visible.length === 0 || view === 'list') && (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Skill</th>
                <th className="hidden md:table-cell">Tags</th>
                <th>Publicada em</th>
                <th className="num hidden sm:table-cell">Acessos</th>
                <th className="num hidden sm:table-cell">Downloads</th>
                <th className="hidden lg:table-cell">Atualizada</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visible.map((skill) => (
                <tr key={skill.uuid} className={skill.isActive ? undefined : 'is-off'}>
                  <td>
                    <Link to={`/skills/${skill.slug}`} className="flex items-center gap-3 no-underline">
                      <SkillIcon icon={skill.icon} name={skill.name} slug={skill.slug} size="sm" />
                      <span className="min-w-0">
                        <span className="row-title">{skill.name}</span>
                        <span className="row-sub">{skill.slug}</span>
                      </span>
                    </Link>
                  </td>
                  <td className="hidden md:table-cell">
                    <div className="flex flex-wrap gap-1.5">
                      {skill.tags.slice(0, 3).map((tag) => (
                        <Badge key={tag} tone="outline">{tag}</Badge>
                      ))}
                    </div>
                  </td>
                  <td>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <AccessBadge object={skill} user={user} />
                      <McpChips skill={skill} />
                    </div>
                  </td>
                  <td className="num hidden sm:table-cell">{num(skill.viewCount)}</td>
                  <td className="num hidden sm:table-cell">{num(skill.downloadCount)}</td>
                  <td className="hidden lg:table-cell">
                    <span className="row-sub">{formatRelative(skill.updatedAt)}</span>
                  </td>
                  <td className="num">
                    {canOwn(skill.access) && (
                      <button type="button" className="row-action danger" onClick={() => void remove(skill)} title="Remover skill">
                        <Trash2 />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {visible.length === 0 && (
                <EmptyRow colSpan={7}>
                  {query ? 'Nenhuma skill encontrada' : filter !== 'todas' || scope !== 'todos' ? 'Nenhuma skill com esse filtro' : 'Nenhuma skill ainda'}
                </EmptyRow>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

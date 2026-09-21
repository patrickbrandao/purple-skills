import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { BookOpenCheck, ChevronDown, LayoutGrid, List, Plus, Search, Trash2, Upload } from 'lucide-react';
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
import { CloneButton, CloneDialog } from '../components/CloneDialog.js';
import { Badge, Button, EmptyRow, McpChips, Menu, MenuItem, Skel, noSite, useConfirm, useDebounced, useStored } from '../components/ui.js';
import { SkillIcon } from '../components/SkillIcon.js';
import { useRegisterCommands } from '../components/commands.js';
import { IMPORT_SKILL_PATH, NEW_SKILL_PATH } from '../components/shell/routes.js';
import { useToast } from '../components/Toast.js';

type Sort = 'recent' | 'score' | 'name';
type Filter = 'all' | 'unlinked' | 'on-site' | 'disabled';
type Scope = 'all' | AccessScope;

/**
 * O teto de uma consulta: `listSkills` do banco limita `limit` a 100, então a
 * lista alcança o resto acrescentando página por página ("Carregar mais") — é
 * o que mantém a busca, os filtros e os contadores desta tela, todos feitos no
 * cliente, falando do acervo inteiro e não das cem primeiras.
 */
const PAGE = 100;

const SORT_LABEL: Record<Sort, string> = { recent: 'Atualização', score: 'Mais acessadas', name: 'Nome' };
const FILTER_LABEL: Record<Filter, string> = { all: 'Todas', unlinked: 'Sem vínculo', 'on-site': 'No site', disabled: 'Desligadas' };
/** O recorte de acesso (`docs/12-acesso-granular.md` decisão 19): quem vê tudo não precisa dele. */
export const SCOPE_LABEL: Record<Scope, string> = { all: 'Tudo que vejo', mine: 'Minhas', shared: 'Compartilhadas comigo', public: 'Públicas' };

/**
 * A lista de skills. Com `mine`, é a "Minhas Skills" do Meu espaço: o recorte
 * de acesso fica preso em `mine` (as skills de que a conta é dona).
 */
export function SkillsPage({ user, mine = false }: { user: SessionUser; mine?: boolean }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [params, setParams] = useSearchParams();
  const podeCriar = canCreate(user.role);
  const [items, setItems] = useState<SkillSummary[] | null>(null);
  // A skill que o diálogo de clonagem está copiando; ele mora **aqui**, e não
  // no card, que é um `<a>` (`CloneDialog.tsx`).
  const [clonando, setClonando] = useState<SkillSummary | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  // Uma tentativa que falhou deixa o `offset` já no valor pedido: sem este
  // contador, clicar "Carregar mais" de novo não refaria a consulta.
  const [tentativa, setTentativa] = useState(0);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const dq = useDebounced(query, 300);
  const [sort, setSort] = useStored<Sort>('purple-skills-admin:skills-sort', 'recent');
  const [view, setView] = useStored<'grid' | 'list'>('purple-skills-admin:skills-view', 'grid');
  const filter = (params.get('filter') as Filter | null) ?? 'all';
  const scope: Scope = mine ? 'mine' : ((params.get('access') as Scope | null) ?? 'all');

  // Uma busca por interação: o cleanup descarta a resposta atrasada, senão a
  // consulta antiga chega por último e sobrescreve a nova. Busca, ordem e
  // recorte voltam ao começo (`setOffset(0)` em cada gatilho); com `offset`
  // maior que zero a página vem para o fim do que já está na tela.
  useEffect(() => {
    let active = true;
    setLoading(true);
    listSkills({
      q: dq,
      limit: PAGE,
      offset,
      sort: dq ? undefined : sort === 'name' ? undefined : sort,
      scope: scope === 'all' ? '' : scope,
    })
      .then((data) => {
        if (!active) return;
        setItems((current) =>
          offset === 0 || current === null
            ? data.items
            : // Uma skill criada entre duas páginas empurra as demais para a
              // frente: sem descartar o que já veio, a mesma linha voltaria com
              // chave repetida.
              [...current, ...data.items.filter((item) => !current.some((loaded) => loaded.uuid === item.uuid))],
        );
        setTotal(data.total);
        setLoading(false);
      })
      .catch((err) => {
        if (!active) return;
        toast.error((err as Error).message);
        setItems((current) => current ?? []);
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [dq, sort, scope, offset, tentativa, toast]);

  useRegisterCommands(
    [
      { id: 'skills-grid', label: view === 'grid' ? 'Ver skills em lista' : 'Ver skills em cards', group: 'Recurso', icon: view === 'grid' ? <List /> : <LayoutGrid />, run: () => setView(view === 'grid' ? 'list' : 'grid') },
      { id: 'skills-unlinked', label: 'Mostrar skills sem vínculo', group: 'Recurso', icon: <BookOpenCheck />, run: () => setParams({ filter: 'unlinked' }) },
    ],
    [view],
  );

  const visible = useMemo(() => {
    let list = items ?? [];
    if (filter === 'unlinked') list = list.filter((skill) => skill.mcps.length === 0);
    if (filter === 'on-site') list = list.filter(noSite);
    if (filter === 'disabled') list = list.filter((skill) => !skill.isActive);
    if (sort === 'name') list = [...list].sort((a, b) => a.name.localeCompare(b.name));
    return list;
  }, [items, filter, sort]);

  // Os contadores olham o que está carregado; o `total` vem do servidor.
  // Enquanto faltar página, a frase diz de qual universo cada número fala —
  // "250 skills, 80 no site" seria contraditório na mesma linha.
  const loaded = items?.length ?? 0;
  const truncated = items !== null && total > loaded;
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
        <h1>{mine ? 'Minhas Skills' : 'Skills'}</h1>
        <div className="page-actions">
          <label className="search-bar">
            <Search />
            <input
              type="search"
              className="field"
              style={{ minWidth: 240 }}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setOffset(0);
              }}
              placeholder="Procurar skill"
            />
          </label>
          {podeCriar && (
            <>
              <Link to={IMPORT_SKILL_PATH} className="btn btn-ghost">
                <Upload /> Importar
              </Link>
              <Link to={NEW_SKILL_PATH} className="btn btn-primary">
                <Plus /> Nova skill
              </Link>
            </>
          )}
        </div>
      </div>

      <div className="meta-line">
        <span className="stat">
          <BookOpenCheck />
          {items
            ? `${truncated ? `${num(loaded)} de ${num(total)} skills carregadas · nelas:` : `${num(total)} skill${total === 1 ? '' : 's'},`} ${num(onSite)} no site, ${num(unlinked)} sem vínculo${off > 0 ? `, ${num(off)} desligada${off === 1 ? '' : 's'}` : ''}`
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
          {/* Este filtro é peneira no cliente: não refaz a consulta, e por isso
              não volta ao começo — voltar jogaria fora justamente as páginas
              que ele precisa olhar. */}
          {(Object.keys(FILTER_LABEL) as Filter[]).map((key) => (
            <MenuItem key={key} onSelect={() => setParams({ ...(key === 'all' ? {} : { filter: key }), ...(mine || scope === 'all' ? {} : { access: scope }) })}>
              {FILTER_LABEL[key]}
            </MenuItem>
          ))}
        </Menu>
        {!mine && (
          <Menu
            trigger={(props) => (
              <button type="button" className="sort" {...props}>
                Acesso: <b>{SCOPE_LABEL[scope]}</b> <ChevronDown />
              </button>
            )}
          >
            {(Object.keys(SCOPE_LABEL) as Scope[]).map((key) => (
              <MenuItem
                key={key}
                onSelect={() => {
                  setParams({ ...(filter === 'all' ? {} : { filter }), ...(key === 'all' ? {} : { access: key }) });
                  setOffset(0);
                }}
              >
                {SCOPE_LABEL[key]}
              </MenuItem>
            ))}
          </Menu>
        )}
        <Menu
          trigger={(props) => (
            <button type="button" className="sort" {...props}>
              Ordenar por: <b>{SORT_LABEL[sort]}</b> <ChevronDown />
            </button>
          )}
        >
          {(Object.keys(SORT_LABEL) as Sort[]).map((key) => (
            <MenuItem
              key={key}
              onSelect={() => {
                setSort(key);
                setOffset(0);
              }}
            >
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
                <CloneButton kind="skill" object={skill} role={user.role} shape="linha" onClone={() => setClonando(skill)} />
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
                    <span className="row-actions">
                      <CloneButton kind="skill" object={skill} role={user.role} shape="linha" onClone={() => setClonando(skill)} />
                      {canOwn(skill.access) && (
                        <button type="button" className="row-action danger" onClick={() => void remove(skill)} title="Remover skill">
                          <Trash2 />
                        </button>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
              {visible.length === 0 && (
                <EmptyRow colSpan={7}>
                  {query ? 'Nenhuma skill encontrada' : mine && filter === 'all' ? 'Você ainda não é dono de nenhuma skill' : filter !== 'all' || scope !== 'all' ? 'Nenhuma skill com esse filtro' : 'Nenhuma skill ainda'}
                </EmptyRow>
              )}
            </tbody>
          </table>
        </div>
      )}

      {truncated && (
        <div className="mt-5 flex flex-col items-center gap-2">
          {/* A próxima página começa onde a lista termina, e não num múltiplo de
              PAGE: assim a remoção otimista de `remove()` não faz o servidor
              pular a skill que tomou o lugar da removida. */}
          <Button
            variant="ghost"
            onClick={() => {
              setOffset(loaded);
              setTentativa((current) => current + 1);
            }}
            disabled={loading}
          >
            {loading ? 'Carregando…' : `Carregar mais ${num(Math.min(PAGE, total - loaded))}`}
          </Button>
          <p className="panel-hint mb-0 text-center">
            A busca, o filtro e a ordenação por nome olham as {num(loaded)} skills já carregadas — cada consulta traz no
            máximo {PAGE}.
          </p>
        </div>
      )}

      {clonando && <CloneDialog kind="skill" origem={clonando} onClose={() => setClonando(null)} />}
    </div>
  );
}

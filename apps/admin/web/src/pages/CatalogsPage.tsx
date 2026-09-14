import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ChevronDown, Library, Plus, Search } from 'lucide-react';
import {
  canCreate,
  createCatalog,
  formatRelative,
  getCatalogs,
  num,
  type AccessScope,
  type CatalogSummary,
  type SessionUser,
} from '../api.js';
import { AccessBadge } from '../components/AccessPanel.js';
import { Badge, Button, EmptyRow, Field, Kbd, Menu, MenuItem, Modal, Skel, Status, useStored } from '../components/ui.js';
import { usePalette, useRegisterCommands } from '../components/commands.js';
import { useToast } from '../components/Toast.js';

type Sort = 'name' | 'skills' | 'mcps' | 'updated';
const SORT_LABEL: Record<Sort, string> = {
  name: 'Nome',
  skills: 'Skills ativas',
  mcps: 'Servidores',
  updated: 'Atualização',
};
type Scope = 'todos' | AccessScope;
const SCOPE_LABEL: Record<Scope, string> = { todos: 'Tudo que vejo', mine: 'Meus', shared: 'Compartilhados comigo', public: 'Públicos' };

/**
 * Os catálogos (`docs/11-catalogos.md` §6.1): admin vê todos, os demais só os
 * seus. Um catálogo é um grupo de skills que entra num servidor de uma vez;
 * a lista mostra quanto de cada um está de fato sendo entregue.
 */
export function CatalogsPage({ user }: { user: SessionUser }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { open: openPalette } = usePalette();
  const podeCriar = canCreate(user.role);
  const [items, setItems] = useState<CatalogSummary[] | null>(null);
  const [sort, setSort] = useStored<Sort>('purple-skills-admin:catalogs-sort', 'name');
  const creating = params.get('novo') === '1';
  const scope = (params.get('acesso') as Scope | null) ?? 'todos';

  const load = useCallback(async () => {
    try {
      setItems((await getCatalogs(scope === 'todos' ? '' : scope)).items);
    } catch (err) {
      toast.error((err as Error).message);
      setItems([]);
    }
  }, [toast, scope]);

  useEffect(() => {
    void load();
  }, [load]);

  useRegisterCommands([], []);

  const sorted = useMemo(() => {
    const list = [...(items ?? [])];
    list.sort((a, b) => {
      switch (sort) {
        case 'skills':
          return b.activeSkillCount - a.activeSkillCount || a.name.localeCompare(b.name);
        case 'mcps':
          return b.mcpCount - a.mcpCount || a.name.localeCompare(b.name);
        case 'updated':
          return b.updatedAt.localeCompare(a.updatedAt);
        default:
          return a.name.localeCompare(b.name);
      }
    });
    return list;
  }, [items, sort]);

  const activeTotal = (items ?? []).reduce((sum, catalog) => sum + catalog.activeSkillCount, 0);

  return (
    <div className="page">
      <div className="page-head">
        <h1>Catálogos</h1>
        <div className="page-actions">
          <button type="button" className="search-trigger" onClick={() => openPalette()}>
            <Search />
            <span className="ph">Procurar catálogo</span>
            <span className="keys">
              <Kbd>⌘</Kbd>
              <Kbd>K</Kbd>
            </span>
          </button>
          {podeCriar && (
            <Button onClick={() => setParams({ novo: '1' })}>
              <Plus /> Novo catálogo
            </Button>
          )}
        </div>
      </div>

      <div className="meta-line">
        <span className="stat">
          <Library />
          {items ? `${num(items.length)} catálogo${items.length === 1 ? '' : 's'}, ${num(activeTotal)} skills ativas` : 'Carregando…'}
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
      </div>

      {items === null && <Skel h={220} />}

      {items !== null && (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Catálogo</th>
                <th>Estado</th>
                <th className="num">Skills</th>
                <th className="num hidden sm:table-cell">Servidores</th>
                <th className="num hidden sm:table-cell">Acessos</th>
                <th className="hidden md:table-cell">Dono</th>
                <th className="hidden lg:table-cell">Atualizado</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((catalog) => (
                <tr key={catalog.uuid} className={catalog.isActive ? undefined : 'is-off'}>
                  <td>
                    <Link to={`/catalogos/${catalog.slug}`} className="block no-underline">
                      <span className="row-title">{catalog.name}</span>
                      <span className="row-sub">{catalog.description || catalog.slug}</span>
                    </Link>
                  </td>
                  <td>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Status tone={catalog.isActive ? 'ok' : 'off'}>{catalog.isActive ? 'Ligado' : 'Desligado'}</Status>
                      {catalog.isPublic && (
                        <Badge tone="outline" title="Público: qualquer conta e o site leem, com todos os membros">
                          público
                        </Badge>
                      )}
                      <AccessBadge object={catalog} user={user} publicLabel="público" />
                    </div>
                  </td>
                  <td className="num">
                    <span title={`${catalog.activeSkillCount} ativas de ${catalog.skillCount} membros`}>
                      {catalog.activeSkillCount}
                      {catalog.skillCount !== catalog.activeSkillCount && (
                        <span style={{ color: 'var(--text-faint)' }}> / {catalog.skillCount}</span>
                      )}
                    </span>
                  </td>
                  <td className="num hidden sm:table-cell">{catalog.mcpCount}</td>
                  <td className="num hidden sm:table-cell" title={`${catalog.viewCount} acessos · ${catalog.downloadCount} downloads`}>
                    {num(catalog.viewCount)}
                  </td>
                  <td className="hidden md:table-cell">
                    <span className="row-sub">{catalog.ownerEmail ?? 'sem dono (só admin)'}</span>
                  </td>
                  <td className="hidden lg:table-cell">
                    <span className="row-sub whitespace-nowrap">{formatRelative(catalog.updatedAt)}</span>
                  </td>
                </tr>
              ))}
              {sorted.length === 0 && <EmptyRow colSpan={7}>{scope !== 'todos' ? 'Nenhum catálogo nesse recorte' : podeCriar ? 'Nenhum catálogo ainda' : 'Nenhum catálogo é seu, compartilhado com você ou público'}</EmptyRow>}
            </tbody>
          </table>
        </div>
      )}

      {items !== null && items.length > 0 && (
        <p className="panel-hint mt-5">
          O número de skills é o que um servidor recebe: membros com a participação ativa e a skill ligada. Skills que estão no
          catálogo mas <Badge tone="danger">desligadas</Badge> aparecem com alerta na página do catálogo.
        </p>
      )}

      <NewCatalogModal open={creating && podeCriar} onClose={() => setParams({})} onCreated={(slug) => navigate(`/catalogos/${slug}`)} />
    </div>
  );
}

function NewCatalogModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (slug: string) => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [isPublic, setIsPublic] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const created = await createCatalog({ name, slug: slug.trim() || undefined, description: description.trim() || undefined, isPublic });
      toast.success(`Catálogo "${created.name}" criado. Agora adicione skills.`);
      setName('');
      setSlug('');
      setDescription('');
      setIsPublic(false);
      onCreated(created.slug);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} title="Novo catálogo" onClose={onClose}>
      <form onSubmit={submit} className="mt-3 grid gap-4">
        <Field label="Nome">
          <input className="field" value={name} onChange={(event) => setName(event.target.value)} placeholder="Ex.: Skills de dados" autoFocus />
        </Field>
        <Field label="Slug" hint="Identifica o catálogo na URL e nas tools. Gerado do nome se ficar vazio.">
          <input className="field field-mono" value={slug} onChange={(event) => setSlug(event.target.value)} placeholder="skills-de-dados" />
        </Field>
        <Field label="Descrição" hint="Para quem administra: do que este grupo trata.">
          <textarea className="field" rows={3} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="As skills que todo servidor do time de dados recebe." />
        </Field>
        <label className="check">
          <input type="checkbox" checked={isPublic} onChange={(event) => setIsPublic(event.target.checked)} />
          Público: qualquer conta e o site leem o catálogo, com todos os membros — inclusive skills privadas
        </label>
        <p className="hint">O catálogo nasce ligado e vazio. Você é o dono: compartilhe-o na página dele para outras contas mexerem.</p>
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

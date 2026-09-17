import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Library, Plus, Server, Trash2, Undo2 } from 'lucide-react';
import {
  canCreate,
  canEdit,
  getCatalogs,
  getMcps,
  type CatalogSummary,
  type LinkFlags,
  type SessionUser,
  type SkillDetail,
  type SkillLinkInput,
  type VirtualMcpSummary,
} from '../api.js';
import { directFlags, membership, noPorts, type CatalogDraft, type LinkDraft } from '../skillDrafts.js';
import { Badge, Button, EmptyRow, Panel, Skel, cx } from './ui.js';
import { usePalette } from './commands.js';
import { useToast } from './Toast.js';

/** As três portas de um vínculo, como o painel as rotula. */
export const SURFACES = [
  { key: 'asSkill' as const, label: 'Tools', title: 'Nas ferramentas: search_skills, get_skill…', port: 'tools' },
  { key: 'asResource' as const, label: 'Resources', title: 'Como resource skill://<slug>', port: 'resources' },
  { key: 'asPrompt' as const, label: 'Prompts', title: 'Como prompt, pelo slug (slash-command)', port: 'prompts' },
] as const;

/** Nasce nas ferramentas: é a porta que o agente descobre sozinho. */
export const DEFAULT_FLAGS: LinkFlags = { asSkill: true, asPrompt: false, asResource: false };

const NO_FLAGS: LinkFlags = { asSkill: false, asPrompt: false, asResource: false };

export const semPorta = noPorts;

const estadoDo = (mcp: { isOpen: boolean; isActive: boolean; isDefault: boolean }) =>
  [mcp.isActive ? (mcp.isOpen ? 'aberto' : 'exige chave') : 'desligado', mcp.isDefault && 'padrão']
    .filter(Boolean)
    .join(' · ');

export function FlagBoxes({ value, onChange, disabled }: { value: LinkFlags; onChange: (flags: LinkFlags) => void; disabled?: boolean }) {
  return (
    <div className="flex flex-wrap gap-3">
      {SURFACES.map((surface) => (
        <label key={surface.key} className="check" title={surface.title}>
          <input
            type="checkbox"
            checked={value[surface.key]}
            disabled={disabled}
            onChange={(event) => onChange({ ...value, [surface.key]: event.target.checked })}
          />
          <span className={`stage-legend-dot ${surface.port}`} />
          {surface.label}
        </label>
      ))}
    </div>
  );
}

/** As portas ligadas, em selos só de leitura. */
function FlagBadges({ value }: { value: LinkFlags }) {
  const on = SURFACES.filter((surface) => value[surface.key]);
  if (on.length === 0) return <span className="row-sub">—</span>;
  return (
    <span className="flex gap-1">
      {on.map((surface) => (
        <Badge key={surface.key} tone="outline">
          {surface.label}
        </Badge>
      ))}
    </span>
  );
}

/**
 * Os vMCPs em que a sessão pode publicar: os que ela **edita** (`docs/12`
 * §3.4). Admin edita todos; os demais, os seus e os concedidos com `edit`.
 */
function useEditableMcps(enabled = true) {
  const toast = useToast();
  const [mcps, setMcps] = useState<VirtualMcpSummary[] | null>(enabled ? null : []);

  useEffect(() => {
    if (!enabled) return;
    getMcps()
      .then((data) => setMcps(data.items.filter((mcp) => canEdit(mcp.access))))
      .catch((err) => {
        toast.error((err as Error).message);
        setMcps([]);
      });
  }, [toast, enabled]);

  return mcps;
}

// ------------------------------------------------------------ skill nova ---

/**
 * "Publicar em", para a skill nova e o import: controlado, sem chamar a API.
 * Só os vMCPs que a sessão edita aparecem. Sem nenhum marcado, a skill nasce
 * flutuante: existe e não é exibida em lugar nenhum.
 */
export function PublishInPicker({ value, onChange }: { value: SkillLinkInput[]; onChange: (links: SkillLinkInput[]) => void }) {
  const mcps = useEditableMcps();
  const bySlug = useMemo(() => new Map(value.map((link) => [link.slug, link])), [value]);

  function toggle(mcp: VirtualMcpSummary, on: boolean) {
    if (on) onChange([...value, { slug: mcp.slug, ...DEFAULT_FLAGS }]);
    else onChange(value.filter((link) => link.slug !== mcp.slug));
  }

  function setFlags(slug: string, flags: LinkFlags) {
    onChange(value.map((link) => (link.slug === slug ? { ...link, ...flags } : link)));
  }

  return (
    <div className="mt-5">
      <span className="label">Publicar em</span>
      <p className="panel-hint">
        A skill só é exibida — no site e nos servidores MCP — onde estiver publicada. Sem nenhum marcado, ela
        nasce sem vínculo e fica visível só aqui no painel; dá para publicar depois, na página dela, no canvas
        do servidor ou por um catálogo.
      </p>
      {mcps === null && <Skel h={48} />}
      {mcps !== null && (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th />
                <th>Servidor</th>
                <th>Portas</th>
              </tr>
            </thead>
            <tbody>
              {mcps.map((mcp) => {
                const link = bySlug.get(mcp.slug);
                return (
                  <tr key={mcp.uuid} className={mcp.isActive ? undefined : 'is-off'}>
                    <td className="num" style={{ width: 36 }}>
                      <input type="checkbox" checked={Boolean(link)} onChange={(event) => toggle(mcp, event.target.checked)} aria-label={`Publicar em ${mcp.name}`} />
                    </td>
                    <td>
                      <span className="row-title">{mcp.name}</span>
                      <span className="row-sub">
                        /virtual/{mcp.slug} · {estadoDo(mcp)}
                      </span>
                    </td>
                    <td>{link ? <FlagBoxes value={link} onChange={(flags) => setFlags(mcp.slug, flags)} /> : <span className="row-sub">—</span>}</td>
                  </tr>
                );
              })}
              {mcps.length === 0 && (
                <EmptyRow colSpan={3}>
                  Você não edita nenhum servidor. <Link to="/mcps?novo=1" className="link">Crie um</Link>, ou peça a um
                  administrador para publicar a skill.
                </EmptyRow>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------- skill existente ---

type LinkState = 'publish' | 'ports' | 'unlink' | null;

const LINK_PENDING: Record<Exclude<LinkState, null>, string> = {
  publish: 'publicada ao salvar',
  ports: 'portas mudam ao salvar',
  unlink: 'sai ao salvar',
};

function linkState(direct: LinkFlags | null, draft: LinkDraft | undefined): LinkState {
  if (!draft) return null;
  if (noPorts(draft)) return direct ? 'unlink' : null;
  if (!direct) return 'publish';
  const same = direct.asSkill === draft.asSkill && direct.asPrompt === draft.asPrompt && direct.asResource === draft.asResource;
  return same ? null : 'ports';
}

/**
 * "Publicada em", na página da skill: o vínculo pelo lado da skill. Cada
 * linha é um vMCP: os que a sessão edita têm as caixas de porta; os demais
 * em que a skill está aparecem só para leitura.
 *
 * Na edição (`drafts`), marcar e desmarcar não grava: vira pendência, e o
 * Salvar da página envia (`docs/13` decisão 21). Desmarcar todas as portas de
 * um vínculo direto tira a skill do servidor; marcar uma num servidor sem
 * vínculo direto publica.
 *
 * Um vMCP alcançado só por catálogo (`docs/11-catalogos.md` §3.2) aparece com
 * as portas do catálogo em selos e "via catálogo X". Quem edita o vMCP ainda
 * pode publicar direto — o vínculo direto sobrescreve o catálogo naquele
 * servidor, e é o jeito de restringir uma skill sem tirá-la do grupo.
 */
export function SkillMcpsPanel({
  skill,
  drafts,
  onDrafts,
}: {
  skill: SkillDetail;
  /** A edição: o estado desejado por uuid de vMCP. Sem ele, a ficha de leitura. */
  drafts?: Record<string, LinkDraft>;
  onDrafts?: (next: Record<string, LinkDraft>) => void;
}) {
  const readOnly = drafts === undefined || onDrafts === undefined;
  const editable = useEditableMcps(!readOnly);

  const linked = useMemo(() => new Map(skill.mcps.map((mcp) => [mcp.uuid, mcp])), [skill]);

  const rows = useMemo(() => {
    // Só leitura: nenhuma linha é editável, e só os servidores em que a skill está aparecem.
    const own = readOnly ? [] : (editable ?? []);
    const ownUuids = new Set(own.map((mcp) => mcp.uuid));
    const foreign = skill.mcps.filter((mcp) => !ownUuids.has(mcp.uuid));
    const all = [...own.map((mcp) => ({ ...mcp, editable: true })), ...foreign.map((mcp) => ({ ...mcp, editable: false }))];
    return all.sort((a, b) => {
      const la = linked.has(a.uuid) ? 0 : 1;
      const lb = linked.has(b.uuid) ? 0 : 1;
      return la - lb || a.name.localeCompare(b.name);
    });
  }, [editable, skill.mcps, linked, readOnly]);

  function setDraft(mcp: { uuid: string; slug: string; name: string }, flags: LinkFlags | null) {
    if (!drafts || !onDrafts) return;
    const { [mcp.uuid]: _old, ...others } = drafts;
    onDrafts(flags ? { ...others, [mcp.uuid]: { slug: mcp.slug, name: mcp.name, ...flags } } : others);
  }

  const pending = drafts ? rows.filter((mcp) => linkState(directFlags(skill, mcp.uuid), drafts[mcp.uuid]) !== null).length : 0;

  return (
    <Panel
      title="Publicada em"
      icon={<Server />}
      actions={pending > 0 ? <Badge tone="warn">{pending === 1 ? '1 pendência' : `${pending} pendências`}</Badge> : undefined}
    >
      <p className="panel-hint">
        A skill só é exibida — no site e nos servidores MCP — onde estiver publicada, direto ou por um catálogo.
        {readOnly
          ? ' As portas de cada servidor se mudam em Editar → Propriedades, ou no canvas do servidor.'
          : ' Marque as portas por servidor; desmarcar todas tira a skill dele. Nada é gravado até o botão Salvar. O mesmo vínculo aparece como aresta no canvas do servidor.'}
      </p>

      {editable === null && <Skel h={48} />}

      {editable !== null && (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Servidor</th>
                <th>Portas</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((mcp) => {
                const current = linked.get(mcp.uuid);
                const viaCatalog = current !== undefined && !current.direct;
                const direct = directFlags(skill, mcp.uuid);
                const draft = drafts?.[mcp.uuid];
                const state = linkState(direct, draft);
                const flags = draft ?? direct ?? NO_FLAGS;
                return (
                  <tr key={mcp.uuid} className={cx(!mcp.isActive && 'is-off', state && 'is-pending', state === 'unlink' && 'is-removed')}>
                    <td>
                      <Link to={`/mcps/${mcp.slug}`} className="row-title">
                        {mcp.name}
                      </Link>
                      <span className="row-sub">
                        /virtual/{mcp.slug} · {estadoDo(mcp)}
                        {current ? '' : ' · não publicada'}
                      </span>
                      {viaCatalog && (
                        <span className="row-sub flex flex-wrap items-center gap-1">
                          <Library style={{ width: 12, height: 12 }} /> via{' '}
                          {current.catalogs.map((catalog, index) => (
                            <span key={catalog.uuid}>
                              {index > 0 && ', '}
                              <Link to={`/catalogos/${catalog.slug}`} className="link">
                                {catalog.name}
                              </Link>
                            </span>
                          ))}
                        </span>
                      )}
                    </td>
                    <td>
                      {mcp.editable ? (
                        <>
                          <FlagBoxes value={flags} onChange={(next) => setDraft(mcp, next)} />
                          {viaCatalog && !draft && (
                            <span className="hint flex flex-wrap items-center gap-1">
                              Pelo catálogo: <FlagBadges value={current} /> Marcar aqui cria um vínculo direto, que passa a valer sozinho.
                            </span>
                          )}
                        </>
                      ) : (
                        <FlagBadges value={current ?? NO_FLAGS} />
                      )}
                    </td>
                    <td className="num whitespace-nowrap">
                      {mcp.editable && (
                        <span className="flex items-center justify-end gap-2">
                          {state && <Badge tone="warn">{LINK_PENDING[state]}</Badge>}
                          {draft && (
                            <button type="button" className="row-action" title="Desfazer" onClick={() => setDraft(mcp, null)}>
                              <Undo2 />
                            </button>
                          )}
                          {!direct && !draft && (
                            <Button size="sm" variant="ghost" onClick={() => setDraft(mcp, viaCatalog ? { asSkill: current.asSkill, asPrompt: current.asPrompt, asResource: current.asResource } : DEFAULT_FLAGS)}>
                              Publicar
                            </Button>
                          )}
                          {direct && state !== 'unlink' && (
                            <button type="button" className="row-action danger" title="Tirar deste servidor" onClick={() => setDraft(mcp, NO_FLAGS)}>
                              <Trash2 />
                            </button>
                          )}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <EmptyRow colSpan={3}>
                  {readOnly ? (
                    'Em nenhum servidor: a skill está flutuante e não é exibida em lugar nenhum.'
                  ) : (
                    <>
                      Você não edita nenhum servidor. <Link to="/mcps?novo=1" className="link">Crie um</Link>, ou peça a
                      um administrador para publicar a skill.
                    </>
                  )}
                </EmptyRow>
              )}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

// ------------------------------------------------------------ catálogos ---

type CatalogState = 'add' | 'remove' | 'on' | 'off' | null;

const CATALOG_PENDING: Record<Exclude<CatalogState, null>, string> = {
  add: 'entra ao salvar',
  remove: 'sai ao salvar',
  on: 'reativada ao salvar',
  off: 'desativada ao salvar',
};

function catalogState(current: { member: boolean; active: boolean }, draft: CatalogDraft | undefined): CatalogState {
  if (!draft) return null;
  if (!draft.member) return current.member ? 'remove' : null;
  if (!current.member) return 'add';
  if (current.active === draft.active) return null;
  return draft.active ? 'on' : 'off';
}

type CatalogRow = {
  uuid: string;
  slug: string;
  name: string;
  /** O catálogo está ligado; `null` quando só se sabe pelo rascunho. */
  isActive: boolean | null;
  current: { member: boolean; active: boolean };
  summary: CatalogSummary | undefined;
};

/**
 * A guia "Catálogos" da skill (`docs/13` decisão 22): os catálogos de que a
 * skill participa, com o estado de cada um, os servidores que ele alcança e o
 * dono. Na edição (`drafts`), a mesma tabela é o CRUD da participação —
 * adicionar a um catálogo, ligar e desligar a participação, tirar — em
 * pendências que o Salvar da página envia. Só os catálogos que a sessão
 * **edita** mudam; os outros ficam em leitura.
 */
export function SkillCatalogsTab({
  skill,
  user,
  drafts,
  onDrafts,
}: {
  skill: SkillDetail;
  user: SessionUser;
  drafts?: Record<string, CatalogDraft>;
  onDrafts?: (next: Record<string, CatalogDraft>) => void;
}) {
  const toast = useToast();
  const { open: openPalette } = usePalette();
  const editing = drafts !== undefined && onDrafts !== undefined;
  const [summaries, setSummaries] = useState<Map<string, CatalogSummary> | null>(null);

  useEffect(() => {
    let active = true;
    getCatalogs()
      .then((data) => active && setSummaries(new Map(data.items.map((item) => [item.uuid, item]))))
      .catch((err) => {
        if (!active) return;
        toast.error((err as Error).message);
        setSummaries(new Map());
      });
    return () => {
      active = false;
    };
  }, [toast]);

  const rows = useMemo<CatalogRow[]>(() => {
    const list: CatalogRow[] = skill.catalogs.map((catalog) => ({
      uuid: catalog.uuid,
      slug: catalog.slug,
      name: catalog.name,
      isActive: catalog.isActive,
      current: { member: true, active: catalog.memberActive },
      summary: summaries?.get(catalog.uuid),
    }));
    const members = new Set(skill.catalogs.map((catalog) => catalog.uuid));
    for (const [uuid, draft] of Object.entries(drafts ?? {})) {
      if (members.has(uuid) || !draft.member) continue;
      const summary = summaries?.get(uuid);
      list.push({ uuid, slug: draft.slug, name: draft.name, isActive: summary?.isActive ?? null, current: membership(skill, uuid), summary });
    }
    return list.sort((a, b) => a.name.localeCompare(b.name));
  }, [skill, drafts, summaries]);

  function setDraft(row: Pick<CatalogRow, 'uuid' | 'slug' | 'name' | 'current'>, wanted: { member: boolean; active: boolean } | null) {
    if (!drafts || !onDrafts) return;
    const { [row.uuid]: _old, ...others } = drafts;
    const same = wanted === null || (wanted.member === row.current.member && (!wanted.member || wanted.active === row.current.active));
    onDrafts(same ? others : { ...others, [row.uuid]: { slug: row.slug, name: row.name, ...wanted } });
  }

  const canChange = (row: CatalogRow) => editing && row.summary !== undefined && canEdit(row.summary.access);
  const editableCount = summaries ? [...summaries.values()].filter((item) => canEdit(item.access)).length : 0;

  function add() {
    if (!summaries) return;
    const exclude = new Set<string>([
      ...rows.map((row) => row.slug),
      ...[...summaries.values()].filter((item) => !canEdit(item.access)).map((item) => item.slug),
    ]);
    openPalette({
      page: 'pick-catalog',
      title: `Adicionar "${skill.name}" a um catálogo`,
      exclude,
      onPick: (catalog) => {
        const current = membership(skill, catalog.uuid);
        setDraft({ uuid: catalog.uuid, slug: catalog.slug, name: catalog.name, current }, { member: true, active: true });
      },
    });
  }

  const pending = editing ? rows.filter((row) => catalogState(row.current, drafts?.[row.uuid]) !== null).length : 0;

  return (
    <Panel
      title="Catálogos"
      icon={<Library />}
      actions={
        <span className="flex items-center gap-2">
          {pending > 0 && <Badge tone="warn">{pending === 1 ? '1 pendência' : `${pending} pendências`}</Badge>}
          {editing && canCreate(user.role) && (
            <Link to="/catalogos?novo=1" className="btn btn-quiet btn-sm">
              Novo catálogo
            </Link>
          )}
          {editing && (
            <Button size="sm" onClick={add} disabled={summaries === null || editableCount === 0} title={editableCount === 0 ? 'Você não edita nenhum catálogo' : undefined}>
              <Plus /> Adicionar a um catálogo
            </Button>
          )}
        </span>
      }
    >
      <p className="panel-hint">
        Um catálogo vinculado a um servidor entrega todas as suas skills ativas de uma vez.
        {editing
          ? ' Marque a caixa para a participação valer, desmarque para suspendê-la sem tirar a skill do catálogo, ou tire-a. Nada é gravado até o botão Salvar; só os catálogos que você edita mudam.'
          : ' A participação se muda em Editar → Catálogos, ou na página do catálogo.'}
      </p>

      {summaries === null && <Skel h={48} />}

      {summaries !== null && (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                {editing && <th style={{ width: 36 }} title="Participação ativa" />}
                <th>Catálogo</th>
                <th>Estado</th>
                <th className="hidden md:table-cell">Servidores</th>
                <th className="hidden lg:table-cell">Dono</th>
                {editing && <th />}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const draft = drafts?.[row.uuid];
                const state = catalogState(row.current, draft);
                const member = draft?.member ?? row.current.member;
                const active = draft ? draft.active : row.current.active;
                const changeable = canChange(row);
                return (
                  <tr
                    key={row.uuid}
                    className={cx((!active || row.isActive === false) && !state && 'is-off', state && 'is-pending', state === 'remove' && 'is-removed')}
                  >
                    {editing && (
                      <td className="num">
                        <input
                          type="checkbox"
                          checked={member && active}
                          disabled={!changeable || !member}
                          onChange={(event) => setDraft(row, { member: true, active: event.target.checked })}
                          aria-label={`Participação em ${row.name}`}
                          title={active ? 'Participação ativa — desmarcar suspende sem tirar do catálogo' : 'Participação desativada'}
                        />
                      </td>
                    )}
                    <td>
                      <Link to={`/catalogos/${row.slug}`} className="row-title">
                        {row.name}
                      </Link>
                      <span className="row-sub">
                        {row.slug}
                        {row.summary?.description ? ` · ${row.summary.description}` : ''}
                      </span>
                    </td>
                    <td>
                      <span className="flex flex-wrap items-center gap-1">
                        {row.isActive === false && <Badge tone="danger">catálogo desligado</Badge>}
                        {row.current.member && !row.current.active && <Badge tone="outline">participação desativada</Badge>}
                        {row.isActive !== false && row.current.member && row.current.active && <Badge tone="ok">participa</Badge>}
                        {row.summary?.isPublic && <Badge tone="outline">público</Badge>}
                        {state && <Badge tone="warn">{CATALOG_PENDING[state]}</Badge>}
                      </span>
                    </td>
                    <td className="hidden md:table-cell">
                      <span className="row-sub">{row.summary ? row.summary.mcpCount : '—'}</span>
                    </td>
                    <td className="hidden lg:table-cell">
                      <span className="row-sub">{row.summary ? (row.summary.ownerEmail ?? 'sem dono') : '—'}</span>
                    </td>
                    {editing && (
                      <td className="num whitespace-nowrap">
                        <span className="flex items-center justify-end gap-2">
                          {draft && (
                            <button type="button" className="row-action" title="Desfazer" onClick={() => setDraft(row, null)}>
                              <Undo2 />
                            </button>
                          )}
                          {changeable && member && (
                            <button
                              type="button"
                              className="row-action danger"
                              title="Tirar do catálogo"
                              onClick={() => setDraft(row, { member: false, active: false })}
                            >
                              <Trash2 />
                            </button>
                          )}
                          {!changeable && <span className="row-sub" title="Você não edita este catálogo">leitura</span>}
                        </span>
                      </td>
                    )}
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <EmptyRow colSpan={editing ? 6 : 4}>
                  Em nenhum catálogo.{' '}
                  {editing ? (
                    editableCount > 0 ? (
                      <button type="button" className="link-action" onClick={add}>
                        Adicionar a um catálogo
                      </button>
                    ) : (
                      'Você não edita nenhum catálogo.'
                    )
                  ) : (
                    <Link to="/catalogos" className="link">
                      Ver os catálogos
                    </Link>
                  )}
                </EmptyRow>
              )}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

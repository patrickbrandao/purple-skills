import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Library, Server } from 'lucide-react';
import {
  getMcps,
  linkSkillToMcp,
  unlinkSkillFromMcp,
  type LinkFlags,
  type SkillDetail,
  type SkillLinkInput,
  type VirtualMcpSummary,
} from '../api.js';
import { Badge, Button, EmptyRow, Panel, Skel } from './ui.js';
import { useToast } from './Toast.js';

/** As três portas de um vínculo, como o painel as rotula. */
export const SURFACES = [
  { key: 'asSkill' as const, label: 'Tools', title: 'Nas ferramentas: search_skills, get_skill…', port: 'tools' },
  { key: 'asResource' as const, label: 'Resources', title: 'Como resource skill://<slug>', port: 'resources' },
  { key: 'asPrompt' as const, label: 'Prompts', title: 'Como prompt, pelo slug (slash-command)', port: 'prompts' },
] as const;

/** Nasce nas ferramentas: é a porta que o agente descobre sozinho. */
export const DEFAULT_FLAGS: LinkFlags = { asSkill: true, asPrompt: false, asResource: false };

export const semPorta = (flags: LinkFlags) => !flags.asSkill && !flags.asPrompt && !flags.asResource;

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

/** Os vMCPs que a sessão administra: admin vê todos, os demais os seus. */
function useManageableMcps(enabled = true) {
  const toast = useToast();
  const [mcps, setMcps] = useState<VirtualMcpSummary[] | null>(enabled ? null : []);

  useEffect(() => {
    if (!enabled) return;
    getMcps()
      .then((data) => setMcps(data.items))
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
 * Só os vMCPs que a sessão administra aparecem. Sem nenhum marcado, a skill
 * nasce flutuante: existe e não é exibida em lugar nenhum.
 */
export function PublishInPicker({ value, onChange }: { value: SkillLinkInput[]; onChange: (links: SkillLinkInput[]) => void }) {
  const mcps = useManageableMcps();
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
                  Você não administra nenhum servidor. <Link to="/mcps?novo=1" className="link">Crie um</Link>, ou peça a um
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

/**
 * "Publicada em", na página da skill: o vínculo pelo lado da skill. Cada
 * linha é um vMCP: os que a sessão administra são editáveis linha a linha; os
 * demais em que a skill está aparecem só para leitura.
 *
 * Um vMCP alcançado só por catálogo (`docs/11-catalogos.md` §3.2) aparece com
 * as portas em selos e "via catálogo X": a edição é no catálogo. Quem
 * administra o vMCP ainda pode publicar direto — o vínculo direto sobrescreve
 * o catálogo naquele servidor, e é o jeito de restringir uma skill sem tirá-la
 * do grupo.
 */
export function SkillMcpsPanel({
  skill,
  onChanged,
  readOnly = false,
}: {
  skill: SkillDetail;
  onChanged: (detail: SkillDetail) => void;
  /** A ficha de leitura: só os servidores em que a skill está, com as portas em selos. */
  readOnly?: boolean;
}) {
  const toast = useToast();
  const manageable = useManageableMcps(!readOnly);
  const [drafts, setDrafts] = useState<Record<string, LinkFlags>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const linked = useMemo(() => new Map(skill.mcps.map((mcp) => [mcp.uuid, mcp])), [skill]);

  const rows = useMemo(() => {
    // Só leitura: nenhuma linha é editável, e só os servidores em que a skill está aparecem.
    const own = readOnly ? [] : (manageable ?? []);
    const ownUuids = new Set(own.map((mcp) => mcp.uuid));
    const foreign = skill.mcps.filter((mcp) => !ownUuids.has(mcp.uuid));
    const all = [
      ...own.map((mcp) => ({ ...mcp, editable: true })),
      ...foreign.map((mcp) => ({ ...mcp, skillCount: 0, editable: false })),
    ];
    return all.sort((a, b) => {
      const la = linked.has(a.uuid) ? 0 : 1;
      const lb = linked.has(b.uuid) ? 0 : 1;
      return la - lb || a.name.localeCompare(b.name);
    });
  }, [manageable, skill.mcps, linked, readOnly]);

  function draftFor(uuid: string): LinkFlags {
    const current = linked.get(uuid);
    return (
      drafts[uuid] ??
      (current ? { asSkill: current.asSkill, asPrompt: current.asPrompt, asResource: current.asResource } : DEFAULT_FLAGS)
    );
  }

  function isDirty(uuid: string): boolean {
    const current = linked.get(uuid);
    const draft = drafts[uuid];
    if (!draft) return false;
    if (!current || !current.direct) return true;
    return draft.asSkill !== current.asSkill || draft.asPrompt !== current.asPrompt || draft.asResource !== current.asResource;
  }

  async function save(mcp: { uuid: string; slug: string; name: string }) {
    const flags = draftFor(mcp.uuid);
    if (semPorta(flags)) {
      toast.error('Escolha ao menos uma porta: Tools, Resources ou Prompts.');
      return;
    }
    setBusy(mcp.uuid);
    try {
      onChanged(await linkSkillToMcp(skill.slug, mcp.slug, flags));
      setDrafts((current) => {
        const { [mcp.uuid]: _gone, ...rest } = current;
        return rest;
      });
      toast.success(`Publicada em "${mcp.name}".`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function remove(mcp: { uuid: string; slug: string; name: string }) {
    setBusy(mcp.uuid);
    try {
      onChanged(await unlinkSkillFromMcp(skill.slug, mcp.slug));
      setDrafts((current) => {
        const { [mcp.uuid]: _gone, ...rest } = current;
        return rest;
      });
      toast.success(`Tirada de "${mcp.name}".`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Panel title="Publicada em" icon={<Server />}>
      <p className="panel-hint">
        A skill só é exibida — no site e nos servidores MCP — onde estiver publicada, direto ou por um catálogo.
        {readOnly
          ? ' As portas de cada servidor se mudam em Editar → Propriedades, ou no canvas do servidor.'
          : ' Marque as portas por servidor e salve a linha. O mesmo vínculo aparece como aresta no canvas do servidor.'}
      </p>

      {manageable === null && <Skel h={48} />}

      {manageable !== null && (
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
                const flags = draftFor(mcp.uuid);
                const dirty = isDirty(mcp.uuid);
                return (
                  <tr key={mcp.uuid} className={mcp.isActive ? undefined : 'is-off'}>
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
                          <FlagBoxes value={flags} onChange={(next) => setDrafts((d) => ({ ...d, [mcp.uuid]: next }))} />
                          {viaCatalog && !dirty && (
                            <span className="hint">Portas do catálogo. Publicar aqui cria um vínculo direto, que passa a valer sozinho.</span>
                          )}
                        </>
                      ) : (
                        <FlagBadges value={current ?? DEFAULT_FLAGS} />
                      )}
                    </td>
                    <td className="num whitespace-nowrap">
                      {mcp.editable && (
                        <div className="flex justify-end gap-2">
                          {(dirty || !current) && (
                            <Button size="sm" disabled={busy === mcp.uuid} onClick={() => void save(mcp)}>
                              {current?.direct ? 'Salvar' : 'Publicar'}
                            </Button>
                          )}
                          {current?.direct && (
                            <Button size="sm" variant="ghost" disabled={busy === mcp.uuid} onClick={() => void remove(mcp)}>
                              Tirar
                            </Button>
                          )}
                        </div>
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
                      Você não administra nenhum servidor. <Link to="/mcps?novo=1" className="link">Crie um</Link>, ou peça a
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

/**
 * "Nos catálogos", na página da skill: só leitura. Adicionar, remover e
 * desativar a participação são ações da página do catálogo (`docs/11` §6.1).
 */
export function SkillCatalogsPanel({ skill }: { skill: SkillDetail }) {
  return (
    <Panel title="Nos catálogos" icon={<Library />}>
      <p className="panel-hint">
        Um catálogo vinculado a um servidor entrega todas as suas skills de uma vez. Quem decide o que entra é a página do
        catálogo; aqui só se vê de quais esta skill participa.
      </p>
      <div className="table-wrap">
        <table className="data">
          <tbody>
            {skill.catalogs.map((catalog) => (
              <tr key={catalog.uuid} className={catalog.isActive && catalog.memberActive ? undefined : 'is-off'}>
                <td>
                  <Link to={`/catalogos/${catalog.slug}`} className="row-title">
                    {catalog.name}
                  </Link>
                  <span className="row-sub">{catalog.slug}</span>
                </td>
                <td className="num">
                  <span className="flex justify-end gap-1">
                    {!catalog.isActive && <Badge tone="danger">catálogo desligado</Badge>}
                    {!catalog.memberActive && <Badge tone="outline">participação desativada</Badge>}
                    {catalog.isActive && catalog.memberActive && <Badge tone="ok">participa</Badge>}
                  </span>
                </td>
              </tr>
            ))}
            {skill.catalogs.length === 0 && (
              <EmptyRow colSpan={2}>
                Em nenhum catálogo. <Link to="/catalogos" className="link">Ver os catálogos</Link>.
              </EmptyRow>
            )}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getMcps,
  linkSkillToMcp,
  unlinkSkillFromMcp,
  type SkillDetail,
  type SkillLinkInput,
  type VirtualMcpSummary,
} from '../api.js';
import { Button, Panel } from '../components/ui.js';
import { ServerIcon } from '../components/Icons.js';
import { useToast } from '../components/Toast.js';

/** As três portas de um vínculo, como o painel as rotula. */
export const SURFACES = [
  { key: 'asSkill' as const, label: 'skill', title: 'Nas ferramentas: search_skills, get_skill…' },
  { key: 'asPrompt' as const, label: 'prompt', title: 'Como prompt, pelo slug (slash-command)' },
  { key: 'asResource' as const, label: 'resource', title: 'Como resource skill://<slug>' },
] as const;

type Flags = { asSkill: boolean; asPrompt: boolean; asResource: boolean };

/** Nasce nas ferramentas: é a porta que o agente descobre sozinho. */
const DEFAULT_FLAGS: Flags = { asSkill: true, asPrompt: false, asResource: false };

const semPorta = (flags: Flags) => !flags.asSkill && !flags.asPrompt && !flags.asResource;

const estadoDo = (mcp: { isOpen: boolean; isActive: boolean; isDefault: boolean }) =>
  [
    mcp.isActive ? (mcp.isOpen ? 'aberto' : 'exige chave') : 'desligado',
    mcp.isDefault && 'padrão',
  ]
    .filter(Boolean)
    .join(' · ');

function FlagBoxes({ value, onChange }: { value: Flags; onChange: (flags: Flags) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {SURFACES.map((surface) => (
        <label key={surface.key} className="flex cursor-pointer items-center gap-1 text-xs" title={surface.title}>
          <input
            type="checkbox"
            checked={value[surface.key]}
            onChange={(event) => onChange({ ...value, [surface.key]: event.target.checked })}
          />
          {surface.label}
        </label>
      ))}
    </div>
  );
}

/** Os vMCPs que a sessão administra: admin vê todos, os demais os seus. */
function useManageableMcps() {
  const toast = useToast();
  const [mcps, setMcps] = useState<VirtualMcpSummary[] | null>(null);

  useEffect(() => {
    getMcps()
      .then((data) => setMcps(data.items))
      .catch((err) => {
        toast.error((err as Error).message);
        setMcps([]);
      });
  }, [toast]);

  return mcps;
}

// ------------------------------------------------------------ skill nova ---

/**
 * "Publicar em", para a skill nova e o import: controlado, sem chamar a API.
 * Só os vMCPs que a sessão administra aparecem — é a mesma regra do servidor
 * (`docs/09-mcp-padrao-e-skills-flutuantes.md`, decisão 6). Sem nenhum
 * marcado, a skill nasce flutuante: existe e não é exibida em lugar nenhum.
 */
export function PublishInPicker({
  value,
  onChange,
}: {
  value: SkillLinkInput[];
  onChange: (links: SkillLinkInput[]) => void;
}) {
  const mcps = useManageableMcps();
  const bySlug = useMemo(() => new Map(value.map((link) => [link.slug, link])), [value]);

  function toggle(mcp: VirtualMcpSummary, on: boolean) {
    if (on) onChange([...value, { slug: mcp.slug, ...DEFAULT_FLAGS }]);
    else onChange(value.filter((link) => link.slug !== mcp.slug));
  }

  function setFlags(slug: string, flags: Flags) {
    onChange(value.map((link) => (link.slug === slug ? { ...link, ...flags } : link)));
  }

  return (
    <div className="mt-5">
      <span className="label">Publicar em</span>
      <p className="panel-hint">
        A skill só é exibida — no site e nos servidores MCP — onde estiver publicada. Sem nenhum
        marcado, ela nasce sem vínculo e fica visível só aqui no painel; dá para publicar depois,
        na página dela.
      </p>
      {mcps === null && <div className="skel-block" style={{ height: '3rem' }} />}
      {mcps !== null && mcps.length === 0 && (
        <p className="panel-hint">
          Você não administra nenhum MCP virtual. <Link to="/mcps">Crie um</Link>, ou peça a um
          administrador para publicar a skill.
        </p>
      )}
      {mcps !== null && mcps.length > 0 && (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th />
                <th>MCP virtual</th>
                <th>Superfícies</th>
              </tr>
            </thead>
            <tbody>
              {mcps.map((mcp) => {
                const link = bySlug.get(mcp.slug);
                return (
                  <tr key={mcp.uuid} className={mcp.isActive ? undefined : 'is-off'}>
                    <td className="num">
                      <input
                        type="checkbox"
                        checked={Boolean(link)}
                        onChange={(event) => toggle(mcp, event.target.checked)}
                        aria-label={`Publicar em ${mcp.name}`}
                      />
                    </td>
                    <td>
                      <span className="row-title">{mcp.name}</span>
                      <span className="row-sub">
                        /virtual/{mcp.slug} · {estadoDo(mcp)}
                      </span>
                    </td>
                    <td>
                      {link ? (
                        <FlagBoxes value={link} onChange={(flags) => setFlags(mcp.slug, flags)} />
                      ) : (
                        <span className="row-sub">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------- skill existente ---

/**
 * "Publicada em", na página da skill: o vínculo pelo lado da skill
 * (`docs/09-mcp-padrao-e-skills-flutuantes.md` §4.3). Cada linha é um vMCP:
 * os que a sessão administra são editáveis linha a linha; os demais em que a
 * skill está aparecem só para leitura — quem mexe neles é o dono ou um admin.
 */
export function SkillMcpsPanel({
  skill,
  onChanged,
}: {
  skill: SkillDetail;
  onChanged: (detail: SkillDetail) => void;
}) {
  const toast = useToast();
  const manageable = useManageableMcps();
  const [drafts, setDrafts] = useState<Record<string, Flags>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const linked = useMemo(() => new Map(skill.mcps.map((mcp) => [mcp.uuid, mcp])), [skill]);

  // As linhas: todo vMCP que a sessão administra, mais os vínculos que ela não
  // administra (só leitura). Ordem: vinculados primeiro, depois por nome.
  const rows = useMemo(() => {
    const own = manageable ?? [];
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
  }, [manageable, skill.mcps, linked]);

  function draftFor(uuid: string): Flags {
    const current = linked.get(uuid);
    return drafts[uuid] ?? (current ? { asSkill: current.asSkill, asPrompt: current.asPrompt, asResource: current.asResource } : DEFAULT_FLAGS);
  }

  function isDirty(uuid: string): boolean {
    const current = linked.get(uuid);
    const draft = drafts[uuid];
    if (!draft) return false;
    if (!current) return true;
    return draft.asSkill !== current.asSkill || draft.asPrompt !== current.asPrompt || draft.asResource !== current.asResource;
  }

  async function save(mcp: { uuid: string; slug: string; name: string }) {
    const flags = draftFor(mcp.uuid);
    if (semPorta(flags)) {
      toast.error('Escolha ao menos uma superfície: skill, prompt ou resource.');
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
    <Panel title="Publicada em" icon={<ServerIcon />} className="mt-5">
      <p className="panel-hint">
        A skill só é exibida — no site e nos servidores MCP — onde estiver publicada. Marque as
        superfícies por servidor e salve a linha; sem nenhum vínculo ela fica visível só aqui.
      </p>

      {manageable === null && <div className="skel-block" style={{ height: '3rem' }} />}

      {manageable !== null && (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>MCP virtual</th>
                <th>Superfícies</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((mcp) => {
                const current = linked.get(mcp.uuid);
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
                    </td>
                    <td>
                      {mcp.editable ? (
                        <FlagBoxes
                          value={flags}
                          onChange={(next) => setDrafts((d) => ({ ...d, [mcp.uuid]: next }))}
                        />
                      ) : (
                        <span className="row-sub" title="Só o dono deste MCP ou um administrador alteram">
                          {SURFACES.filter((s) => current?.[s.key]).map((s) => s.label).join(', ') || '—'}
                        </span>
                      )}
                    </td>
                    <td className="num whitespace-nowrap">
                      {mcp.editable && (
                        <div className="flex justify-end gap-2">
                          {(dirty || !current) && (
                            <Button size="sm" disabled={busy === mcp.uuid} onClick={() => void save(mcp)}>
                              {current ? 'Salvar' : 'Publicar'}
                            </Button>
                          )}
                          {current && (
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
                <tr>
                  <td colSpan={3}>
                    <p className="list-empty">
                      Você não administra nenhum MCP virtual. <Link to="/mcps">Crie um</Link>, ou
                      peça a um administrador para publicar a skill.
                    </p>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

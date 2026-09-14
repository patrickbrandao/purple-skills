import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, Library, Plus, Server, Settings, Trash2 } from 'lucide-react';
import {
  addCatalogSkill,
  canEdit as canEditAccess,
  canManage,
  canOwn,
  deleteCatalog,
  formatDateTime,
  getCatalog,
  num,
  removeCatalogSkill,
  setCatalogSkillActive,
  updateCatalog,
  type CatalogDetail,
  type CatalogSkill,
  type SessionUser,
} from '../api.js';
import { Badge, Button, EmptyRow, Field, McpStateBadges, Panel, Skel, Status, useConfirm } from '../components/ui.js';
import { AccessBadge, AccessPanel, accessSentence } from '../components/AccessPanel.js';
import { SkillIcon } from '../components/SkillIcon.js';
import { SURFACES } from '../components/SkillMcps.js';
import { usePalette, useRegisterCommands } from '../components/commands.js';
import { useToast } from '../components/Toast.js';

/**
 * Um catálogo (`docs/11-catalogos.md` §6.1): o CRUD de skills — adicionar,
 * remover, ligar e desligar a participação — mais onde ele está vinculado, a
 * configuração e o acesso. O que a sessão pode vem em `access`
 * (`docs/12-acesso-granular.md` §3.2): `view` lê, `edit` mexe nos membros,
 * `manage` muda a configuração e as concessões, o dono apaga.
 */
export function CatalogPage({ user }: { user: SessionUser }) {
  const { slug = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { open: openPalette } = usePalette();
  const [detail, setDetail] = useState<CatalogDetail | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setDetail(await getCatalog(slug));
    } catch (err) {
      toast.error((err as Error).message);
      navigate('/catalogos');
    }
  }, [slug, toast, navigate]);

  useEffect(() => {
    setDetail(null);
    void load();
  }, [load]);

  const canEdit = detail ? canEditAccess(detail.access) : false;

  const addSkill = useCallback(() => {
    if (!detail) return;
    openPalette({
      page: 'pick-skill',
      title: `Adicionar a ${detail.name}`,
      exclude: new Set(detail.skills.map((skill) => skill.slug)),
      onPick: (skill) => {
        setBusy(skill.slug);
        addCatalogSkill(detail.slug, skill.slug)
          .then((fresh) => {
            setDetail(fresh);
            toast.success(`"${skill.name}" adicionada.`);
          })
          .catch((err) => toast.error((err as Error).message))
          .finally(() => setBusy(null));
      },
    });
  }, [detail, openPalette, toast]);

  useRegisterCommands(
    detail && canEdit
      ? [{ id: 'catalog-add', label: `Adicionar skill a "${detail.name}"`, group: 'Recurso', icon: <Plus />, shortcut: 'a', run: addSkill }]
      : [],
    [detail?.slug, canEdit, addSkill],
  );

  async function toggle(skill: CatalogSkill, on: boolean) {
    if (!detail) return;
    setBusy(skill.slug);
    try {
      setDetail(await setCatalogSkillActive(detail.slug, skill.slug, on));
      toast.success(on ? `"${skill.name}" reativada no catálogo.` : `"${skill.name}" desativada no catálogo.`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function remove(skill: CatalogSkill) {
    if (!detail) return;
    setBusy(skill.slug);
    try {
      setDetail(await removeCatalogSkill(detail.slug, skill.slug));
      toast.success(`"${skill.name}" removida do catálogo.`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (!detail) {
    return (
      <div className="page">
        <Skel h={20} w={120} className="mb-3" />
        <Skel h={40} w={360} className="mb-6" />
        <Skel h={320} />
      </div>
    );
  }

  const inactiveSkills = detail.skills.filter((skill) => !skill.skillIsActive).length;

  return (
    <div className="page wide">
      <div className="page-head">
        <div className="min-w-0">
          <Link to="/catalogos" className="back-link">
            <ArrowLeft /> Catálogos
          </Link>
          <div className="flex items-center gap-2">
            <h1 className="truncate">{detail.name}</h1>
            {!detail.isActive && (
              <Badge tone="danger" title="Desligado: não contribui para nenhum servidor até religar">
                desligado
              </Badge>
            )}
            {detail.isPublic && (
              <Badge tone="outline" title="Público: qualquer conta e o site leem, com todos os membros">
                público
              </Badge>
            )}
            <AccessBadge object={detail} user={user} publicLabel="público" />
          </div>
          <p className="sub mono flex flex-wrap items-center gap-x-3">
            <span>{detail.slug}</span>
            <span>· {detail.activeSkillCount} de {detail.skillCount} skill{detail.skillCount === 1 ? '' : 's'} ativa{detail.activeSkillCount === 1 ? '' : 's'}</span>
            <span>· {num(detail.viewCount)} acessos</span>
            <span>· {num(detail.downloadCount)} downloads</span>
            <span>· dono: {detail.ownerEmail ?? 'nenhum (só admin)'}</span>
            {user.role !== 'admin' && <span>· {accessSentence(detail.access)}</span>}
          </p>
        </div>
        <div className="page-actions">
          {canEdit && (
            <Button onClick={addSkill}>
              <Plus /> Adicionar skill
            </Button>
          )}
        </div>
      </div>

      {detail.description && <p className="skill-lead">{detail.description}</p>}

      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,360px)]">
        <Panel title="Skills" icon={<Library />}>
          <p className="panel-hint">
            Toda skill marcada entra em cada servidor vinculado, pelas portas do vínculo. Desmarcar tira a skill da entrega sem
            removê-la do catálogo. Uma skill <strong>desligada</strong> na própria ficha continua aqui, mas não sai por servidor nenhum.
          </p>

          {inactiveSkills > 0 && (
            <div className="alert warn mb-3">
              <AlertTriangle />
              <span>
                {inactiveSkills === 1 ? 'Uma skill deste catálogo está desligada' : `${inactiveSkills} skills deste catálogo estão desligadas`}: elas não
                são entregues em servidor nenhum até serem religadas na página da skill.
              </span>
            </div>
          )}

          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th style={{ width: 36 }} title="Participação no catálogo" />
                  <th>Skill</th>
                  <th className="hidden md:table-cell">Estado</th>
                  <th className="hidden lg:table-cell">Adicionada</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {detail.skills.map((skill) => {
                  const entregue = skill.isActive && skill.skillIsActive && detail.isActive;
                  return (
                    <tr key={skill.uuid} className={skill.isActive ? undefined : 'is-off'}>
                      <td className="num">
                        <input
                          type="checkbox"
                          checked={skill.isActive}
                          disabled={!canEdit || busy === skill.slug}
                          onChange={(event) => void toggle(skill, event.target.checked)}
                          aria-label={`Participação de ${skill.name}`}
                          title={skill.isActive ? 'Participação ativa — desmarcar desativa sem remover' : 'Participação desativada'}
                        />
                      </td>
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
                        <div className="flex flex-wrap items-center gap-1.5">
                          {!skill.skillIsActive && (
                            <Badge tone="danger" title="A skill está desligada na própria ficha: não sai por servidor nenhum">
                              <AlertTriangle style={{ width: 11, height: 11 }} /> skill desligada
                            </Badge>
                          )}
                          {!skill.isActive && (
                            <Badge tone="outline" title="Participação desativada neste catálogo: fica, mas não é entregue">
                              desativada
                            </Badge>
                          )}
                          {entregue && <Status tone="ok">entregue</Status>}
                        </div>
                      </td>
                      <td className="hidden lg:table-cell">
                        <span className="row-sub whitespace-nowrap">{formatDateTime(skill.addedAt)}</span>
                      </td>
                      <td className="num">
                        {canEdit && (
                          <button
                            type="button"
                            className="row-action danger"
                            title="Remover do catálogo"
                            disabled={busy === skill.slug}
                            onClick={() => void remove(skill)}
                          >
                            <Trash2 />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {detail.skills.length === 0 && <EmptyRow colSpan={5}>Nenhuma skill ainda</EmptyRow>}
              </tbody>
            </table>
          </div>
        </Panel>

        <div className="grid content-start gap-4">
          <Panel title="Vinculado em" icon={<Server />}>
            <p className="panel-hint">
              Os servidores que recebem este catálogo. O vínculo é feito no canvas do servidor, por quem o edita e vê este catálogo.
            </p>
            <div className="table-wrap">
              <table className="data">
                <tbody>
                  {detail.mcps.map((mcp) => (
                    <tr key={mcp.uuid} className={mcp.isActive ? undefined : 'is-off'}>
                      <td>
                        <Link to={`/mcps/${mcp.slug}`} className="row-title">
                          {mcp.name}
                        </Link>
                        <span className="row-sub flex flex-wrap items-center gap-1.5">
                          /virtual/{mcp.slug}
                          <McpStateBadges mcp={mcp} />
                        </span>
                      </td>
                      <td className="num">
                        <span className="flex justify-end gap-1">
                          {SURFACES.filter((surface) => mcp[surface.key]).map((surface) => (
                            <Badge key={surface.key} tone="outline">
                              {surface.label}
                            </Badge>
                          ))}
                        </span>
                      </td>
                    </tr>
                  ))}
                  {detail.mcps.length === 0 && <EmptyRow colSpan={2}>Em nenhum servidor ainda</EmptyRow>}
                </tbody>
              </table>
            </div>
          </Panel>

          <AccessPanel
            kind="catalog"
            object={detail}
            user={user}
            onPatch={(body) => updateCatalog(detail.slug, body)}
            onChanged={setDetail}
            publicHint="O site lista o catálogo com todos os membros ativos — inclusive skills que não são públicas."
            privateCount={detail.skills.filter((skill) => skill.isActive && skill.skillIsActive).length}
          />
          <SettingsPanel catalog={detail} onSaved={setDetail} />
        </div>
      </div>
    </div>
  );
}

/** Nome, slug, descrição e ligado são `manage`; apagar é do dono; dono, público e concessões ficam em "Acesso". */
function SettingsPanel({ catalog, onSaved }: { catalog: CatalogDetail; onSaved: (detail: CatalogDetail) => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const canEdit = canManage(catalog.access);
  const owns = canOwn(catalog.access);
  const [name, setName] = useState(catalog.name);
  const [slug, setSlug] = useState(catalog.slug);
  const [description, setDescription] = useState(catalog.description);
  const [isActive, setIsActive] = useState(catalog.isActive);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setName(catalog.name);
    setSlug(catalog.slug);
    setDescription(catalog.description);
    setIsActive(catalog.isActive);
  }, [catalog]);

  const dirty =
    name !== catalog.name ||
    slug !== catalog.slug ||
    description !== catalog.description ||
    isActive !== catalog.isActive;

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const saved = await updateCatalog(catalog.slug, {
        name: name !== catalog.name ? name : undefined,
        slug: slug !== catalog.slug ? slug : undefined,
        description: description !== catalog.description ? description : undefined,
        isActive: isActive !== catalog.isActive ? isActive : undefined,
      });
      onSaved(saved);
      toast.success('Catálogo salvo.');
      if (saved.slug !== catalog.slug) navigate(`/catalogos/${saved.slug}`, { replace: true });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    const ok = await confirm({
      title: `Remover o catálogo "${catalog.name}"?`,
      description: `Os ${catalog.mcpCount} servidor${catalog.mcpCount === 1 ? '' : 'es'} vinculado${catalog.mcpCount === 1 ? '' : 's'} deixa${catalog.mcpCount === 1 ? '' : 'm'} de receber as skills dele. As skills continuam existindo.`,
      confirmLabel: 'Remover',
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteCatalog(catalog.slug);
      toast.success('Catálogo removido.');
      navigate('/catalogos');
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  return (
    <>
      <Panel title="Configuração" icon={<Settings />}>
        <form onSubmit={save} className="grid gap-4">
          <Field label="Nome">
            <input className="field" value={name} onChange={(event) => setName(event.target.value)} disabled={!canEdit} />
          </Field>
          <Field label="Slug">
            <input className="field field-mono" value={slug} onChange={(event) => setSlug(event.target.value)} disabled={!canEdit} />
          </Field>
          <Field label="Descrição">
            <textarea className="field" rows={3} value={description} onChange={(event) => setDescription(event.target.value)} disabled={!canEdit} />
          </Field>
          <label className="check">
            <input type="checkbox" checked={isActive} onChange={(event) => setIsActive(event.target.checked)} disabled={!canEdit} />
            Ligado: desligado, nenhum servidor recebe as skills dele (membros e vínculos ficam)
          </label>
          <dl className="kv">
            <dt>Criado em</dt>
            <dd>{formatDateTime(catalog.createdAt)}</dd>
            <dt>Atualizado</dt>
            <dd>{formatDateTime(catalog.updatedAt)}</dd>
          </dl>
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
      {owns && (
        <Panel title="Zona de perigo" icon={<Trash2 />}>
          <p className="panel-hint">Remover apaga o catálogo e os vínculos com servidores. As skills continuam existindo.</p>
          <Button variant="danger" onClick={() => void remove()}>
            <Trash2 /> Remover catálogo
          </Button>
        </Panel>
      )}
    </>
  );
}

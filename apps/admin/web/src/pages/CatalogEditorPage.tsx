import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Eye, History, Info, Library, Plus, Save, SlidersHorizontal, Trash2, Users } from 'lucide-react';
import {
  addCatalogSkill,
  canEdit as canEditAccess,
  canManage,
  canOwn,
  deleteCatalog,
  formatDateTime,
  getCatalog,
  getCatalogAccesses,
  removeCatalogSkill,
  setCatalogSkillActive,
  updateCatalog,
  type CatalogDetail,
  type CatalogSkill,
  type SessionUser,
} from '../api.js';
import { Button, EmptyRow, Field, Panel, Skel, Tabs, useConfirm } from '../components/ui.js';
import { AccessTab } from '../components/AccessPanel.js';
import { AccessLog } from '../components/AccessLog.js';
import { SkillIcon } from '../components/SkillIcon.js';
import { usePalette, useRegisterCommands } from '../components/commands.js';
import { useToast } from '../components/Toast.js';
import {
  CATALOG_PUBLIC_HINT,
  CatalogAlerts,
  CatalogBadges,
  CatalogSubline,
  LinkedMcpsPanel,
  MemberState,
  catalogTabOf,
} from './CatalogPage.js';

/**
 * A ficha do catálogo em edição (`docs/13-fichas-e-acessos.md`): a mesma
 * organização da leitura — Catálogo, Skills, Propriedades, Acesso, Auditoria
 * — com os campos livres onde a sessão pode. Descrição, nome, slug e estado são
 * gravados pelo Salvar do cabeçalho (`manage`); os membros (`edit`), o
 * acesso e a remoção gravam na hora (`docs/12-acesso-granular.md` §3.2).
 */
export function CatalogEditorPage({ user }: { user: SessionUser }) {
  const { slug = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const confirm = useConfirm();
  const { open: openPalette } = usePalette();

  const [detail, setDetail] = useState<CatalogDetail | null>(null);
  const [name, setName] = useState('');
  const [slugDraft, setSlugDraft] = useState('');
  const [description, setDescription] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const canEdit = detail ? canEditAccess(detail.access) : false;
  const manages = detail ? canManage(detail.access) : false;
  const owns = detail ? canOwn(detail.access) : false;

  const tab = catalogTabOf(location.pathname, `/catalogos/${slug}/editar`);

  const hydrate = useCallback((fresh: CatalogDetail) => {
    setDetail(fresh);
    setName(fresh.name);
    setSlugDraft(fresh.slug);
    setDescription(fresh.description);
    setIsActive(fresh.isActive);
  }, []);

  const load = useCallback(async () => {
    try {
      hydrate(await getCatalog(slug));
    } catch (err) {
      toast.error((err as Error).message);
      navigate('/catalogos');
    }
  }, [slug, hydrate, toast, navigate]);

  useEffect(() => {
    setDetail(null);
    void load();
  }, [load]);

  /** Os membros mudam na hora; o formulário do cabeçalho não pode perder o que foi digitado. */
  const applyMembers = useCallback((fresh: CatalogDetail) => {
    setDetail((current) => (current ? { ...fresh, access: current.access } : fresh));
  }, []);

  const dirty =
    detail !== null &&
    (name !== detail.name || slugDraft !== detail.slug || description !== detail.description || isActive !== detail.isActive);

  const save = useCallback(async () => {
    if (!detail) return;
    setSaving(true);
    try {
      const saved = await updateCatalog(detail.slug, {
        name: name !== detail.name ? name : undefined,
        slug: slugDraft !== detail.slug ? slugDraft : undefined,
        description: description !== detail.description ? description : undefined,
        isActive: isActive !== detail.isActive ? isActive : undefined,
      });
      hydrate(saved);
      toast.success('Catálogo salvo.');
      if (saved.slug !== detail.slug) {
        navigate(location.pathname.replace(`/catalogos/${detail.slug}/`, `/catalogos/${saved.slug}/`), { replace: true });
      }
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, [detail, name, slugDraft, description, isActive, hydrate, toast, navigate, location.pathname]);

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
            applyMembers(fresh);
            toast.success(`"${skill.name}" adicionada.`);
          })
          .catch((err) => toast.error((err as Error).message))
          .finally(() => setBusy(null));
      },
    });
  }, [detail, openPalette, toast, applyMembers]);

  useRegisterCommands(
    detail
      ? [
          ...(canEdit ? [{ id: 'catalog-add', label: `Adicionar skill a "${detail.name}"`, group: 'Recurso' as const, icon: <Plus />, shortcut: 'a', run: addSkill }] : []),
          ...(manages ? [{ id: 'catalog-save', label: 'Salvar alterações', group: 'Recurso' as const, icon: <Save />, shortcut: '⌘ S', disabled: dirty ? (false as const) : 'nada a salvar', run: save }] : []),
        ]
      : [],
    [detail?.slug, canEdit, manages, addSkill, dirty, save],
  );

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 's' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        if (dirty && !saving && manages) void save();
      }
    };
    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, [dirty, saving, save, manages]);

  async function toggle(skill: CatalogSkill, on: boolean) {
    if (!detail) return;
    setBusy(skill.slug);
    try {
      applyMembers(await setCatalogSkillActive(detail.slug, skill.slug, on));
      toast.success(on ? `"${skill.name}" reativada no catálogo.` : `"${skill.name}" desativada no catálogo.`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function removeMember(skill: CatalogSkill) {
    if (!detail) return;
    setBusy(skill.slug);
    try {
      applyMembers(await removeCatalogSkill(detail.slug, skill.slug));
      toast.success(`"${skill.name}" removida do catálogo.`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function removeCatalog() {
    if (!detail) return;
    const ok = await confirm({
      title: `Remover o catálogo "${detail.name}"?`,
      description: `Os ${detail.mcpCount} servidor${detail.mcpCount === 1 ? '' : 'es'} vinculado${detail.mcpCount === 1 ? '' : 's'} deixa${detail.mcpCount === 1 ? '' : 'm'} de receber as skills dele. As skills continuam existindo.`,
      confirmLabel: 'Remover',
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteCatalog(detail.slug);
      toast.success('Catálogo removido.');
      navigate('/catalogos');
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  const loadAccesses = useCallback(
    (query: Parameters<typeof getCatalogAccesses>[1]) => getCatalogAccesses(slug, query),
    [slug],
  );

  if (!detail) {
    return (
      <div className="page">
        <Skel h={20} w={120} className="mb-3" />
        <Skel h={40} w={360} className="mb-6" />
        <Skel h={320} />
      </div>
    );
  }

  const base = `/catalogos/${detail.slug}`;
  const editBase = `${base}/editar`;
  const inactiveSkills = detail.skills.filter((skill) => !skill.skillIsActive).length;

  return (
    <div className="page wide">
      <div className="page-head">
        <div className="min-w-0">
          <Link to={base} className="back-link">
            <ArrowLeft /> {detail.name}
          </Link>
          <div className="flex items-center gap-2">
            <h1 className="truncate">{name || detail.name}</h1>
            <CatalogBadges catalog={detail} user={user} />
          </div>
          <CatalogSubline catalog={detail} user={user} />
        </div>
        <div className="page-actions">
          <Link to={base} className="btn btn-ghost">
            <Eye /> Visualizar
          </Link>
          {/* Só `manage` tem o que salvar: descrição, nome, slug e estado. Quem só edita membros grava na hora. */}
          {manages && (
            <Button onClick={() => void save()} disabled={saving || !dirty}>
              <Save /> {saving ? 'Salvando…' : dirty ? 'Salvar' : 'Salvo'}
            </Button>
          )}
        </div>
      </div>

      {!canEdit && (
        <p className="notice warn mb-4">Você só lê este catálogo: os campos aparecem travados.</p>
      )}

      <CatalogAlerts catalog={detail} inactiveSkills={inactiveSkills} />

      <Tabs
        value={tab}
        items={[
          { key: 'catalogo', label: 'Catálogo', icon: <Info />, to: editBase },
          { key: 'skills', label: 'Skills', icon: <Library />, to: `${editBase}/skills`, count: detail.skillCount },
          { key: 'propriedades', label: 'Propriedades', icon: <SlidersHorizontal />, to: `${editBase}/propriedades` },
          { key: 'acesso', label: 'Acesso', icon: <Users />, to: `${editBase}/acesso` },
          ...(manages ? [{ key: 'auditoria', label: 'Auditoria', icon: <History />, to: `${editBase}/auditoria` }] : []),
        ]}
      />

      <Routes>
        <Route
          index
          element={
            <Panel className="desc-box" title="Descrição" icon={<Info />}>
              <textarea
                className="field"
                rows={4}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                disabled={!manages}
                placeholder="Para quem administra: do que este grupo de skills trata."
              />
              <p className="panel-hint mt-3 mb-0">
                {manages ? 'Gravada pelo botão Salvar, junto com as propriedades.' : 'A descrição é de quem administra o catálogo.'}
              </p>
            </Panel>
          }
        />
        <Route
          path="skills"
          element={
            <Panel
              title="Skills"
              icon={<Library />}
              actions={
                canEdit ? (
                  <Button size="sm" onClick={addSkill}>
                    <Plus /> Adicionar skill
                  </Button>
                ) : undefined
              }
            >
              <p className="panel-hint">
                Toda skill marcada entra em cada servidor vinculado, pelas portas do vínculo. Desmarcar tira a skill da entrega sem
                removê-la do catálogo. Uma skill <strong>desligada</strong> na própria ficha continua aqui, mas não sai por servidor nenhum.
                Adicionar, marcar e remover gravam na hora.
              </p>
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
                    {detail.skills.map((skill) => (
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
                          <MemberState skill={skill} catalogActive={detail.isActive} />
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
                              onClick={() => void removeMember(skill)}
                            >
                              <Trash2 />
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                    {detail.skills.length === 0 && <EmptyRow colSpan={5}>Nenhuma skill ainda</EmptyRow>}
                  </tbody>
                </table>
              </div>
            </Panel>
          }
        />
        <Route
          path="propriedades"
          element={
            <div className="grid gap-4">
              <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <Panel title="Propriedades" icon={<SlidersHorizontal />}>
                  <div className="grid gap-4">
                    <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                      <Field label="Nome">
                        <input className="field" value={name} onChange={(event) => setName(event.target.value)} disabled={!manages} />
                      </Field>
                      <Field label="Slug" hint="Identifica o catálogo na URL e nas tools.">
                        <input className="field field-mono" value={slugDraft} onChange={(event) => setSlugDraft(event.target.value)} disabled={!manages} spellCheck={false} />
                      </Field>
                    </div>
                    <label className="check">
                      <input type="checkbox" checked={isActive} onChange={(event) => setIsActive(event.target.checked)} disabled={!manages} />
                      Ligado: desligado, nenhum servidor recebe as skills dele (membros e vínculos ficam)
                    </label>
                    <dl className="kv">
                      <dt>Criado em</dt>
                      <dd>{formatDateTime(detail.createdAt)}</dd>
                      <dt>Atualizado</dt>
                      <dd>{formatDateTime(detail.updatedAt)}</dd>
                    </dl>
                    {!manages && canEdit && <p className="hint">Nome, slug e estado são de quem administra o catálogo; você mexe nos membros.</p>}
                    {manages && <p className="panel-hint mb-0">Estes campos são gravados pelo botão Salvar, junto com a descrição.</p>}
                  </div>
                </Panel>
                <LinkedMcpsPanel catalog={detail} />
              </div>

              {owns && (
                <Panel title="Zona de perigo" icon={<Trash2 />}>
                  <p className="panel-hint">Remover apaga o catálogo e os vínculos com servidores. As skills continuam existindo.</p>
                  <Button variant="danger" onClick={() => void removeCatalog()}>
                    <Trash2 /> Remover catálogo
                  </Button>
                </Panel>
              )}
            </div>
          }
        />
        <Route
          path="acesso"
          element={
            <AccessTab
              kind="catalog"
              object={detail}
              user={user}
              mode="live"
              onPatch={(body) => updateCatalog(detail.slug, body)}
              onChanged={applyMembers}
              publicHint={CATALOG_PUBLIC_HINT}
              privateCount={detail.skills.filter((skill) => skill.isActive && skill.skillIsActive).length}
            />
          }
        />
        {manages && <Route path="auditoria" element={<AccessLog load={loadAccesses} showSkill />} />}
        {/* A guia se chamava Acessos: um link antigo vai para a Auditoria. */}
        <Route path="acessos" element={<Navigate to={`${editBase}/auditoria`} replace />} />
        <Route path="*" element={<Navigate to={editBase} replace />} />
      </Routes>
    </div>
  );
}

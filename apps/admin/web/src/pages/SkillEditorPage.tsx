import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  ExternalLink,
  Eye,
  FileArchive,
  FilePlus,
  FileText,
  FolderPlus,
  FolderTree,
  Save,
  SlidersHorizontal,
  Trash2,
  Upload,
} from 'lucide-react';
import {
  canEdit,
  canManage,
  canOwn,
  deleteSkill,
  getSkill,
  updateSkill,
  type Session,
  type SessionUser,
  type SkillDetail,
  type SkillFileMeta,
} from '../api.js';
import { AccessPanel } from '../components/AccessPanel.js';
import { Button, McpChips, Panel, Skel, Tabs, noSite, useConfirm } from '../components/ui.js';
import { FileTree } from '../components/FileTree.js';
import { FilePickers, SkillFilesTab } from '../components/SkillFiles.js';
import { Markdown } from '../components/Markdown.js';
import { SkillIcon } from '../components/SkillIcon.js';
import { SkillMetaForm, type SkillMetaValues } from '../components/SkillMetaForm.js';
import { SkillCatalogsPanel, SkillMcpsPanel } from '../components/SkillMcps.js';
import { buildFrontmatter, parseTags, stripFrontmatter } from '../frontmatter.js';
import { isSkillMdPath } from '../explorer.js';
import { useSkillFiles } from '../useSkillFiles.js';
import { useToast } from '../components/Toast.js';
import { useRegisterCommands, type Command } from '../components/commands.js';
import { DescriptionBox } from './SkillViewPage.js';

type Tab = 'skill' | 'arquivos' | 'propriedades';
type DocPane = 'render' | 'source';

const VAZIO = '_Esta skill ainda não tem conteúdo em SKILL.md._';

/**
 * A ficha da skill em edição (`docs/13-fichas-e-acessos.md`): Skill (a
 * descrição e o SKILL.md), Arquivos (a árvore com o editor de cada arquivo) e
 * Propriedades. O registro de acessos fica só na leitura — em Editar ele não
 * ajuda, e `/editar/acessos` leva para lá.
 *
 * Um único Salvar (e ⌘S) grava descrição, SKILL.md, metadados e o estado;
 * publicação, acesso e arquivos gravam na hora, cada um no seu lugar — na
 * guia Arquivos, ⌘S grava o arquivo aberto. Conteúdo e metadados são `edit`;
 * slug e estado são `manage`; apagar é do dono (`docs/12-acesso-granular.md`
 * §3.2). Quem só administra um servidor entra aqui para publicar a skill nele:
 * vê os campos travados e as portas do seu servidor livres.
 */
export function SkillEditorPage({ session, user }: { session: Session; user: SessionUser }) {
  const { slug = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const confirm = useConfirm();

  const [skill, setSkill] = useState<SkillDetail | null>(null);
  const podeEscrever = skill ? canEdit(skill.access) : false;
  const podeAdministrar = skill ? canManage(skill.access) : false;
  const podeApagar = skill ? canOwn(skill.access) : false;
  const [saving, setSaving] = useState(false);
  const [meta, setMeta] = useState<SkillMetaValues>({ name: '', slug: '', description: '', tags: '', icon: '' });
  const [isActive, setIsActive] = useState(true);
  const [skillMd, setSkillMd] = useState('');

  const tab: Tab = location.pathname.endsWith('/propriedades')
    ? 'propriedades'
    : location.pathname.endsWith('/arquivos')
      ? 'arquivos'
      : 'skill';

  const hydrate = useCallback((detail: SkillDetail) => {
    setSkill(detail);
    setMeta({ name: detail.name, slug: detail.slug, description: detail.description, tags: detail.tags.join(', '), icon: detail.icon ?? '' });
    setIsActive(detail.isActive);
    setSkillMd(stripFrontmatter(detail.skillMd));
  }, []);

  // Fora de um data router, `navigate` muda a cada troca de caminho: se o
  // `reload` dependesse dele, cada troca de guia buscaria a skill de novo e
  // repovoaria o formulário, jogando fora o que ainda não foi salvo.
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  const reload = useCallback(async () => {
    try {
      hydrate(await getSkill(slug));
    } catch (err) {
      toast.error((err as Error).message);
      navigateRef.current('/skills');
    }
  }, [slug, hydrate, toast]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /**
   * Operações de arquivo trocam só a lista: recarregar a skill inteira
   * repovoaria o formulário e jogaria fora o que ainda não foi salvo.
   */
  const onFiles = useCallback((update: (files: SkillFileMeta[]) => SkillFileMeta[]) => {
    setSkill((current) => {
      if (!current) return current;
      const files = update(current.files);
      return files === current.files ? current : { ...current, files, fileCount: files.length };
    });
  }, []);

  /**
   * Publicar e compartilhar (Propriedades) também gravam na hora e não mudam
   * campo nenhum do formulário: trocar só a skill preserva o que não foi salvo.
   */
  const onPanelChanged = useCallback((detail: SkillDetail) => setSkill(detail), []);

  const patchMeta = useCallback((patch: Partial<SkillMetaValues>) => setMeta((current) => ({ ...current, ...patch })), []);

  // O SKILL.md muda com o corpo e com os campos que viram o frontmatter.
  const skillMdDirty =
    skill !== null &&
    (skillMd !== stripFrontmatter(skill.skillMd) ||
      meta.name !== skill.name ||
      meta.slug !== skill.slug ||
      meta.description !== skill.description ||
      meta.tags !== skill.tags.join(', '));

  const dirty =
    skill !== null && (skillMdDirty || meta.icon.trim() !== (skill.icon ?? '') || isActive !== skill.isActive);

  const files = useSkillFiles({ skill, canWrite: podeEscrever, onFiles, onReloadAll: reload, formDirty: dirty });
  const { save: saveFile, remove: removeFile, startCreate, pickUpload, pickZip, dirtyPaths } = files;

  const frontmatter = useMemo(
    () =>
      buildFrontmatter({
        slug: meta.slug || skill?.slug || '',
        name: meta.name,
        description: meta.description,
        tags: parseTags(meta.tags),
      }),
    [meta.slug, meta.name, meta.description, meta.tags, skill?.slug],
  );

  const save = useCallback(async () => {
    if (!skill) return;
    setSaving(true);
    const prompt = stripFrontmatter(skillMd);
    try {
      const updated = await updateSkill(skill.slug, {
        name: meta.name,
        slug: meta.slug !== skill.slug ? meta.slug : undefined,
        description: meta.description,
        icon: meta.icon.trim() !== (skill.icon ?? '') ? meta.icon.trim() || null : undefined,
        tags: parseTags(meta.tags),
        isActive: isActive !== skill.isActive ? isActive : undefined,
        skillMd: prompt !== skill.skillMd ? prompt : undefined,
      });
      hydrate(updated);
      toast.success('Alterações salvas.');
      if (updated.slug !== skill.slug) {
        navigate(location.pathname.replace(`/skills/${skill.slug}/`, `/skills/${updated.slug}/`), { replace: true });
      }
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, [skill, skillMd, meta, isActive, hydrate, toast, navigate, location.pathname]);

  const editBase = `/skills/${skill?.slug ?? slug}/editar`;
  const filesPath = `${editBase}/arquivos`;

  /** O arquivo que ⌘S grava na guia Arquivos; o SKILL.md é do formulário. */
  const openFile = tab === 'arquivos' && files.selected && !isSkillMdPath(files.selected) ? files.selected : null;
  const openFileDirty = openFile !== null && dirtyPaths.has(openFile);

  const toFiles = useCallback(() => {
    if (!location.pathname.endsWith('/arquivos')) navigate(filesPath);
  }, [location.pathname, navigate, filesPath]);

  const commands: Command[] = [];
  if (skill && podeEscrever) {
    commands.push({
      id: 'skill-save',
      label: 'Salvar alterações',
      group: 'Recurso',
      icon: <Save />,
      shortcut: openFile ? undefined : '⌘ S',
      disabled: dirty ? false : 'nada a salvar',
      run: save,
    });
    if (openFile) {
      commands.push({
        id: 'file-save',
        label: `Salvar ${openFile}`,
        group: 'Recurso',
        icon: <Save />,
        shortcut: '⌘ S',
        disabled: openFileDirty ? false : 'nada a salvar',
        run: () => saveFile(openFile),
      });
    }
    commands.push(
      { id: 'file-new', label: 'Novo arquivo', group: 'Recurso', icon: <FilePlus />, keywords: ['criar', 'arquivo', 'vazio'], run: () => { toFiles(); startCreate('file'); } },
      { id: 'dir-new', label: 'Nova pasta', group: 'Recurso', icon: <FolderPlus />, keywords: ['criar', 'pasta', 'diretório'], run: () => { toFiles(); startCreate('dir'); } },
      { id: 'files-upload', label: 'Enviar arquivos', group: 'Recurso', icon: <Upload />, keywords: ['upload', 'anexar'], run: () => { toFiles(); pickUpload(); } },
      { id: 'files-zip', label: 'Importar .zip', group: 'Recurso', icon: <FileArchive />, keywords: ['zip', 'importar'], run: () => { toFiles(); pickZip(false); } },
    );
    if (openFile) {
      commands.push({ id: 'file-delete', label: `Remover ${openFile}`, group: 'Perigo', icon: <Trash2 />, danger: true, run: () => removeFile(openFile) });
    }
  }
  if (skill && tab !== 'arquivos') {
    commands.push({ id: 'files-tab', label: 'Arquivos da skill', group: 'Ir para', icon: <FolderTree />, keywords: ['arvore', 'editar arquivo'], run: () => navigate(filesPath) });
  }
  useRegisterCommands(commands, [
    skill?.slug,
    podeEscrever,
    dirty,
    save,
    openFile,
    openFileDirty,
    tab,
    toFiles,
    saveFile,
    removeFile,
    startCreate,
    pickUpload,
    pickZip,
    filesPath,
  ]);

  // ⌘S salva; o navegador não abre o "salvar página".
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 's' || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      if (!podeEscrever) return;
      if (openFile) {
        if (openFileDirty) void saveFile(openFile);
      } else if (dirty && !saving) {
        void save();
      }
    };
    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, [dirty, saving, save, podeEscrever, openFile, openFileDirty, saveFile]);

  // Recarregar ou fechar a aba com algo pendente pede confirmação ao navegador.
  const pending = dirty || dirtyPaths.size > 0;
  useEffect(() => {
    if (!pending) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [pending]);

  async function removeSkill() {
    if (!skill) return;
    const ok = await confirm({
      title: `Remover a skill "${skill.name}"?`,
      description: 'Todos os arquivos dela e os vínculos com servidores somem. Não dá para desfazer.',
      confirmLabel: 'Remover',
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteSkill(skill.slug);
      toast.success('Skill removida.');
      navigate('/skills');
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  if (!skill) {
    return (
      <div className="page wide">
        <Skel h={20} w={120} className="mb-3" />
        <Skel h={40} w={360} className="mb-6" />
        <Skel h={420} />
      </div>
    );
  }

  const base = `/skills/${skill.slug}`;

  return (
    <div className={`page wide${tab === 'arquivos' ? ' workbench' : ''}`}>
      <div className="page-head">
        <div className="min-w-0">
          <Link to={base} className="back-link">
            <ArrowLeft /> {skill.name}
          </Link>
          <div className="flex items-center gap-3">
            <SkillIcon icon={meta.icon.trim() || null} name={meta.name || skill.name} slug={skill.slug} size="lg" />
            <div className="min-w-0">
              <h1 className="truncate">{meta.name || skill.name}</h1>
              <p className="sub mono flex flex-wrap items-center gap-x-3">
                <span>{skill.slug}</span>
                <span>· editando</span>
                <McpChips skill={skill} compact />
              </p>
            </div>
          </div>
        </div>

        <div className="page-actions">
          {noSite(skill) && (
            <a href={`${session.siteBaseUrl}/skills/${skill.slug}`} target="_blank" rel="noreferrer" className="btn btn-quiet btn-sm">
              <ExternalLink /> ver no site
            </a>
          )}
          <Link to={base} className="btn btn-ghost">
            <Eye /> Visualizar
          </Link>
          {podeEscrever && (
            <Button onClick={() => void save()} disabled={saving || !dirty} title="Grava descrição, SKILL.md e propriedades">
              <Save /> {saving ? 'Salvando…' : dirty ? 'Salvar' : 'Salvo'}
            </Button>
          )}
        </div>
      </div>

      {!podeEscrever && (
        <p className="notice warn mb-4">
          Você não edita o conteúdo desta skill: os campos aparecem travados. O que você administra — os servidores em que
          ela pode ser publicada — está em Propriedades.
        </p>
      )}

      <Tabs
        value={tab}
        items={[
          { key: 'skill', label: 'Skill', icon: <FileText />, to: editBase },
          { key: 'arquivos', label: 'Arquivos', icon: <FolderTree />, to: filesPath, count: skill.files.length },
          { key: 'propriedades', label: 'Propriedades', icon: <SlidersHorizontal />, to: `${editBase}/propriedades` },
        ]}
      />

      <Routes>
        <Route
          index
          element={
            <SkillTab
              skill={skill}
              description={meta.description}
              onDescription={(description) => patchMeta({ description })}
              skillMd={skillMd}
              onSkillMd={setSkillMd}
              frontmatter={frontmatter}
              canWrite={podeEscrever}
              filesPath={filesPath}
              onOpenFile={(path) => {
                files.open(path);
                navigate(filesPath);
              }}
            />
          }
        />
        <Route
          path="arquivos"
          element={
            <SkillFilesTab
              ws={files}
              slug={skill.slug}
              canWrite={podeEscrever}
              skillMd={{
                body: skillMd,
                onBody: setSkillMd,
                frontmatter,
                dirty: skillMdDirty,
                formDirty: dirty,
                saving,
                onSave: () => void save(),
              }}
            />
          }
        />
        <Route
          path="propriedades"
          element={
            <PropertiesTab
              skill={skill}
              user={user}
              meta={meta}
              onMeta={patchMeta}
              isActive={isActive}
              onActive={setIsActive}
              canWrite={podeEscrever}
              canManage={podeAdministrar}
              canDelete={podeApagar}
              onChanged={onPanelChanged}
              onRemove={removeSkill}
            />
          }
        />
        {/* O registro de leituras mora na ficha de leitura; um link antigo para cá vai para lá. */}
        <Route path="acessos" element={<Navigate to={`${base}/acessos`} replace />} />
        <Route path="*" element={<Navigate to={editBase} replace />} />
      </Routes>

      <FilePickers ws={files} />
    </div>
  );
}

// ------------------------------------------------------------ guia Skill ---

/**
 * A descrição e o SKILL.md (renderizado ou cru, e aqui o cru é editável), com
 * a árvore ao lado como na leitura. Escolher um arquivo o abre na guia
 * Arquivos, que é onde se cria, envia, importa e remove.
 */
function SkillTab({
  skill,
  description,
  onDescription,
  skillMd,
  onSkillMd,
  frontmatter,
  canWrite,
  filesPath,
  onOpenFile,
}: {
  skill: SkillDetail;
  description: string;
  onDescription: (value: string) => void;
  skillMd: string;
  onSkillMd: (value: string) => void;
  frontmatter: string;
  canWrite: boolean;
  filesPath: string;
  onOpenFile: (path: string) => void;
}) {
  const [pane, setPane] = useState<DocPane>('source');

  return (
    <>
      <DescriptionBox description={description}>
        <textarea
          className="field"
          value={description}
          onChange={(event) => onDescription(event.target.value)}
          rows={3}
          disabled={!canWrite}
          placeholder="O que esta skill faz e quando usá-la — é por ela que o agente decide acionar a skill."
        />
      </DescriptionBox>

      <div className="skill-read">
        <div className="doc-box">
          <div className="doc-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={pane === 'render'} className={pane === 'render' ? 'active' : ''} onClick={() => setPane('render')}>
              Skill
            </button>
            <button type="button" role="tab" aria-selected={pane === 'source'} className={pane === 'source' ? 'active' : ''} onClick={() => setPane('source')}>
              SKILL.md
            </button>
          </div>

          {pane === 'render' ? (
            <div className="doc-body">
              <Markdown>{skillMd || VAZIO}</Markdown>
            </div>
          ) : (
            <div className="doc-edit">
              <pre className="doc-frontmatter">
                <span className="t">Primeiras linhas do SKILL.md, geradas da descrição e das propriedades</span>
                {frontmatter}
              </pre>
              <textarea
                value={skillMd}
                onChange={(event) => onSkillMd(event.target.value)}
                rows={26}
                spellCheck={false}
                disabled={!canWrite}
                className="field field-mono resize-y"
                placeholder={'# Título\n\n## Quando usar\n\nDescreva o gatilho da skill.'}
              />
            </div>
          )}
        </div>

        <Panel
          className="aside-sticky"
          title="Arquivos"
          icon={<FolderTree />}
          actions={
            <Link to={filesPath} className="link-action">
              Abrir a guia
            </Link>
          }
        >
          <FileTree
            slug={skill.slug}
            files={skill.files}
            selected={pane === 'source' ? 'SKILL.md' : null}
            onPick={(path) => (isSkillMdPath(path) ? setPane('source') : onOpenFile(path))}
          />
          <p className="panel-hint mt-3 mb-0">
            Clique num arquivo para abri-lo na guia <Link to={filesPath} className="link">Arquivos</Link>, onde também se
            criam arquivos e pastas, se enviam anexos e se importa um .zip.
          </p>
        </Panel>
      </div>
    </>
  );
}

// ---------------------------------------------------- guia Propriedades ---

/**
 * Metadados e estado (gravados pelo Salvar do cabeçalho), publicação por
 * servidor (grava na hora), catálogos (leitura: a edição é no catálogo),
 * acesso (grava na hora) e, para o dono, a zona de perigo.
 */
function PropertiesTab({
  skill,
  user,
  meta,
  onMeta,
  isActive,
  onActive,
  canWrite,
  canManage: manages,
  canDelete,
  onChanged,
  onRemove,
}: {
  skill: SkillDetail;
  user: SessionUser;
  meta: SkillMetaValues;
  onMeta: (patch: Partial<SkillMetaValues>) => void;
  isActive: boolean;
  onActive: (value: boolean) => void;
  canWrite: boolean;
  canManage: boolean;
  canDelete: boolean;
  onChanged: (detail: SkillDetail) => void;
  onRemove: () => Promise<void>;
}) {
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,380px)]">
      <div className="grid content-start gap-4">
        <Panel title="Propriedades" icon={<SlidersHorizontal />}>
          <SkillMetaForm values={meta} onChange={onMeta} hideDescription disabled={!canWrite} />
          <label className="check mt-4" title="Desligada, a skill some de todo servidor e do site — direto ou por catálogo — sem perder vínculo nenhum.">
            <input type="checkbox" checked={isActive} onChange={(event) => onActive(event.target.checked)} disabled={!manages} />
            Skill ligada: desligada, não é entregue por servidor nenhum nem aparece no site (os vínculos e os catálogos ficam)
          </label>
          {!manages && canWrite && (
            <p className="hint mt-1">Slug e estado são de quem administra a skill; você edita o conteúdo e os demais metadados.</p>
          )}
          <p className="panel-hint mt-3 mb-0">Estes campos são gravados pelo botão Salvar, junto com a descrição e o SKILL.md.</p>
        </Panel>

        <SkillMcpsPanel skill={skill} onChanged={onChanged} />
      </div>

      <div className="grid content-start gap-4">
        <SkillCatalogsPanel skill={skill} />
        <AccessPanel
          kind="skill"
          object={skill}
          user={user}
          onPatch={(body) => updateSkill(skill.slug, body)}
          onChanged={onChanged}
          publicHint="Não a publica em servidor nenhum: onde ela aparece continua sendo o vínculo."
        />
        {canDelete && (
          <Panel title="Zona de perigo" icon={<Trash2 />}>
            <p className="panel-hint">Remover apaga a skill, todos os arquivos dela e os vínculos com servidores e catálogos. Não dá para desfazer.</p>
            <Button variant="danger" onClick={() => void onRemove()}>
              <Trash2 /> Remover skill
            </Button>
          </Panel>
        )}
      </div>
    </div>
  );
}

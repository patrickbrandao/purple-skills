import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Download, ExternalLink, Eye, FileText, History, Save, SlidersHorizontal, Trash2, Upload, X } from 'lucide-react';
import {
  canEdit,
  canManage,
  canOwn,
  deleteFile,
  deleteSkill,
  getFile,
  getSkill,
  getSkillAccesses,
  rawFileUrl,
  setFile as putFile,
  skillDownloadUrl,
  skillPackageUrl,
  updateSkill,
  uploadFiles,
  uploadZip,
  type Session,
  type SessionUser,
  type SkillDetail,
} from '../api.js';
import { AccessPanel } from '../components/AccessPanel.js';
import { AccessLog } from '../components/AccessLog.js';
import { Button, McpChips, Panel, Skel, Tabs, noSite, useConfirm } from '../components/ui.js';
import { FileTree } from '../components/FileTree.js';
import { Markdown } from '../components/Markdown.js';
import { SkillIcon } from '../components/SkillIcon.js';
import { SkillMetaForm, type SkillMetaValues } from '../components/SkillMetaForm.js';
import { SkillCatalogsPanel, SkillMcpsPanel } from '../components/SkillMcps.js';
import { buildFrontmatter, parseTags, stripFrontmatter } from '../frontmatter.js';
import { useToast } from '../components/Toast.js';
import { useRegisterCommands } from '../components/commands.js';
import { DescriptionBox } from './SkillViewPage.js';

type Tab = 'skill' | 'propriedades' | 'acessos';
type DocPane = 'render' | 'source';

const VAZIO = '_Esta skill ainda não tem conteúdo em SKILL.md._';

/**
 * A ficha da skill em edição (`docs/13-fichas-e-acessos.md`): a mesma
 * organização da leitura — Skill, Propriedades, Acessos — com os campos
 * livres onde a sessão pode. Um único Salvar (e ⌘S) grava descrição, prompt,
 * metadados e o estado; publicação, acesso e arquivos gravam na hora, como
 * antes. Conteúdo e metadados são `edit`; slug e estado são `manage`; apagar
 * é do dono (`docs/12-acesso-granular.md` §3.2). Quem só administra um
 * servidor entra aqui para publicar a skill nele: vê os campos travados e as
 * portas do seu servidor livres.
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
    : location.pathname.endsWith('/acessos')
      ? 'acessos'
      : 'skill';

  const hydrate = useCallback((detail: SkillDetail) => {
    setSkill(detail);
    setMeta({ name: detail.name, slug: detail.slug, description: detail.description, tags: detail.tags.join(', '), icon: detail.icon ?? '' });
    setIsActive(detail.isActive);
    setSkillMd(stripFrontmatter(detail.skillMd));
  }, []);

  const reload = useCallback(async () => {
    try {
      hydrate(await getSkill(slug));
    } catch (err) {
      toast.error((err as Error).message);
      navigate('/skills');
    }
  }, [slug, hydrate, toast, navigate]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const patchMeta = useCallback((patch: Partial<SkillMetaValues>) => setMeta((current) => ({ ...current, ...patch })), []);

  const dirty =
    skill !== null &&
    (meta.name !== skill.name ||
      meta.slug !== skill.slug ||
      meta.description !== skill.description ||
      meta.tags !== skill.tags.join(', ') ||
      meta.icon.trim() !== (skill.icon ?? '') ||
      isActive !== skill.isActive ||
      skillMd !== stripFrontmatter(skill.skillMd));

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

  useRegisterCommands(
    skill && podeEscrever ? [{ id: 'skill-save', label: 'Salvar alterações', group: 'Recurso', icon: <Save />, shortcut: '⌘ S', disabled: dirty ? false : 'nada a salvar', run: save }] : [],
    [skill?.slug, dirty, save, podeEscrever],
  );

  // ⌘S salva; o navegador não abre o "salvar página".
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 's' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        if (dirty && !saving && podeEscrever) void save();
      }
    };
    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, [dirty, saving, save, podeEscrever]);

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

  const loadAccesses = useCallback(
    (query: Parameters<typeof getSkillAccesses>[1]) => getSkillAccesses(slug, query),
    [slug],
  );

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
  const editBase = `${base}/editar`;

  return (
    <div className="page wide">
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
            <Button onClick={() => void save()} disabled={saving || !dirty}>
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
          { key: 'propriedades', label: 'Propriedades', icon: <SlidersHorizontal />, to: `${editBase}/propriedades` },
          ...(podeAdministrar ? [{ key: 'acessos', label: 'Acessos', icon: <History />, to: `${editBase}/acessos` }] : []),
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
              meta={meta}
              canWrite={podeEscrever}
              onReload={reload}
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
              onChanged={hydrate}
              onRemove={removeSkill}
            />
          }
        />
        {podeAdministrar && <Route path="acessos" element={<AccessLog load={loadAccesses} />} />}
      </Routes>
    </div>
  );
}

// ------------------------------------------------------------ guia Skill ---

/**
 * A descrição, o SKILL.md (renderizado ou cru, e aqui o cru é editável) e a
 * árvore de arquivos com upload e remoção. Escolher um arquivo da árvore
 * troca a caixa do prompt pelo editor daquele arquivo; o SKILL.md volta às
 * duas guias.
 */
function SkillTab({
  skill,
  description,
  onDescription,
  skillMd,
  onSkillMd,
  meta,
  canWrite,
  onReload,
}: {
  skill: SkillDetail;
  description: string;
  onDescription: (value: string) => void;
  skillMd: string;
  onSkillMd: (value: string) => void;
  meta: SkillMetaValues;
  canWrite: boolean;
  onReload: () => Promise<void>;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [pane, setPane] = useState<DocPane>('source');
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileDirty, setFileDirty] = useState(false);
  const [replaceTree, setReplaceTree] = useState(false);
  const zipInput = useRef<HTMLInputElement>(null);
  const filesInput = useRef<HTMLInputElement>(null);

  const frontmatter = useMemo(
    () => buildFrontmatter({ slug: meta.slug || skill.slug, name: meta.name, description, tags: parseTags(meta.tags) }),
    [meta.slug, meta.name, meta.tags, description, skill.slug],
  );

  function pickFile(path: string) {
    if (path.toLowerCase() === 'skill.md') {
      closeFile();
      return;
    }
    void openFile(path);
  }

  async function openFile(path: string) {
    setSelectedFile(path);
    setFileContent(null);
    setFileDirty(false);
    try {
      const file = await getFile(skill.slug, path);
      setFileContent(file.content);
    } catch (err) {
      toast.error((err as Error).message);
      setSelectedFile(null);
    }
  }

  function closeFile() {
    setSelectedFile(null);
    setFileContent(null);
    setFileDirty(false);
  }

  async function saveFile() {
    if (!selectedFile || fileContent === null) return;
    try {
      await putFile(skill.slug, selectedFile, fileContent);
      setFileDirty(false);
      toast.success(`${selectedFile} salvo.`);
      await onReload();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function removeFile(path: string) {
    const ok = await confirm({ title: `Remover o arquivo "${path}"?`, confirmLabel: 'Remover', danger: true });
    if (!ok) return;
    try {
      await deleteFile(skill.slug, path);
      if (selectedFile === path) closeFile();
      toast.success(`${path} removido.`);
      await onReload();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function handleZip(file: File, replace: boolean) {
    try {
      await uploadZip(skill.slug, file, replace);
      toast.success(replace ? 'Árvore de arquivos substituída pelo .zip.' : 'Arquivos importados do .zip.');
      await onReload();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function handleFiles(files: FileList) {
    try {
      await uploadFiles(skill.slug, files);
      toast.success(`${files.length} arquivo(s) enviado(s).`);
      await onReload();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

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
            <button type="button" role="tab" aria-selected={!selectedFile && pane === 'render'} className={!selectedFile && pane === 'render' ? 'active' : ''} onClick={() => { closeFile(); setPane('render'); }}>
              Skill
            </button>
            <button type="button" role="tab" aria-selected={!selectedFile && pane === 'source'} className={!selectedFile && pane === 'source' ? 'active' : ''} onClick={() => { closeFile(); setPane('source'); }}>
              SKILL.md
            </button>
            {selectedFile && (
              <button type="button" role="tab" aria-selected className="active doc-file" title={selectedFile}>
                <span className="path">{selectedFile}</span>
                {fileDirty && <span title="Alterações não salvas">•</span>}
                <span className="close" role="button" aria-label="Fechar arquivo" onClick={(event) => { event.stopPropagation(); closeFile(); }}>
                  <X />
                </span>
              </button>
            )}
            {selectedFile && (
              <span className="doc-actions">
                <a href={rawFileUrl(skill.slug, selectedFile)} target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm">
                  Abrir cru
                </a>
                {canWrite && (
                  <Button size="sm" onClick={() => void saveFile()} disabled={fileContent === null || !fileDirty}>
                    Salvar arquivo
                  </Button>
                )}
              </span>
            )}
          </div>

          {selectedFile ? (
            <div className="doc-edit">
              {fileContent === null ? (
                <Skel h={320} />
              ) : (
                <textarea
                  value={fileContent}
                  onChange={(event) => { setFileContent(event.target.value); setFileDirty(true); }}
                  rows={24}
                  spellCheck={false}
                  disabled={!canWrite}
                  className="field field-mono"
                />
              )}
            </div>
          ) : pane === 'render' ? (
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
          icon={<FileText />}
          actions={
            canWrite ? (
              <button type="button" onClick={() => filesInput.current?.click()} title="Enviar arquivos" className="row-action">
                <Upload />
              </button>
            ) : undefined
          }
        >
          <FileTree slug={skill.slug} files={skill.files} selected={selectedFile} onPick={pickFile} onDelete={canWrite ? removeFile : undefined} />
          <p className="panel-hint mt-3">
            Clique em um arquivo de texto para editá-lo no lugar do prompt; o <code>SKILL.md</code> volta às guias Skill e SKILL.md.
          </p>

          <div className="flex flex-col gap-3 border-t pt-4" style={{ borderColor: 'var(--surface-3)' }}>
            <div className="flex flex-wrap gap-2">
              <a href={skillDownloadUrl(skill.slug)} className="btn btn-ghost btn-sm" download>
                <Download /> .zip
              </a>
              <a href={skillPackageUrl(skill.slug)} className="btn btn-ghost btn-sm" download>
                <Download /> .skill
              </a>
            </div>
            {canWrite && (
              <>
                <Button variant="ghost" size="sm" onClick={() => zipInput.current?.click()}>
                  <Upload /> Importar .zip
                </Button>
                <label className="check items-start text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
                  <input type="checkbox" className="mt-0.5" checked={replaceTree} onChange={(event) => setReplaceTree(event.target.checked)} />
                  <span>Substituir toda a árvore — arquivos ausentes no .zip são removidos (o SKILL.md é sempre preservado).</span>
                </label>
              </>
            )}
          </div>

          <input
            ref={zipInput}
            type="file"
            accept=".zip,application/zip"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void handleZip(file, replaceTree);
              event.target.value = '';
            }}
          />
          <input
            ref={filesInput}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => {
              if (event.target.files?.length) void handleFiles(event.target.files);
              event.target.value = '';
            }}
          />
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

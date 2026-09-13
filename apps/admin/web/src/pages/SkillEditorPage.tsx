import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Download, ExternalLink, Eye, FileText, Save, Trash2, Upload } from 'lucide-react';
import {
  canDelete,
  canWrite,
  deleteFile,
  deleteSkill,
  getFile,
  getSkill,
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
import { Button, McpChips, Panel, Skel, Tabs, noSite, useConfirm } from '../components/ui.js';
import { FileTree } from '../components/FileTree.js';
import { SkillIcon } from '../components/SkillIcon.js';
import { FrontmatterPreview, SkillMetaForm, type SkillMetaValues } from '../components/SkillMetaForm.js';
import { PromptEditor } from '../components/PromptEditor.js';
import { parseTags, stripFrontmatter } from '../frontmatter.js';
import { useToast } from '../components/Toast.js';
import { useRegisterCommands } from '../components/commands.js';

type Tab = 'skill' | 'files';

export function SkillEditorPage({ session, user }: { session: Session; user: SessionUser }) {
  const podeEscrever = canWrite(user.role);
  const podeApagar = canDelete(user.role);
  const { slug = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();

  const [skill, setSkill] = useState<SkillDetail | null>(null);
  const [tab, setTab] = useState<Tab>('skill');
  const [saving, setSaving] = useState(false);
  const [meta, setMeta] = useState<SkillMetaValues>({ name: '', slug: '', description: '', tags: '', icon: '' });
  const [skillMd, setSkillMd] = useState('');
  const [replaceTree, setReplaceTree] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const zipInput = useRef<HTMLInputElement>(null);
  const filesInput = useRef<HTMLInputElement>(null);

  const hydrate = useCallback((detail: SkillDetail) => {
    setSkill(detail);
    setMeta({ name: detail.name, slug: detail.slug, description: detail.description, tags: detail.tags.join(', '), icon: detail.icon ?? '' });
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
        skillMd: prompt !== skill.skillMd ? prompt : undefined,
      });
      hydrate(updated);
      toast.success('Alterações salvas.');
      if (updated.slug !== skill.slug) navigate(`/skills/${updated.slug}/editar`, { replace: true });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, [skill, skillMd, meta, hydrate, toast, navigate]);

  useRegisterCommands(
    skill && podeEscrever ? [{ id: 'skill-save', label: 'Salvar alterações', group: 'Recurso', icon: <Save />, shortcut: '⌘ S', disabled: dirty ? false : 'nada a salvar', run: save }] : [],
    [skill?.slug, dirty, save, podeEscrever],
  );

  // ⌘S salva; o navegador não abre o "salvar página".
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 's' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        if (dirty && !saving) void save();
      }
    };
    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, [dirty, saving, save]);

  function pickFile(path: string) {
    if (path.toLowerCase() === 'skill.md') {
      setTab('skill');
      return;
    }
    void openFile(path);
  }

  async function openFile(path: string) {
    setSelectedFile(path);
    setFileContent(null);
    try {
      const file = await getFile(slug, path);
      setFileContent(file.content);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function saveFile() {
    if (!selectedFile || fileContent === null) return;
    try {
      await putFile(slug, selectedFile, fileContent);
      toast.success(`${selectedFile} salvo.`);
      await reload();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function removeFile(path: string) {
    const ok = await confirm({ title: `Remover o arquivo "${path}"?`, confirmLabel: 'Remover', danger: true });
    if (!ok) return;
    try {
      await deleteFile(slug, path);
      if (selectedFile === path) setSelectedFile(null);
      toast.success(`${path} removido.`);
      await reload();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function handleZip(file: File, replace: boolean) {
    try {
      await uploadZip(slug, file, replace);
      toast.success(replace ? 'Árvore de arquivos substituída pelo .zip.' : 'Arquivos importados do .zip.');
      await reload();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function handleFiles(files: FileList) {
    try {
      await uploadFiles(slug, files);
      toast.success(`${files.length} arquivo(s) enviado(s).`);
      await reload();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

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

  const attachments = useMemo(() => skill?.files.filter((file) => file.relativePath.toLowerCase() !== 'skill.md') ?? [], [skill]);

  if (!skill) {
    return (
      <div className="page wide">
        <Skel h={20} w={120} className="mb-3" />
        <Skel h={40} w={360} className="mb-6" />
        <Skel h={420} />
      </div>
    );
  }

  return (
    <div className="page wide">
      <div className="page-head">
        <div className="min-w-0">
          <Link to={`/skills/${skill.slug}`} className="back-link">
            <ArrowLeft /> {skill.name}
          </Link>
          <div className="flex items-center gap-3">
            <SkillIcon icon={meta.icon.trim() || null} name={meta.name || skill.name} slug={skill.slug} size="lg" />
            <div className="min-w-0">
              <h1 className="truncate">{skill.name}</h1>
              <p className="sub mono flex flex-wrap items-center gap-x-3">
                <span>{skill.slug}</span>
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
          <Link to={`/skills/${skill.slug}`} className="btn btn-ghost">
            <Eye /> Visualizar
          </Link>
          {podeApagar && (
            <Button variant="danger" onClick={() => void removeSkill()}>
              <Trash2 /> Remover
            </Button>
          )}
          {podeEscrever && (
            <Button onClick={() => void save()} disabled={saving || !dirty}>
              <Save /> {saving ? 'Salvando…' : dirty ? 'Salvar' : 'Salvo'}
            </Button>
          )}
        </div>
      </div>

      <Tabs
        value={tab}
        onChange={(key) => setTab(key as Tab)}
        items={[
          { key: 'skill', label: 'SKILL.md' },
          { key: 'files', label: 'Arquivos', count: attachments.length },
        ]}
      />

      {tab === 'skill' && (
        <Panel>
          <SkillMetaForm values={meta} onChange={patchMeta} />
          <FrontmatterPreview values={meta} />
          <PromptEditor value={skillMd} onChange={setSkillMd} />
        </Panel>
      )}

      {tab === 'files' && (
        <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
          <Panel
            className="aside-sticky"
            title="Arquivos"
            icon={<FileText />}
            actions={
              podeEscrever ? (
                <button type="button" onClick={() => filesInput.current?.click()} title="Enviar arquivos" className="row-action">
                  <Upload />
                </button>
              ) : undefined
            }
          >
            <p className="panel-hint">
              A pasta da skill como ela sai do <code>.zip</code>. Clique em um arquivo de texto para editá-lo aqui; o{' '}
              <code>SKILL.md</code> leva para a aba ao lado.
            </p>

            <FileTree slug={skill.slug} files={skill.files} selected={selectedFile} onPick={pickFile} onDelete={podeEscrever ? removeFile : undefined} />

            <div className="mt-4 flex flex-col gap-3 border-t pt-4" style={{ borderColor: 'var(--surface-3)' }}>
              <div className="flex flex-wrap gap-2">
                <a href={skillDownloadUrl(skill.slug)} className="btn btn-ghost btn-sm" download>
                  <Download /> .zip
                </a>
                <a href={skillPackageUrl(skill.slug)} className="btn btn-ghost btn-sm" download>
                  <Download /> .skill
                </a>
              </div>
              {podeEscrever && (
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

          <Panel>
            {!selectedFile && <p className="list-empty">Selecione um arquivo de texto à esquerda para editar.</p>}
            {selectedFile && (
              <>
                <div className="mb-3 flex items-center justify-between gap-3">
                  <code className="mono truncate text-xs" style={{ color: 'var(--accent-soft)' }}>
                    {selectedFile}
                  </code>
                  <div className="flex shrink-0 gap-2">
                    <a href={rawFileUrl(slug, selectedFile)} target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm">
                      Abrir cru
                    </a>
                    {podeEscrever && (
                      <Button size="sm" onClick={() => void saveFile()} disabled={fileContent === null}>
                        Salvar arquivo
                      </Button>
                    )}
                  </div>
                </div>
                <textarea value={fileContent ?? ''} onChange={(event) => setFileContent(event.target.value)} rows={24} spellCheck={false} className="field field-mono" />
              </>
            )}
          </Panel>
        </div>
      )}
    </div>
  );
}

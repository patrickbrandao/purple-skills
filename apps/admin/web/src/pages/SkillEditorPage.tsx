import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  deleteFile,
  deleteSkill,
  formatBytes,
  getFile,
  getSkill,
  rawFileUrl,
  setFile as putFile,
  updateSkill,
  uploadFiles,
  uploadZip,
  type Session,
  type SkillDetail,
} from '../api.js';
import { Badge, Button, Card, inputClass, labelClass } from '../components/ui.js';
import { ExternalIcon, FileIcon, SaveIcon, TrashIcon, UploadIcon } from '../components/Icons.js';
import { Markdown } from '../components/Markdown.js';
import { useToast } from '../components/Toast.js';

type Tab = 'content' | 'settings' | 'files';

export function SkillEditorPage({ session }: { session: Session }) {
  const { slug = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();

  const [skill, setSkill] = useState<SkillDetail | null>(null);
  const [tab, setTab] = useState<Tab>('content');
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);

  const [name, setName] = useState('');
  const [newSlug, setNewSlug] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [isPublic, setIsPublic] = useState(false);
  const [skillMd, setSkillMd] = useState('');

  const [replaceTree, setReplaceTree] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const zipInput = useRef<HTMLInputElement>(null);
  const filesInput = useRef<HTMLInputElement>(null);

  const hydrate = useCallback((detail: SkillDetail) => {
    setSkill(detail);
    setName(detail.name);
    setNewSlug(detail.slug);
    setDescription(detail.description);
    setTags(detail.tags.join(', '));
    setIsPublic(detail.isPublic);
    setSkillMd(detail.skillMd);
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

  async function save() {
    if (!skill) return;
    setSaving(true);

    try {
      const updated = await updateSkill(skill.slug, {
        name,
        slug: newSlug !== skill.slug ? newSlug : undefined,
        description,
        tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean),
        isPublic,
        skillMd: skillMd !== skill.skillMd ? skillMd : undefined,
      });

      hydrate(updated);
      toast.success('Alterações salvas.');
      if (updated.slug !== skill.slug) navigate(`/skills/${updated.slug}`, { replace: true });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
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
    if (!window.confirm(`Remover o arquivo "${path}"?`)) return;
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
      toast.success(
        replace ? 'Árvore de arquivos substituída pelo .zip.' : 'Arquivos importados do .zip.',
      );
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
    if (!window.confirm(`Remover a skill "${skill.name}" e todos os seus arquivos?`)) return;
    try {
      await deleteSkill(skill.slug);
      toast.success('Skill removida.');
      navigate('/skills');
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  if (!skill) {
    return <div className="h-64 animate-pulse rounded-2xl bg-ink-850/60" />;
  }

  const attachments = skill.files.filter((file) => file.relativePath.toLowerCase() !== 'skill.md');
  const dirty =
    name !== skill.name ||
    newSlug !== skill.slug ||
    description !== skill.description ||
    tags !== skill.tags.join(', ') ||
    isPublic !== skill.isPublic ||
    skillMd !== skill.skillMd;

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Link to="/skills" className="text-xs text-slate-500 transition hover:text-purple-300">
            ← Skills
          </Link>
          <h1 className="mt-1 flex items-center gap-3 text-2xl font-semibold text-purple-50">
            <span className="truncate">{skill.name}</span>
            <Badge isPublic={skill.isPublic} />
          </h1>
          <p className="mt-1 flex items-center gap-3 text-xs text-slate-600">
            <span>{skill.slug}</span>
            <span>· {skill.viewCount} acessos</span>
            <span>· {skill.downloadCount} downloads</span>
            {skill.isPublic && (
              <a
                href={`${session.siteBaseUrl}/skills/${skill.slug}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-purple-400 hover:text-purple-300"
              >
                <ExternalIcon className="h-3 w-3" /> ver no site
              </a>
            )}
          </p>
        </div>

        <div className="flex gap-2">
          <Button variant="danger" onClick={removeSkill}>
            <TrashIcon /> Remover
          </Button>
          <Button onClick={save} disabled={saving || !dirty}>
            <SaveIcon /> {saving ? 'Salvando…' : dirty ? 'Salvar' : 'Salvo'}
          </Button>
        </div>
      </div>

      <div className="mt-6 flex gap-1 border-b border-purple-400/10">
        {(
          [
            ['content', 'SKILL.md'],
            ['settings', 'Metadados'],
            ['files', `Arquivos (${attachments.length})`],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={`-mb-px border-b-2 px-4 py-2.5 text-sm font-medium transition ${
              tab === value
                ? 'border-purple-500 text-purple-200'
                : 'border-transparent text-slate-500 hover:text-purple-300'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'content' && (
        <div className="mt-5">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-xs text-slate-600">
              Markdown com frontmatter YAML. O conteúdo alimenta a busca full-text.
            </p>
            <button
              type="button"
              onClick={() => setPreview((current) => !current)}
              className="rounded-lg border border-purple-400/15 px-3 py-1.5 text-xs text-slate-400 transition hover:border-purple-400/40 hover:text-purple-200"
            >
              {preview ? 'Editar' : 'Pré-visualizar'}
            </button>
          </div>

          {preview ? (
            <Card className="min-h-[28rem]">
              <Markdown>{skillMd}</Markdown>
            </Card>
          ) : (
            <textarea
              value={skillMd}
              onChange={(event) => setSkillMd(event.target.value)}
              rows={28}
              spellCheck={false}
              className={`${inputClass} resize-y font-mono text-[13px] leading-relaxed`}
            />
          )}
        </div>
      )}

      {tab === 'settings' && (
        <Card className="mt-5 max-w-2xl space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className={labelClass}>Nome</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                className={`${inputClass} mt-1.5`}
              />
            </label>
            <label className="block">
              <span className={labelClass}>Slug</span>
              <input
                value={newSlug}
                onChange={(event) => setNewSlug(event.target.value)}
                className={`${inputClass} mt-1.5`}
              />
            </label>
          </div>

          <label className="block">
            <span className={labelClass}>Descrição</span>
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={3}
              className={`${inputClass} mt-1.5 resize-y`}
            />
          </label>

          <label className="block">
            <span className={labelClass}>Tags (separadas por vírgula)</span>
            <input
              value={tags}
              onChange={(event) => setTags(event.target.value)}
              className={`${inputClass} mt-1.5`}
            />
          </label>

          <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-purple-400/15 bg-ink-900/60 px-3.5 py-3">
            <input
              type="checkbox"
              checked={isPublic}
              onChange={(event) => setIsPublic(event.target.checked)}
              className="h-4 w-4 accent-purple-500"
            />
            <span className="text-sm text-purple-100">
              Skill pública — visível no site, na API e no MCP público
            </span>
          </label>
        </Card>
      )}

      {tab === 'files' && (
        <div className="mt-5 grid gap-5 lg:grid-cols-[280px_minmax(0,1fr)]">
          <Card className="lg:sticky lg:top-20 lg:self-start">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-semibold tracking-wider text-slate-500 uppercase">
                Arquivos
              </h2>
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={() => filesInput.current?.click()}
                  title="Enviar arquivos"
                  className="rounded-md p-1.5 text-slate-500 transition hover:bg-ink-800 hover:text-purple-300"
                >
                  <UploadIcon className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            <ul className="mt-3 space-y-0.5">
              {skill.files.map((file) => (
                <li key={file.relativePath} className="group flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => file.isText && openFile(file.relativePath)}
                    disabled={!file.isText}
                    className={`flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition ${
                      selectedFile === file.relativePath
                        ? 'bg-purple-600/20 text-purple-200'
                        : file.isText
                          ? 'text-slate-400 hover:bg-ink-800 hover:text-purple-200'
                          : 'cursor-default text-slate-600'
                    }`}
                  >
                    <FileIcon className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{file.relativePath}</span>
                    <span className="ml-auto shrink-0 text-[10px] text-slate-600">
                      {formatBytes(file.sizeBytes)}
                    </span>
                  </button>
                  {file.relativePath.toLowerCase() !== 'skill.md' && (
                    <button
                      type="button"
                      onClick={() => removeFile(file.relativePath)}
                      title="Remover arquivo"
                      className="rounded p-1 text-slate-700 opacity-0 transition group-hover:opacity-100 hover:text-red-400"
                    >
                      <TrashIcon className="h-3.5 w-3.5" />
                    </button>
                  )}
                </li>
              ))}
            </ul>

            <div className="mt-4 flex flex-col gap-2 border-t border-purple-400/10 pt-4">
              <Button variant="ghost" className="!py-2 !text-xs" onClick={() => zipInput.current?.click()}>
                <UploadIcon className="h-3.5 w-3.5" /> Importar .zip
              </Button>
              <label className="flex cursor-pointer items-start gap-2 text-[11px] leading-relaxed text-slate-500">
                <input
                  type="checkbox"
                  checked={replaceTree}
                  onChange={(event) => setReplaceTree(event.target.checked)}
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-purple-500"
                />
                <span>
                  Substituir toda a árvore — arquivos ausentes no .zip são removidos (o SKILL.md é
                  sempre preservado). Desmarcado, o .zip apenas adiciona e sobrescreve.
                </span>
              </label>
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
          </Card>

          <Card>
            {!selectedFile && (
              <p className="py-16 text-center text-sm text-slate-600">
                Selecione um arquivo de texto à esquerda para editar.
              </p>
            )}

            {selectedFile && (
              <>
                <div className="mb-3 flex items-center justify-between gap-3">
                  <code className="truncate font-mono text-xs text-purple-300">{selectedFile}</code>
                  <div className="flex shrink-0 gap-2">
                    <a
                      href={rawFileUrl(slug, selectedFile)}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-lg border border-purple-400/15 px-3 py-1.5 text-xs text-slate-400 transition hover:text-purple-200"
                    >
                      Abrir cru
                    </a>
                    <Button className="!py-1.5 !text-xs" onClick={saveFile} disabled={fileContent === null}>
                      Salvar arquivo
                    </Button>
                  </div>
                </div>
                <textarea
                  value={fileContent ?? ''}
                  onChange={(event) => setFileContent(event.target.value)}
                  rows={24}
                  spellCheck={false}
                  className={`${inputClass} resize-y font-mono text-[13px] leading-relaxed`}
                />
              </>
            )}
          </Card>
        </div>
      )}
    </>
  );
}

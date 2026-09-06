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
  canDelete,
  canWrite,
  type Session,
  type SessionUser,
  type SkillDetail,
} from '../api.js';
import { Badge, Button, Field, Panel } from '../components/ui.js';
import {
  ArrowLeftIcon,
  ExternalIcon,
  FileIcon,
  SaveIcon,
  TrashIcon,
  UploadIcon,
} from '../components/Icons.js';
import { Markdown } from '../components/Markdown.js';
import { useToast } from '../components/Toast.js';

type Tab = 'content' | 'settings' | 'files';

export function SkillEditorPage({ session, user }: { session: Session; user: SessionUser }) {
  // O servidor recusa a escrita de qualquer forma; esconder aqui evita
  // oferecer um botão que só devolve 403.
  const podeEscrever = canWrite(user.role);
  const podeApagar = canDelete(user.role);
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
        tags: tags
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean),
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
    return <div className="skel-block" style={{ height: '18rem' }} />;
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
      <div className="page-head">
        <div className="min-w-0">
          <Link to="/skills" className="back-link">
            <ArrowLeftIcon /> Skills
          </Link>
          <h1 className="display mt-1 flex flex-wrap items-center gap-3">
            <span className="truncate">{skill.name}</span>
            <Badge isPublic={skill.isPublic} />
          </h1>
          <p className="sub mono flex flex-wrap items-center gap-x-3">
            <span>{skill.slug}</span>
            <span>· {skill.viewCount} acessos</span>
            <span>· {skill.downloadCount} downloads</span>
            {skill.isPublic && (
              <a
                href={`${session.siteBaseUrl}/skills/${skill.slug}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1"
                style={{ color: 'var(--brand)' }}
              >
                <ExternalIcon className="h-3 w-3" /> ver no site
              </a>
            )}
          </p>
        </div>

        <div className="flex gap-2">
          {podeApagar && (
            <Button variant="danger" onClick={removeSkill}>
              <TrashIcon /> Remover
            </Button>
          )}
          {podeEscrever && (
            <Button onClick={save} disabled={saving || !dirty}>
              <SaveIcon /> {saving ? 'Salvando…' : dirty ? 'Salvar' : 'Salvo'}
            </Button>
          )}
        </div>
      </div>

      <div className="tabs">
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
            className={tab === value ? 'active' : ''}
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'content' && (
        <div className="mt-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs" style={{ color: 'var(--text-faint)' }}>
              Markdown com frontmatter YAML. O conteúdo alimenta a busca full-text.
            </p>
            <Button variant="ghost" size="sm" onClick={() => setPreview((current) => !current)}>
              {preview ? 'Editar' : 'Pré-visualizar'}
            </Button>
          </div>

          {preview ? (
            <Panel className="min-h-[28rem]">
              <Markdown>{skillMd}</Markdown>
            </Panel>
          ) : (
            <textarea
              value={skillMd}
              onChange={(event) => setSkillMd(event.target.value)}
              rows={28}
              spellCheck={false}
              className="field field-mono resize-y"
            />
          )}
        </div>
      )}

      {tab === 'settings' && (
        <Panel className="mt-5 max-w-2xl space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Nome">
              <input
                className="field"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field label="Slug">
              <input
                className="field"
                value={newSlug}
                onChange={(event) => setNewSlug(event.target.value)}
              />
            </Field>
          </div>

          <Field label="Descrição">
            <textarea
              className="field resize-y"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={3}
            />
          </Field>

          <Field label="Tags (separadas por vírgula)">
            <input
              className="field"
              value={tags}
              onChange={(event) => setTags(event.target.value)}
            />
          </Field>

          <label
            className="flex cursor-pointer items-center gap-3 rounded-xl px-3.5 py-3"
            style={{ border: '1px solid var(--border-strong)', background: 'var(--surface-2)' }}
          >
            <input
              type="checkbox"
              checked={isPublic}
              onChange={(event) => setIsPublic(event.target.checked)}
              className="h-4 w-4"
            />
            <span className="text-sm">
              Skill pública — visível no site, na API e no MCP público
            </span>
          </label>
        </Panel>
      )}

      {tab === 'files' && (
        <div className="mt-5 grid gap-5 lg:grid-cols-[300px_minmax(0,1fr)]">
          <Panel className="lg:sticky lg:top-24 lg:self-start">
            <div className="flex items-center justify-between">
              <h2>
                <FileIcon /> Arquivos
              </h2>
              {podeEscrever && (
                <button
                  type="button"
                  onClick={() => filesInput.current?.click()}
                  title="Enviar arquivos"
                  className="row-action"
                  style={{ color: 'var(--text-faint)' }}
                >
                  <UploadIcon />
                </button>
              )}
            </div>

            <div className="file-tree">
              {skill.files.map((file) => (
                <div className="file-row" key={file.relativePath}>
                  <button
                    type="button"
                    onClick={() => file.isText && openFile(file.relativePath)}
                    disabled={!file.isText}
                    className={`pick${selectedFile === file.relativePath ? ' active' : ''}`}
                  >
                    <FileIcon />
                    <span className="name">{file.relativePath}</span>
                    <span className="size">{formatBytes(file.sizeBytes)}</span>
                  </button>
                  {podeEscrever && file.relativePath.toLowerCase() !== 'skill.md' && (
                    <button
                      type="button"
                      onClick={() => removeFile(file.relativePath)}
                      title="Remover arquivo"
                      className="row-action del"
                    >
                      <TrashIcon />
                    </button>
                  )}
                </div>
              ))}
            </div>

            <div
              className="mt-4 flex flex-col gap-3 pt-4"
              style={{ borderTop: '1px solid var(--border)' }}
            >
              <Button variant="ghost" size="sm" onClick={() => zipInput.current?.click()}>
                <UploadIcon /> Importar .zip
              </Button>
              <label
                className="flex cursor-pointer items-start gap-2 text-[11px] leading-relaxed"
                style={{ color: 'var(--text-faint)' }}
              >
                <input
                  type="checkbox"
                  checked={replaceTree}
                  onChange={(event) => setReplaceTree(event.target.checked)}
                  className="mt-0.5 h-3.5 w-3.5 shrink-0"
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
          </Panel>

          <Panel>
            {!selectedFile && (
              <p className="list-empty">Selecione um arquivo de texto à esquerda para editar.</p>
            )}

            {selectedFile && (
              <>
                <div className="mb-3 flex items-center justify-between gap-3">
                  <code className="mono truncate text-xs" style={{ color: 'var(--brand)' }}>
                    {selectedFile}
                  </code>
                  <div className="flex shrink-0 gap-2">
                    <a
                      href={rawFileUrl(slug, selectedFile)}
                      target="_blank"
                      rel="noreferrer"
                      className="btn btn-ghost btn-sm"
                    >
                      Abrir cru
                    </a>
                    {podeEscrever && (
                      <Button size="sm" onClick={saveFile} disabled={fileContent === null}>
                        Salvar arquivo
                      </Button>
                    )}
                  </div>
                </div>
                <textarea
                  value={fileContent ?? ''}
                  onChange={(event) => setFileContent(event.target.value)}
                  rows={24}
                  spellCheck={false}
                  className="field field-mono resize-y"
                />
              </>
            )}
          </Panel>
        </div>
      )}
    </>
  );
}

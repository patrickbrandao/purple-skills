import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { Badge, Button, Panel } from '../components/ui.js';
import {
  ArrowLeftIcon,
  ExternalIcon,
  FileIcon,
  SaveIcon,
  TrashIcon,
  UploadIcon,
} from '../components/Icons.js';
import {
  FrontmatterPreview,
  SkillMetaForm,
  type SkillMetaValues,
} from '../components/SkillMetaForm.js';
import { PromptEditor } from '../components/PromptEditor.js';
import { parseTags, stripFrontmatter } from '../frontmatter.js';
import { useToast } from '../components/Toast.js';

type Tab = 'skill' | 'files';

export function SkillEditorPage({ session, user }: { session: Session; user: SessionUser }) {
  // O servidor recusa a escrita de qualquer forma; esconder aqui evita
  // oferecer um botão que só devolve 403.
  const podeEscrever = canWrite(user.role);
  const podeApagar = canDelete(user.role);
  const { slug = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();

  const [skill, setSkill] = useState<SkillDetail | null>(null);
  const [tab, setTab] = useState<Tab>('skill');
  const [saving, setSaving] = useState(false);

  const [meta, setMeta] = useState<SkillMetaValues>({
    name: '',
    slug: '',
    description: '',
    tags: '',
    isPublic: false,
  });
  const [skillMd, setSkillMd] = useState('');

  const [replaceTree, setReplaceTree] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const zipInput = useRef<HTMLInputElement>(null);
  const filesInput = useRef<HTMLInputElement>(null);

  const hydrate = useCallback((detail: SkillDetail) => {
    setSkill(detail);
    setMeta({
      name: detail.name,
      slug: detail.slug,
      description: detail.description,
      tags: detail.tags.join(', '),
      isPublic: detail.isPublic,
    });
    // Skills gravadas antes desta regra ainda podem trazer frontmatter no
    // arquivo: o editor mostra só o corpo, e o formulário manda nos metadados.
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

  const patchMeta = useCallback(
    (patch: Partial<SkillMetaValues>) => setMeta((current) => ({ ...current, ...patch })),
    [],
  );

  async function save() {
    if (!skill) return;
    setSaving(true);

    // Nunca sai daqui com frontmatter: os metadados são os do formulário.
    // Só vai no payload quando muda, para não gravar o arquivo (e uma linha de
    // auditoria) a cada ajuste de metadado.
    const prompt = stripFrontmatter(skillMd);

    try {
      const updated = await updateSkill(skill.slug, {
        name: meta.name,
        slug: meta.slug !== skill.slug ? meta.slug : undefined,
        description: meta.description,
        tags: parseTags(meta.tags),
        isPublic: meta.isPublic,
        skillMd: prompt !== skill.skillMd ? prompt : undefined,
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

  // O SKILL.md fica fora da aba de arquivos: ali a edição é crua, e o conteúdo
  // dele é montado a partir do formulário desta mesma tela.
  const attachments = useMemo(
    () => skill?.files.filter((file) => file.relativePath.toLowerCase() !== 'skill.md') ?? [],
    [skill],
  );

  if (!skill) {
    return <div className="skel-block" style={{ height: '18rem' }} />;
  }

  const dirty =
    meta.name !== skill.name ||
    meta.slug !== skill.slug ||
    meta.description !== skill.description ||
    meta.tags !== skill.tags.join(', ') ||
    meta.isPublic !== skill.isPublic ||
    skillMd !== stripFrontmatter(skill.skillMd);

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
            ['skill', 'SKILL.md'],
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

      {tab === 'skill' && (
        <Panel className="mt-5">
          <SkillMetaForm values={meta} onChange={patchMeta} />
          <FrontmatterPreview values={meta} />
          <PromptEditor value={skillMd} onChange={setSkillMd} />
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

            <p className="panel-hint">
              Anexos da skill. O <code>SKILL.md</code> é editado na aba ao lado, com os metadados
              que geram as suas primeiras linhas.
            </p>

            <div className="file-tree">
              {attachments.length === 0 && (
                <p className="list-empty">Nenhum arquivo além do SKILL.md.</p>
              )}
              {attachments.map((file) => (
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
                  {podeEscrever && (
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

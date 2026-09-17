import { useEffect, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { AlertTriangle, Binary, Download, ExternalLink, FileCode2, FilePlus, FileQuestion, Lock, RotateCcw, Save, Trash2, X } from 'lucide-react';
import { formatBytes, rawFileUrl, type SkillFileMeta } from '../api.js';
import { baseName, isSkillMdPath, lineCount, parentDir } from '../explorer.js';
import { isDirtyDoc, type FileDoc, type SkillFiles } from '../useSkillFiles.js';
import { CodeEditor } from './CodeEditor.js';
import { FileExplorer } from './FileExplorer.js';
import { FileTypeIcon } from './FileTypeIcon.js';
import { Button, EmptyState, Skel, useStored } from './ui.js';

/* ============================================================
   GUIA ARQUIVOS DO EDITOR DE SKILL
   A árvore à esquerda e o arquivo aberto no resto da largura.
   Arquivo de texto abre no editor e é gravado pelo "Salvar
   arquivo" (ou ⌘S); o SKILL.md abre o corpo do formulário, que o
   Salvar do cabeçalho grava; binário mostra o que dá para ver.
   ============================================================ */

const TREE_MIN = 200;
const TREE_MAX = 560;
const TREE_DEFAULT = 300;

const clampWidth = (width: number) => Math.min(TREE_MAX, Math.max(TREE_MIN, Math.round(width)));

type SkillMdProps = {
  /** O corpo do SKILL.md no formulário da página. */
  body: string;
  onBody: (value: string) => void;
  /** As primeiras linhas, geradas da descrição e das propriedades. */
  frontmatter: string;
  /** O SKILL.md mudou em relação ao que está gravado. */
  dirty: boolean;
  /** Há algo para o Salvar do cabeçalho gravar. */
  formDirty: boolean;
  saving: boolean;
  onSave: () => void;
};

export function SkillFilesTab({
  ws,
  slug,
  canWrite,
  skillMd,
}: {
  ws: SkillFiles;
  slug: string;
  canWrite: boolean;
  skillMd: SkillMdProps;
}) {
  const [storedWidth, setStoredWidth] = useStored('purple-skills-admin:files-tree-width', TREE_DEFAULT);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const width = dragWidth ?? clampWidth(storedWidth);

  function startDrag(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const startX = event.clientX;
    let next = width;
    handle.setPointerCapture(event.pointerId);
    const move = (moved: globalThis.PointerEvent) => {
      next = clampWidth(width + moved.clientX - startX);
      setDragWidth(next);
    };
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      setDragWidth(null);
      setStoredWidth(next);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  function nudge(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 64 : 16;
    const next =
      event.key === 'ArrowLeft' ? width - step
      : event.key === 'ArrowRight' ? width + step
      : event.key === 'Home' ? TREE_MIN
      : event.key === 'End' ? TREE_MAX
      : null;
    if (next === null) return;
    event.preventDefault();
    setStoredWidth(clampWidth(next));
  }

  return (
    // `file-tree` traz as cores por tipo de arquivo, que o cabeçalho do editor também usa.
    <div className={`files-ws file-tree${dragWidth !== null ? ' resizing' : ''}`} style={{ '--tree-w': `${width}px` } as CSSProperties}>
      <aside className="files-tree" aria-label="Árvore de arquivos">
        <FileExplorer ws={ws} slug={slug} canWrite={canWrite} skillMdDirty={skillMd.dirty} />
      </aside>
      <div
        className="files-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Largura da árvore de arquivos"
        aria-valuemin={TREE_MIN}
        aria-valuemax={TREE_MAX}
        aria-valuenow={width}
        tabIndex={0}
        title="Arraste para mudar a largura da árvore; dois cliques voltam ao padrão"
        onPointerDown={startDrag}
        onKeyDown={nudge}
        onDoubleClick={() => setStoredWidth(TREE_DEFAULT)}
      />
      <section className="files-editor" aria-label="Arquivo aberto">
        <FilePane ws={ws} slug={slug} canWrite={canWrite} skillMd={skillMd} />
      </section>
    </div>
  );
}

function FilePane({ ws, slug, canWrite, skillMd }: { ws: SkillFiles; slug: string; canWrite: boolean; skillMd: SkillMdProps }) {
  const path = ws.selected;
  if (!path) return <NoFile ws={ws} canWrite={canWrite} />;
  if (isSkillMdPath(path)) return <SkillMdPane ws={ws} slug={slug} canWrite={canWrite} {...skillMd} />;

  const meta = ws.files.find((file) => file.relativePath === path) ?? ws.files.find((file) => file.relativePath.toLowerCase() === path.toLowerCase());
  if (!meta) return <GoneFile ws={ws} path={path} />;
  if (!meta.isText) return <BinaryPane ws={ws} slug={slug} canWrite={canWrite} meta={meta} />;
  return <TextPane ws={ws} slug={slug} canWrite={canWrite} meta={meta} doc={ws.docs.get(path)} />;
}

/** Cabeçalho do arquivo aberto: ícone, caminho, estado e ações. */
function PaneHead({
  path,
  dirty,
  info,
  onClose,
  children,
}: {
  path: string;
  dirty?: boolean;
  info?: ReactNode;
  onClose: () => void;
  children?: ReactNode;
}) {
  const dir = parentDir(path);
  return (
    <div className="fe-head">
      <FileTypeIcon fileName={baseName(path)} />
      <span className="fe-path" title={path}>
        {dir && <span className="dir">{dir}/</span>}
        <span className="name">{baseName(path)}</span>
      </span>
      {dirty && <span className="fx-dirty" role="img" aria-label="alterações não salvas" title="Alterações não salvas" />}
      {info && <span className="fe-info">{info}</span>}
      <span className="fe-actions">{children}</span>
      <button type="button" className="row-action" title="Fechar o arquivo" aria-label="Fechar o arquivo" onClick={onClose}>
        <X />
      </button>
    </div>
  );
}

const describe = (meta: SkillFileMeta) => `${meta.mimeType} · ${formatBytes(meta.sizeBytes)}`;

function RawLink({ slug, path }: { slug: string; path: string }) {
  return (
    <a href={rawFileUrl(slug, path)} target="_blank" rel="noreferrer" className="btn btn-quiet btn-sm" title="O conteúdo gravado, em outra guia">
      <ExternalLink /> Abrir cru
    </a>
  );
}

function RemoveButton({ ws, path }: { ws: SkillFiles; path: string }) {
  return (
    <button type="button" className="row-action danger" title={`Remover ${path}`} aria-label={`Remover ${path}`} onClick={() => void ws.remove(path)}>
      <Trash2 />
    </button>
  );
}

function TextPane({
  ws,
  slug,
  canWrite,
  meta,
  doc,
}: {
  ws: SkillFiles;
  slug: string;
  canWrite: boolean;
  meta: SkillFileMeta;
  doc: FileDoc | undefined;
}) {
  const path = meta.relativePath;
  const dirty = isDirtyDoc(doc);
  const saving = ws.saving.has(path);

  // Um arquivo à vista sem conteúdo carregado (aberto por fora da árvore) é lido aqui.
  const { ensure } = ws;
  useEffect(() => {
    if (!doc) ensure(path);
  }, [doc, path, ensure]);

  return (
    <div className="fe">
      <PaneHead path={path} dirty={dirty} info={describe(meta)} onClose={ws.close}>
        <RawLink slug={slug} path={path} />
        {canWrite && (
          <>
            {dirty && (
              <Button variant="quiet" size="sm" onClick={() => void ws.revert(path)} title="Voltar ao conteúdo gravado">
                <RotateCcw /> Descartar
              </Button>
            )}
            <Button size="sm" onClick={() => void ws.save(path)} disabled={!dirty || saving} title="Salvar arquivo (⌘S)">
              <Save /> {saving ? 'Salvando…' : dirty ? 'Salvar arquivo' : 'Salvo'}
            </Button>
            <RemoveButton ws={ws} path={path} />
          </>
        )}
      </PaneHead>

      <div className="fe-body">
        {!doc || doc.status === 'loading' ? (
          <EditorSkeleton />
        ) : doc.status === 'error' ? (
          <div className="fe-problem">
            <div className="alert warn">
              <AlertTriangle />
              <span>{doc.message}</span>
            </div>
            <Button variant="ghost" size="sm" onClick={() => void ws.revert(path)}>
              <RotateCcw /> Tentar de novo
            </Button>
          </div>
        ) : (
          <CodeEditor
            key={path}
            value={doc.content}
            onChange={(value) => ws.edit(path, value)}
            readOnly={!canWrite}
            autoFocus={ws.fresh === path}
            label={`Conteúdo de ${path}`}
            placeholder={canWrite ? 'Arquivo vazio — comece a escrever.' : 'Arquivo vazio.'}
          />
        )}
      </div>

      <div className="fe-foot">
        <span>{doc?.status === 'ready' ? `${lineCount(doc.content)} linha${lineCount(doc.content) === 1 ? '' : 's'}` : ' '}</span>
        <span>{canWrite ? '⌘S salva · Tab indenta · Esc e depois Tab sai do editor' : 'Somente leitura'}</span>
      </div>
    </div>
  );
}

function SkillMdPane({
  ws,
  slug,
  canWrite,
  body,
  onBody,
  frontmatter,
  dirty,
  formDirty,
  saving,
  onSave,
}: { ws: SkillFiles; slug: string; canWrite: boolean } & SkillMdProps) {
  return (
    <div className="fe">
      <PaneHead path="SKILL.md" dirty={dirty} info="o prompt da skill" onClose={ws.close}>
        <RawLink slug={slug} path="SKILL.md" />
        {canWrite && (
          <Button size="sm" onClick={onSave} disabled={!formDirty || saving} title="Grava descrição, SKILL.md e propriedades (⌘S)">
            <Save /> {saving ? 'Salvando…' : formDirty ? 'Salvar skill' : 'Salvo'}
          </Button>
        )}
      </PaneHead>

      <div className="fe-body fe-skillmd">
        <pre className="fe-frontmatter" aria-label="Primeiras linhas do SKILL.md, geradas">
          <span className="t">
            <Lock /> Geradas da descrição e das propriedades — edite lá
          </span>
          {frontmatter}
        </pre>
        <CodeEditor
          value={body}
          onChange={onBody}
          readOnly={!canWrite}
          // O arquivo materializado é frontmatter, uma linha em branco e o corpo.
          firstLine={lineCount(frontmatter) + 1}
          label="Corpo do SKILL.md"
          placeholder={'# Título\n\n## Quando usar\n\nDescreva o gatilho da skill.'}
        />
      </div>

      <div className="fe-foot">
        <span>{`${lineCount(body)} linha${lineCount(body) === 1 ? '' : 's'} no corpo`}</span>
        <span>{canWrite ? 'Gravado pelo Salvar do cabeçalho (⌘S), com a descrição e as propriedades' : 'Somente leitura'}</span>
      </div>
    </div>
  );
}

function BinaryPane({ ws, slug, canWrite, meta }: { ws: SkillFiles; slug: string; canWrite: boolean; meta: SkillFileMeta }) {
  const path = meta.relativePath;
  const url = rawFileUrl(slug, path);
  const image = meta.mimeType.startsWith('image/') && meta.sizeBytes > 0;

  return (
    <div className="fe">
      <PaneHead path={path} info={describe(meta)} onClose={ws.close}>
        <RawLink slug={slug} path={path} />
        <a href={url} download={baseName(path)} className="btn btn-quiet btn-sm">
          <Download /> Baixar
        </a>
        {canWrite && <RemoveButton ws={ws} path={path} />}
      </PaneHead>

      <div className="fe-body fe-binary">
        {image ? (
          <img src={url} alt={`Pré-visualização de ${path}`} className="fe-image" />
        ) : (
          <EmptyState
            icon={<Binary />}
            title={meta.sizeBytes === 0 ? 'Arquivo binário vazio' : 'Arquivo binário'}
            description="Não abre no editor de texto. Para trocá-lo, envie outro com o mesmo nome para esta pasta."
          />
        )}
      </div>

      <div className="fe-foot">
        <span>{formatBytes(meta.sizeBytes)}</span>
        <span>{canWrite ? `Enviar para ${parentDir(path) || slug}/ substitui o arquivo` : 'Somente leitura'}</span>
      </div>
    </div>
  );
}

function NoFile({ ws, canWrite }: { ws: SkillFiles; canWrite: boolean }) {
  return (
    <div className="fe fe-none">
      <EmptyState
        icon={<FileCode2 />}
        title="Nenhum arquivo aberto"
        description={
          canWrite
            ? 'Escolha um arquivo na árvore para editá-lo, ou crie um — vazio, na raiz ou dentro de uma pasta.'
            : 'Escolha um arquivo na árvore para ler o conteúdo.'
        }
        action={
          canWrite ? (
            <Button variant="ghost" size="sm" onClick={() => ws.startCreate('file')}>
              <FilePlus /> Novo arquivo
            </Button>
          ) : undefined
        }
      />
    </div>
  );
}

function GoneFile({ ws, path }: { ws: SkillFiles; path: string }) {
  return (
    <div className="fe">
      <PaneHead path={path} onClose={ws.close} />
      <div className="fe-body fe-binary">
        <EmptyState
          icon={<FileQuestion />}
          title="Este arquivo não está mais na skill"
          description="Ele pode ter sido removido ou substituído por um .zip. Recarregue a árvore para ver o estado atual."
          action={
            <Button variant="ghost" size="sm" onClick={() => void ws.refresh()}>
              <RotateCcw /> Recarregar a árvore
            </Button>
          }
        />
      </div>
    </div>
  );
}

/** A forma do texto que está chegando: linhas de larguras variadas. */
function EditorSkeleton() {
  const widths = ['38%', '62%', '54%', '0%', '71%', '46%', '66%', '30%', '0%', '58%', '49%'];
  return (
    <div className="fe-skel" aria-busy="true" aria-label="Carregando o arquivo">
      {widths.map((width, index) => (
        <Skel key={index} h={10} w={width} style={{ marginBottom: 10, visibility: width === '0%' ? 'hidden' : undefined }} />
      ))}
    </div>
  );
}

/** Os seletores de arquivo ocultos. Ficam na página, para a paleta os abrir de qualquer guia. */
export function FilePickers({ ws }: { ws: SkillFiles }) {
  return (
    <>
      <input ref={ws.uploadInput} type="file" multiple className="hidden" tabIndex={-1} aria-hidden="true" onChange={ws.onUploadPicked} />
      <input
        ref={ws.zipInput}
        type="file"
        accept=".zip,application/zip"
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
        onChange={ws.onZipPicked}
      />
    </>
  );
}

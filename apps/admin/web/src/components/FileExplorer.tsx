import { useEffect, useId, useMemo, useRef, useState, type DragEvent } from 'react';
import {
  ChevronRight,
  ChevronsDownUp,
  Download,
  FileArchive,
  FilePlus,
  FolderPlus,
  MoreHorizontal,
  RefreshCw,
  Replace,
  Trash2,
  Upload,
} from 'lucide-react';
import { formatBytes, skillDownloadUrl, skillPackageUrl } from '../api.js';
import { buildTree, type DirNode, type FileNode, type TreeNode } from '../fileTree.js';
import {
  addVirtualDirs,
  allDirs,
  baseName,
  checkNewName,
  fileCountIn,
  isSkillMdPath,
  parentDir,
  type EntryKind,
} from '../explorer.js';
import type { Creating, SkillFiles } from '../useSkillFiles.js';
import { FileTypeIcon, FolderIcon } from './FileTypeIcon.js';
import { useToast } from './Toast.js';
import { Menu, MenuItem, MenuSeparator, cx } from './ui.js';

/* ============================================================
   EXPLORADOR DA GUIA ARQUIVOS
   A árvore da skill com as ações de quem edita: arquivo vazio e
   pasta nova (na raiz ou numa pasta), envio de arquivos (pelo
   botão ou arrastando para a pasta), importar .zip e remover.
   O nome do que se cria é digitado na própria árvore, como no
   VS Code: Enter cria, Esc desiste.
   ============================================================ */

type Ctx = {
  ws: SkillFiles;
  slug: string;
  canWrite: boolean;
  skillMdDirty: boolean;
  dropDir: string | null;
  /** A pasta do campo de nome, já na grafia da árvore; `null` sem campo aberto. */
  creatingAt: string | null;
};

const same = (a: string | null, b: string) => a !== null && a.toLowerCase() === b.toLowerCase();

/** Como a pasta aparece nos rótulos: a raiz é a pasta com o slug. */
const shown = (slug: string, dir: string) => `${dir || slug}/`;

export function FileExplorer({ ws, slug, canWrite, skillMdDirty }: {
  ws: SkillFiles;
  slug: string;
  canWrite: boolean;
  /** O SKILL.md tem alteração pendente no formulário da página. */
  skillMdDirty: boolean;
}) {
  const toast = useToast();
  const [dropDir, setDropDir] = useState<string | null>(null);

  const tree = useMemo(() => addVirtualDirs(buildTree(ws.files), ws.virtualDirs), [ws.files, ws.virtualDirs]);
  const dirs = useMemo(() => allDirs(tree), [tree]);

  // Um campo pedido para uma pasta que sumiu aparece na raiz.
  const creatingAt = ws.creating
    ? (ws.creating.parent && dirs.find((dir) => same(ws.creating!.parent, dir))) || ''
    : null;

  const ctx: Ctx = { ws, slug, canWrite, skillMdDirty, dropDir, creatingAt };
  const rootOpen = !ws.collapsed.has('');
  const target = shown(slug, ws.targetDir);

  const dropTarget = (event: DragEvent) =>
    (event.target as HTMLElement).closest<HTMLElement>('[data-dir]')?.dataset.dir ?? '';

  function onDrop(event: DragEvent<HTMLDivElement>) {
    if (!canWrite) return;
    event.preventDefault();
    const dir = dropTarget(event);
    setDropDir(null);

    const picked: File[] = [];
    let folders = 0;
    for (const item of Array.from(event.dataTransfer.items)) {
      if (item.kind !== 'file') continue;
      if (item.webkitGetAsEntry()?.isDirectory) {
        folders += 1;
        continue;
      }
      const file = item.getAsFile();
      if (file) picked.push(file);
    }
    if (folders > 0) toast.error('Pastas não vão pelo arrastar: arraste os arquivos, ou importe um .zip.');
    if (picked.length > 0) void ws.upload(picked, dir);
  }

  return (
    <div className="fx">
      <div className="fx-head">
        <h2 className="fx-title">
          Arquivos <span className="fx-count">{ws.files.length}</span>
        </h2>
        <span className="fx-tools">
          {canWrite && (
            <>
              <button type="button" className="row-action" title={`Novo arquivo em ${target}`} aria-label={`Novo arquivo em ${target}`} onClick={() => ws.startCreate('file')}>
                <FilePlus />
              </button>
              <button type="button" className="row-action" title={`Nova pasta em ${target}`} aria-label={`Nova pasta em ${target}`} onClick={() => ws.startCreate('dir')}>
                <FolderPlus />
              </button>
              <button type="button" className="row-action" title={`Enviar arquivos para ${target}`} aria-label={`Enviar arquivos para ${target}`} onClick={() => ws.pickUpload()}>
                <Upload />
              </button>
            </>
          )}
          <Menu
            align="right"
            trigger={(props) => (
              <button type="button" className="row-action" title="Mais ações" aria-label="Mais ações da árvore" {...props}>
                <MoreHorizontal />
              </button>
            )}
          >
            {canWrite && (
              <>
                <MenuItem icon={<FileArchive />} onSelect={() => ws.pickZip(false)}>
                  Importar .zip
                </MenuItem>
                <MenuItem icon={<Replace />} danger onSelect={() => ws.pickZip(true)}>
                  Substituir a árvore por um .zip…
                </MenuItem>
                <MenuSeparator />
              </>
            )}
            <MenuItem icon={<ChevronsDownUp />} onSelect={() => ws.collapseAll(dirs)} disabled={dirs.length === 0}>
              Recolher as pastas
            </MenuItem>
            <MenuItem icon={<RefreshCw />} onSelect={() => void ws.refresh()}>
              Recarregar a árvore
            </MenuItem>
          </Menu>
        </span>
      </div>

      <div
        className={cx('fx-body', dropDir === '' && 'drop')}
        onDragOver={(event) => {
          if (!canWrite || !event.dataTransfer.types.includes('Files')) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
          const dir = dropTarget(event);
          setDropDir((current) => (current === dir ? current : dir));
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropDir(null);
        }}
        onDrop={onDrop}
      >
        <ul className="ft-list ft-root">
          <li>
            <div className={cx('ft-line', 'fx-line', same(ws.selectedDir, '') && 'focus')} data-dir="">
              <button
                type="button"
                className="ft-row ft-dir-row ft-root-row"
                aria-expanded={rootOpen}
                onClick={() => {
                  ws.toggle('');
                  ws.selectDir('');
                }}
                title={`${slug}/ — a pasta que o pacote cria ao ser descompactado`}
              >
                <ChevronRight className="ft-chevron" />
                <FolderIcon open={rootOpen} />
                <span className="ft-name mono">{slug}</span>
                <span className="ft-count">{tree.length}</span>
              </button>
              {canWrite && <DirActions dir="" empty={false} ctx={ctx} />}
            </div>
            {rootOpen && <Branch nodes={tree} parent="" ctx={ctx} />}
          </li>
        </ul>
      </div>

      <div className="fx-foot">
        {canWrite ? (
          <span className="fx-hint drag">Arraste arquivos para uma pasta para enviá-los.</span>
        ) : (
          <span className="fx-hint">Somente leitura.</span>
        )}
        <span className="flex gap-1">
          <a href={skillDownloadUrl(slug)} className="btn btn-quiet btn-sm" download title="Baixar o pacote .zip">
            <Download /> .zip
          </a>
          <a href={skillPackageUrl(slug)} className="btn btn-quiet btn-sm" download title="Baixar o pacote .skill">
            <Download /> .skill
          </a>
        </span>
      </div>
    </div>
  );
}

function Branch({ nodes, parent, ctx }: { nodes: TreeNode[]; parent: string; ctx: Ctx }) {
  const creating = ctx.ws.creating;
  return (
    <ul className="ft-list">
      {creating && ctx.creatingAt === parent && <NewEntry key={creating.id} request={creating} parent={parent} ctx={ctx} />}
      {nodes.map((node) =>
        node.kind === 'dir' ? (
          <DirItem key={`d:${node.path}`} node={node} ctx={ctx} />
        ) : (
          <FileItem key={`f:${node.path}`} node={node} ctx={ctx} />
        ),
      )}
    </ul>
  );
}

function DirItem({ node, ctx }: { node: DirNode; ctx: Ctx }) {
  const { ws } = ctx;
  const open = !ws.collapsed.has(node.path);
  const empty = fileCountIn(node) === 0;
  const focused = same(ws.selectedDir, node.path);

  return (
    <li>
      <div className={cx('ft-line', 'fx-line', focused && 'focus', ctx.dropDir === node.path && 'drop')} data-dir={node.path}>
        <button
          type="button"
          className="ft-row ft-dir-row"
          aria-expanded={open}
          onClick={() => {
            ws.toggle(node.path);
            ws.selectDir(node.path);
          }}
          title={empty ? `${node.path}/ — pasta nova: só é gravada quando receber um arquivo` : `${node.path}/`}
        >
          <ChevronRight className="ft-chevron" />
          <FolderIcon open={open} />
          <span className="ft-name">{node.name}</span>
          {empty ? <span className="fx-tag">vazia</span> : <span className="ft-count">{node.children.length}</span>}
        </button>
        {ctx.canWrite && <DirActions dir={node.path} empty={empty} ctx={ctx} />}
      </div>
      {open && <Branch nodes={node.children} parent={node.path} ctx={ctx} />}
    </li>
  );
}

/** As ações que aparecem ao passar sobre uma pasta: criar e enviar nela. */
function DirActions({ dir, empty, ctx }: { dir: string; empty: boolean; ctx: Ctx }) {
  const { ws } = ctx;
  const where = shown(ctx.slug, dir);
  return (
    <span className="fx-actions">
      <button type="button" className="row-action" title={`Novo arquivo em ${where}`} aria-label={`Novo arquivo em ${where}`} onClick={() => ws.startCreate('file', dir)}>
        <FilePlus />
      </button>
      <button type="button" className="row-action" title={`Nova pasta em ${where}`} aria-label={`Nova pasta em ${where}`} onClick={() => ws.startCreate('dir', dir)}>
        <FolderPlus />
      </button>
      <button type="button" className="row-action" title={`Enviar arquivos para ${where}`} aria-label={`Enviar arquivos para ${where}`} onClick={() => ws.pickUpload(dir)}>
        <Upload />
      </button>
      {empty && (
        <button type="button" className="row-action danger" title={`Tirar a pasta vazia ${where}`} aria-label={`Tirar a pasta vazia ${where}`} onClick={() => ws.removeDir(dir)}>
          <Trash2 />
        </button>
      )}
    </span>
  );
}

function FileItem({ node, ctx }: { node: FileNode; ctx: Ctx }) {
  const { ws } = ctx;
  const skillMd = isSkillMdPath(node.path);
  const active = ws.selected === node.path;
  const dirty = skillMd ? ctx.skillMdDirty : ws.dirtyPaths.has(node.path);
  const size = node.sizeBytes === null ? '' : ` — ${formatBytes(node.sizeBytes)}`;
  const kind = skillMd ? ' — o prompt da skill' : node.isText ? '' : ' — binário';

  // O arquivo aberto por fora da árvore (a guia Skill, a outra ficha) aparece nela.
  const row = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (active) row.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  return (
    <li>
      <div className="ft-line fx-line" data-dir={parentDir(node.path)}>
        <button
          ref={row}
          type="button"
          className={cx('ft-row', skillMd && 'primary', active && 'active')}
          aria-current={active ? 'true' : undefined}
          onClick={() => ws.open(node.path)}
          title={`${node.path}${size}${kind}${dirty ? ' — alterações não salvas' : ''}`}
        >
          <span className="ft-chevron" aria-hidden="true" />
          <FileTypeIcon fileName={node.name} />
          <span className="ft-name">{node.name}</span>
          {dirty && <span className="fx-dirty" role="img" aria-label="alterações não salvas" />}
          {node.sizeBytes !== null && <span className="ft-size">{formatBytes(node.sizeBytes)}</span>}
        </button>
        {ctx.canWrite && !skillMd && (
          <span className="fx-actions">
            <button type="button" className="row-action danger" title={`Remover ${node.path}`} aria-label={`Remover ${node.path}`} onClick={() => void ws.remove(node.path)}>
              <Trash2 />
            </button>
          </span>
        )}
      </div>
    </li>
  );
}

/**
 * O campo de nome, dentro da pasta onde a coisa vai nascer. Enter cria, Esc
 * desiste; clicar fora cria o que estiver válido e desiste do resto.
 */
function NewEntry({ request, parent, ctx }: { request: Creating; parent: string; ctx: Ctx }) {
  const { ws } = ctx;
  const kind: EntryKind = request.kind;
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const row = useRef<HTMLLIElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const settled = useRef(false);
  const messageId = useId();

  const check = checkNewName(value, kind, parent, ws.files, ws.virtualDirs);
  const where = shown(ctx.slug, parent);

  async function submit() {
    if (settled.current || !check.ok) return;
    settled.current = true;
    setBusy(true);
    const ok = await ws.create(request.id, kind, check.path);
    if (!ok) {
      settled.current = false;
      setBusy(false);
      requestAnimationFrame(() => input.current?.focus());
    }
  }

  function cancel() {
    if (settled.current) return;
    settled.current = true;
    ws.cancelCreate(request.id);
  }

  const latest = useRef({ submit, cancel, ok: check.ok });
  latest.current = { submit, cancel, ok: check.ok };

  useEffect(() => {
    // A paleta, ao fechar, devolve o foco a quem o tinha num `setTimeout`:
    // pedir o foco depois dela mantém o cursor aqui.
    const timer = window.setTimeout(() => input.current?.focus(), 0);
    const down = (event: MouseEvent) => {
      if (row.current?.contains(event.target as Node)) return;
      if (latest.current.ok) void latest.current.submit();
      else latest.current.cancel();
    };
    document.addEventListener('mousedown', down);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('mousedown', down);
    };
  }, []);

  const error = !check.ok ? check.error : null;
  const message =
    error ??
    (check.ok
      ? `Enter cria ${kind === 'dir' ? 'a pasta' : 'o arquivo vazio'} ${check.path}${kind === 'dir' ? '/' : ''}`
      : `Enter cria · Esc desiste${kind === 'file' ? ' · a/b.md cria a pasta junto' : ''}`);

  return (
    <li ref={row}>
      <div className={cx('fx-new', error && 'invalid')}>
        <span className="ft-chevron" aria-hidden="true" />
        {kind === 'dir' ? <FolderIcon /> : <FileTypeIcon fileName={baseName(value.trim()) || 'novo'} />}
        <input
          ref={input}
          className="fx-input"
          value={value}
          disabled={busy}
          autoFocus
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void submit();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              cancel();
            }
          }}
          placeholder={kind === 'dir' ? 'nome-da-pasta' : 'nome-do-arquivo.md'}
          aria-label={kind === 'dir' ? `Nome da nova pasta em ${where}` : `Nome do novo arquivo em ${where}`}
          aria-invalid={error ? true : undefined}
          aria-describedby={messageId}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
        />
      </div>
      <p id={messageId} className={cx('fx-msg', error && 'error')} aria-live="polite">
        {message}
      </p>
    </li>
  );
}

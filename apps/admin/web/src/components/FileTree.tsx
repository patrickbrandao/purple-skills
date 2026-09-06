import { useMemo, useState } from 'react';
import { formatBytes, rawFileUrl, type SkillFileMeta } from '../api.js';
import { buildTree, SKILL_MD, type TreeNode } from '../fileTree.js';
import { FileTypeIcon, FolderIcon } from './FileTypeIcon.js';
import { ChevronRightIcon, TrashIcon } from './Icons.js';

/* ============================================================
   ÁRVORE DE ARQUIVOS DA SKILL
   A raiz é a pasta com o slug — o mesmo nome que a pasta ganha
   quando o .zip é descompactado em `~/.claude/skills/`. Dentro
   dela vem o SKILL.md e depois as subpastas e os anexos.

   Serve às duas telas do painel:

   - sem `onPick`, cada arquivo é um link para o conteúdo cru,
     como na visualização;
   - com `onPick`, cada arquivo é um botão que escolhe o arquivo
     para editar, como na aba de arquivos do editor.
   ============================================================ */

type Props = {
  slug: string;
  files: SkillFileMeta[];
  /** Escolhe um arquivo em vez de abri-lo; transforma as linhas em botões. */
  onPick?: (path: string) => void;
  /** Caminho em edição, destacado na árvore. */
  selected?: string | null;
  /** Quando presente, cada anexo ganha o botão de remover (o SKILL.md nunca). */
  onDelete?: (path: string) => void;
};

type RowProps = Props & {
  collapsed: Set<string>;
  onToggle: (path: string) => void;
};

function FileRow({ node, slug, onPick, selected, onDelete }: Props & { node: TreeNode }) {
  if (node.kind !== 'file') return null;

  const isSkillMd = node.name.toLowerCase() === SKILL_MD;
  const classes = [
    'ft-row',
    isSkillMd ? 'primary' : '',
    selected === node.path ? 'active' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const inner = (
    <>
      <span className="ft-chevron" aria-hidden="true" />
      <FileTypeIcon fileName={node.name} />
      <span className="ft-name">{node.name}</span>
      {node.sizeBytes !== null && <span className="ft-size">{formatBytes(node.sizeBytes)}</span>}
    </>
  );

  const title =
    node.sizeBytes === null ? node.path : `${node.path} — ${formatBytes(node.sizeBytes)}`;

  return (
    <div className="ft-line">
      {onPick ? (
        <button
          type="button"
          className={classes}
          // Binário não abre no editor de texto; o SKILL.md leva para a aba dele.
          disabled={!node.isText && !isSkillMd}
          onClick={() => onPick(node.path)}
          title={node.isText || isSkillMd ? title : `${title} — arquivo binário`}
        >
          {inner}
        </button>
      ) : (
        <a
          className={classes}
          href={rawFileUrl(slug, node.path)}
          target="_blank"
          rel="noreferrer"
          title={title}
        >
          {inner}
        </a>
      )}
      {onDelete && !isSkillMd && (
        <button
          type="button"
          className="row-action del"
          onClick={() => onDelete(node.path)}
          title={`Remover ${node.path}`}
        >
          <TrashIcon />
        </button>
      )}
    </div>
  );
}

function Branch({ nodes, collapsed, onToggle, ...rest }: RowProps & { nodes: TreeNode[] }) {
  return (
    <ul className="ft-list">
      {nodes.map((node) =>
        node.kind === 'dir' ? (
          <li key={`d:${node.path}`}>
            <button
              type="button"
              className="ft-row ft-dir-row"
              onClick={() => onToggle(node.path)}
              aria-expanded={!collapsed.has(node.path)}
            >
              <ChevronRightIcon className="ft-chevron" />
              <FolderIcon open={!collapsed.has(node.path)} />
              <span className="ft-name">{node.name}</span>
              <span className="ft-count">{node.children.length}</span>
            </button>
            {!collapsed.has(node.path) && (
              <Branch nodes={node.children} collapsed={collapsed} onToggle={onToggle} {...rest} />
            )}
          </li>
        ) : (
          <li key={`f:${node.path}`}>
            <FileRow node={node} {...rest} />
          </li>
        ),
      )}
    </ul>
  );
}

/** Explorador de arquivos da skill, com a pasta do slug na raiz. */
export function FileTree({ slug, files, onPick, selected, onDelete }: Props) {
  const tree = useMemo(() => buildTree(files), [files]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const toggle = (path: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  const rootOpen = !collapsed.has('');

  return (
    <div className="file-tree">
      <ul className="ft-list ft-root">
        <li>
          <button
            type="button"
            className="ft-row ft-dir-row ft-root-row"
            onClick={() => toggle('')}
            aria-expanded={rootOpen}
          >
            <ChevronRightIcon className="ft-chevron" />
            <FolderIcon open={rootOpen} />
            <span className="ft-name mono">{slug}</span>
            <span className="ft-count">{tree.length}</span>
          </button>
          {rootOpen && (
            <Branch
              nodes={tree}
              slug={slug}
              files={files}
              onPick={onPick}
              selected={selected}
              onDelete={onDelete}
              collapsed={collapsed}
              onToggle={toggle}
            />
          )}
        </li>
      </ul>
    </div>
  );
}

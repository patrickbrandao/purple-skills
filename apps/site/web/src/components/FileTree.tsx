import { useMemo, useState, type MouseEvent } from 'react';
import { fileUrl, formatBytes, type SkillFileMeta } from '../api.js';
import { buildTree, SKILL_MD, type TreeNode } from '../fileTree.js';
import { FileTypeIcon, FolderIcon } from './FileTypeIcon.js';
import { ChevronRightIcon } from './Icons.js';

/* ============================================================
   ÁRVORE DE ARQUIVOS DA SKILL
   A raiz é a pasta com o slug — o mesmo nome que a pasta ganha
   quando o .zip é descompactado em `~/.claude/skills/`. Dentro
   dela vem o SKILL.md e depois as subpastas e os anexos.

   Clicar num arquivo o abre na caixa do prompt, ao lado. O link
   continua apontando para o arquivo cru: com ⌘/Ctrl, Shift ou o
   botão do meio, o navegador faz o de sempre, que é baixá-lo.
   ============================================================ */

type BranchProps = {
  nodes: TreeNode[];
  slug: string;
  collapsed: Set<string>;
  onToggle: (path: string) => void;
  /** O arquivo aberto na caixa, para a árvore marcá-lo. */
  selected: string | null;
  onOpen: (path: string) => void;
};

function Branch({ nodes, slug, collapsed, onToggle, selected, onOpen }: BranchProps) {
  const open = (event: MouseEvent<HTMLAnchorElement>, path: string) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onOpen(path);
  };

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
              <Branch
                nodes={node.children}
                slug={slug}
                collapsed={collapsed}
                onToggle={onToggle}
                selected={selected}
                onOpen={onOpen}
              />
            )}
          </li>
        ) : (
          <li key={`f:${node.path}`}>
            <a
              className={`ft-row${node.name.toLowerCase() === SKILL_MD ? ' primary' : ''}${
                node.path === selected ? ' active' : ''
              }`}
              href={fileUrl(slug, node.path)}
              title={
                node.sizeBytes === null
                  ? node.path
                  : `${node.path} — ${formatBytes(node.sizeBytes)}`
              }
              aria-current={node.path === selected ? 'true' : undefined}
              onClick={(event) => open(event, node.path)}
              download
            >
              <span className="ft-chevron" aria-hidden="true" />
              <FileTypeIcon fileName={node.name} />
              <span className="ft-name">{node.name}</span>
              {node.sizeBytes !== null && (
                <span className="ft-size">{formatBytes(node.sizeBytes)}</span>
              )}
            </a>
          </li>
        ),
      )}
    </ul>
  );
}

/** Explorador de arquivos da skill, com a pasta do slug na raiz. */
export function FileTree({
  slug,
  files,
  selected,
  onOpen,
}: {
  slug: string;
  files: SkillFileMeta[];
  selected: string | null;
  onOpen: (path: string) => void;
}) {
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
              collapsed={collapsed}
              onToggle={toggle}
              selected={selected}
              onOpen={onOpen}
            />
          )}
        </li>
      </ul>
    </div>
  );
}

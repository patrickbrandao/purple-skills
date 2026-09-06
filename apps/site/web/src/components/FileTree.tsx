import { useMemo, useState } from 'react';
import { fileUrl, formatBytes, type SkillFileMeta } from '../api.js';
import { buildTree, SKILL_MD, type TreeNode } from '../fileTree.js';
import { FileTypeIcon, FolderIcon } from './FileTypeIcon.js';
import { ChevronRightIcon } from './Icons.js';

/* ============================================================
   ÁRVORE DE ARQUIVOS DA SKILL
   A raiz é a pasta com o slug — o mesmo nome que a pasta ganha
   quando o .zip é descompactado em `~/.claude/skills/`. Dentro
   dela vem o SKILL.md e depois as subpastas e os anexos.
   ============================================================ */

function Branch({
  nodes,
  slug,
  collapsed,
  onToggle,
}: {
  nodes: TreeNode[];
  slug: string;
  collapsed: Set<string>;
  onToggle: (path: string) => void;
}) {
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
              <Branch nodes={node.children} slug={slug} collapsed={collapsed} onToggle={onToggle} />
            )}
          </li>
        ) : (
          <li key={`f:${node.path}`}>
            <a
              className={`ft-row${node.name.toLowerCase() === SKILL_MD ? ' primary' : ''}`}
              href={fileUrl(slug, node.path)}
              title={
                node.sizeBytes === null
                  ? node.path
                  : `${node.path} — ${formatBytes(node.sizeBytes)}`
              }
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
export function FileTree({ slug, files }: { slug: string; files: SkillFileMeta[] }) {
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
            <Branch nodes={tree} slug={slug} collapsed={collapsed} onToggle={toggle} />
          )}
        </li>
      </ul>
    </div>
  );
}

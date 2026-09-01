import { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';

const FRONTMATTER = /^﻿?---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/;

/**
 * Remove o frontmatter YAML antes de renderizar — nome, descrição e tags já
 * aparecem no cabeçalho da página, e o bloco cru poluiria a leitura.
 */
export function stripFrontmatter(source: string): string {
  return source.replace(FRONTMATTER, '').trimStart();
}

/**
 * SKILL.md renderizado no frontend. HTML cru fica desativado (padrão do
 * react-markdown), então conteúdo enviado pelo admin não injeta script.
 */
export function Markdown({ children }: { children: string }) {
  const content = useMemo(() => stripFrontmatter(children), [children]);

  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
          a: ({ href, children: inner }) => (
            <a href={href} target={href?.startsWith('http') ? '_blank' : undefined} rel="noreferrer">
              {inner}
            </a>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

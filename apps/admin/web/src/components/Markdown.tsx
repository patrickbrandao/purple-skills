import { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { stripFrontmatter } from '../frontmatter.js';
import { HIGHLIGHT_MAX_CHARS } from '../highlight.js';

/**
 * SKILL.md renderizado no frontend. HTML cru fica desativado (padrão do
 * react-markdown), então conteúdo enviado pelo admin não injeta script.
 *
 * As cores do código têm o mesmo teto do leitor de arquivos
 * (`HIGHLIGHT_MAX_CHARS`): acima dele, o markdown sai inteiro, só que sem
 * `rehype-highlight`. Com `detect: true`, cada bloco sem linguagem passa pela
 * auto-detecção do highlight.js, que testa todas as gramáticas na thread
 * principal — um SKILL.md com um bloco gigante travava a aba de quem abria a
 * ficha (relatório 028 da auditoria de 2026-11-07). Este arquivo é igual no
 * site e no painel.
 */
export function Markdown({ children }: { children: string }) {
  const content = useMemo(() => stripFrontmatter(children), [children]);
  const colorir = content.length <= HIGHLIGHT_MAX_CHARS;

  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={colorir ? [[rehypeHighlight, { detect: true, ignoreMissing: true }]] : []}
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

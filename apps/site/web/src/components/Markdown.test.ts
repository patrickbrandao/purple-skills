import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown } from './Markdown.js';

const html = (source: string) => renderToStaticMarkup(createElement(Markdown, { children: source }));

/**
 * O `href` de um link vem do conteúdo da skill, e o componente `a` o repassa
 * sem filtrar: quem tira `javascript:`, `data:` e `vbscript:` é o
 * `defaultUrlTransform` do `react-markdown`, que roda **antes** do componente.
 * Passar um `urlTransform` próprio desliga essa limpeza — este teste existe
 * para isso não acontecer em silêncio (auditoria de 2026-10-01, relatório 001,
 * que apontou XSS sem contar com ela). Cópia em `apps/admin/web`.
 */
describe('Markdown: esquemas de link perigosos', () => {
  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
  ])('[x](%s) não vira href executável', (url) => {
    const saida = html(`[clique](${url})`);
    expect(saida).toContain('clique');
    expect(saida).not.toMatch(/href="(?!")/);
  });

  it('http(s) continua link, e abre em outra aba', () => {
    expect(html('[site](https://example.com)')).toContain(
      '<a href="https://example.com" target="_blank" rel="noreferrer">site</a>',
    );
  });

  it('link relativo e âncora continuam links na mesma aba', () => {
    expect(html('[a](./outro.md)')).toContain('<a href="./outro.md" rel="noreferrer">a</a>');
    expect(html('[b](#secao)')).toContain('<a href="#secao" rel="noreferrer">b</a>');
  });
});

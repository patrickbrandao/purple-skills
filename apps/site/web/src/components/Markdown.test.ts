import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HIGHLIGHT_MAX_CHARS } from '../highlight.js';
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

/**
 * O teto das cores no SKILL.md é o mesmo do leitor de arquivos: acima dele, o
 * `rehype-highlight` não roda, e a auto-detecção do highlight.js não trava a aba
 * com um bloco gigante (relatório 028 da auditoria de 2026-11-07).
 */
describe('Markdown: teto das cores do código', () => {
  const comBloco = (tamanho: number) => `# Skill\n\n\`\`\`\n${'x = 1\n'.repeat(Math.ceil(tamanho / 6))}\`\`\`\n`;

  it('abaixo do teto, o bloco sai colorido', () => {
    expect(html(comBloco(1_000))).toContain('hljs');
    // A primeira detecção carrega as gramáticas: é lenta mesmo no bloco pequeno.
  }, 20_000);

  it('acima do teto, o markdown sai inteiro e sem hljs', () => {
    const fonte = comBloco(HIGHLIGHT_MAX_CHARS + 1_000);
    expect(fonte.length).toBeGreaterThan(HIGHLIGHT_MAX_CHARS);

    const saida = html(fonte);
    expect(saida).not.toContain('hljs');
    expect(saida).toContain('<h1>Skill</h1>');
    expect(saida).toContain('<pre><code>');
    // Só o parse de 250 mil caracteres leva segundos; o prazo largo é para isso.
  }, 20_000);
});

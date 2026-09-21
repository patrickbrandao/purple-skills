import { describe, expect, it } from 'vitest';
// O texto do próprio arquivo: o JSX não roda sem DOM, e o que se prova dele
// aqui é que o painel "Chamadas" não voltou a dizer a mesma coisa duas vezes.
import fonteDaPagina from './ActivityPage.tsx?raw';
import { MCP_CALL_FAMILIES, type ActivitySlice } from '../api.js';
import { callFamilyTiles } from './ActivityPage.js';

const PAGINA = 'apps/admin/web/src/pages/ActivityPage.tsx';

const fatia = (key: string, count: number): ActivitySlice => ({ key, label: null, count });

/**
 * O painel "Chamadas" mostrava a quebra por família DUAS vezes: os tiles e,
 * logo abaixo, um bloco de barras "Por família" com os mesmos seis números na
 * mesma ordem. Ficaram os tiles — são a resposta direta ao pedido ("quantas
 * chamadas de tools, resources, prompts, skills") —, e com eles a cor da
 * família, que era o que as barras davam. O bloco de barras era também o único
 * lugar em que uma família desconhecida aparecia; por isso ela agora entra na
 * lista de tiles, no fim.
 */
describe('callFamilyTiles', () => {
  it('um tile por família, na ordem do union, mesmo no dia parado', () => {
    const tiles = callFamilyTiles([]);
    expect(tiles.map((tile) => tile.key)).toEqual([...MCP_CALL_FAMILIES]);
    expect(tiles.map((tile) => tile.count)).toEqual(MCP_CALL_FAMILIES.map(() => 0));
    // Toda família tem cor, e nenhuma cor é escrita à mão: são tokens do tema.
    for (const tile of tiles) expect(tile.tone, tile.key).toMatch(/^var\(--/);
  });

  it('a contagem vem da fatia, em qualquer ordem, e a família ausente fica em zero', () => {
    const tiles = callFamilyTiles([fatia('prompts', 4), fatia('tools', 120)]);
    const por = new Map(tiles.map((tile) => [tile.key, tile.count]));
    expect(por.get('tools')).toBe(120);
    expect(por.get('prompts')).toBe(4);
    expect(por.get('resources')).toBe(0);
    expect(por.get('session')).toBe(0);
    // A ordem não segue a contagem: a leitura não pode mudar de um dia para o outro.
    expect(tiles.map((tile) => tile.key)).toEqual([...MCP_CALL_FAMILIES]);
  });

  it('a família que o painel não conhece aparece no fim, com o nome cru', () => {
    // É o caso que a tela existe para mostrar: uma família nova do protocolo
    // chegando ao servidor antes de o painel saber dela. Com o bloco de barras
    // fora, some da tela se não entrar aqui.
    const tiles = callFamilyTiles([fatia('tools', 9), fatia('completions', 3)]);
    expect(tiles.length).toBe(MCP_CALL_FAMILIES.length + 1);
    const nova = tiles[tiles.length - 1];
    expect(nova).toEqual({ key: 'completions', label: 'completions', tone: 'var(--text-faint)', count: 3 });
    // E não se confunde com `other`, que é uma família de verdade do servidor.
    expect(tiles.filter((tile) => tile.key === 'other').length).toBe(1);
  });

  it('`other` continua sendo a família `other`, e não a cauda', () => {
    const tiles = callFamilyTiles([fatia('other', 7)]);
    expect(tiles.length).toBe(MCP_CALL_FAMILIES.length);
    expect(tiles.find((tile) => tile.key === 'other')).toEqual({
      key: 'other',
      label: 'outras',
      tone: 'var(--text-faint)',
      count: 7,
    });
  });
});

describe('o painel "Chamadas" não repete a quebra por família', () => {
  it('a quebra aparece nos tiles, e o bloco de barras gêmeo não voltou', () => {
    expect(fonteDaPagina, `os tiles de família sumiram de ${PAGINA}`).toContain('callFamilyTiles(calls.byFamily)');
    expect(fonteDaPagina, `o bloco de barras por família voltou a duplicar os tiles em ${PAGINA}`).not.toContain(
      'title="Por família"',
    );
    // Vale para qualquer título: o que não pode voltar é um bloco de barras
    // alimentado pela mesma quebra que os tiles já mostram.
    expect(fonteDaPagina, `um bloco de barras voltou a ler calls.byFamily em ${PAGINA}`).not.toMatch(
      /items=\{[^}]*calls\.byFamily/,
    );
  });

  it('a cor da família ficou com os tiles — as barras de método são pintadas por ela', () => {
    expect(fonteDaPagina).toMatch(/tone=\{familia\.tone\}/);
    expect(fonteDaPagina, 'as barras de "Métodos mais chamados" perderam a cor de família').toContain(
      'corDaFamilia(fatia.label)',
    );
  });
});

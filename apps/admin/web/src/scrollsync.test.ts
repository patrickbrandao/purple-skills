import { describe, expect, it } from 'vitest';
import { syncedScrollTop } from './scrollsync.js';

/** Painel de 600px de altura visível com `content` px de conteúdo. */
const box = (content: number, scrollTop = 0, clientHeight = 600) => ({
  scrollTop,
  scrollHeight: content,
  clientHeight,
});

describe('syncedScrollTop', () => {
  // Fonte e render do mesmo texto: 3344px de faixa contra 3484px (medido no
  // painel, com a skill de exemplo).
  const fonte = (scrollTop: number) => box(3944, scrollTop);
  const render = box(4084);

  it('espelha a fração rolada, não a posição', () => {
    expect(syncedScrollTop(fonte(1672), render)).toBeCloseTo(1742, 0);
  });

  it('mantém o topo e o fim exatamente alinhados', () => {
    expect(syncedScrollTop(fonte(0), render)).toBe(0);
    expect(syncedScrollTop(fonte(3344), render)).toBe(3484);
  });

  it('devolve null quando o painel que manda não rola', () => {
    expect(syncedScrollTop(box(400), render)).toBeNull();
  });

  it('devolve null quando o painel seguidor não rola', () => {
    expect(syncedScrollTop(fonte(1000), box(400))).toBeNull();
  });

  it('devolve null com painel escondido — o modo de um painel só zera as alturas', () => {
    const escondido = { scrollTop: 0, scrollHeight: 0, clientHeight: 0 };
    expect(syncedScrollTop(fonte(1000), escondido)).toBeNull();
    expect(syncedScrollTop(escondido, render)).toBeNull();
  });

  it('não passa do fim com rolagem elástica', () => {
    expect(syncedScrollTop(fonte(3600), render)).toBe(3484);
    expect(syncedScrollTop(fonte(-120), render)).toBe(0);
  });

  it('é simétrico: ir e voltar cai no mesmo lugar', () => {
    const ida = syncedScrollTop(fonte(2000), render);
    const volta = syncedScrollTop({ ...render, scrollTop: ida as number }, fonte(0));
    expect(volta).toBeCloseTo(2000, 0);
  });
});

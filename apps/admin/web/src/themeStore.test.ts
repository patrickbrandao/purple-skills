import { describe, expect, it, vi } from 'vitest';
import type { Theme } from './useTheme.js';
import { createThemeStore } from './themeStore.js';

/** Um `<html>` de mentira: guarda o tema e conta as escritas. */
function pagina(inicial: Theme) {
  const escritas: Theme[] = [];
  let atual = inicial;
  const read = vi.fn(() => atual);
  const write = vi.fn((theme: Theme) => {
    atual = theme;
    escritas.push(theme);
  });
  return { read, write, escritas };
}

describe('tema do painel: um estado para a página inteira', () => {
  it('não toca a página ao ser criado — só no primeiro uso, e uma vez só', () => {
    const host = pagina('dark');
    const store = createThemeStore(host);
    expect(host.read).not.toHaveBeenCalled();

    expect(store.get()).toBe('dark');
    expect(store.get()).toBe('dark');
    expect(host.read).toHaveBeenCalledTimes(1);
    expect(host.write).not.toHaveBeenCalled();
  });

  it('a troca feita por um consumidor chega a todos os outros', () => {
    const store = createThemeStore(pagina('dark'));
    // Os três do painel: menu da conta, paleta de comandos e canvas.
    const menu = vi.fn();
    const paleta = vi.fn();
    const canvas = vi.fn();
    store.subscribe(menu);
    store.subscribe(paleta);
    store.subscribe(canvas);

    store.toggle();

    expect(store.get()).toBe('light');
    for (const consumidor of [menu, paleta, canvas]) expect(consumidor).toHaveBeenCalledTimes(1);
  });

  it('trocar por um lugar e depois por outro alterna de verdade (tasks/045)', () => {
    const host = pagina('dark');
    const store = createThemeStore(host);

    // Com um estado por consumidor, o segundo partia do SEU valor velho
    // ("dark") e reescrevia "light": a tela não mudava e o rótulo mentia.
    store.toggle(); // pelo menu da conta
    store.toggle(); // pela paleta de comandos

    expect(host.escritas).toEqual(['light', 'dark']);
    expect(store.get()).toBe('dark');
  });

  it('parte do tema que o index.html escreveu, seja ele qual for', () => {
    const host = pagina('light');
    const store = createThemeStore(host);
    store.toggle();
    expect(host.escritas).toEqual(['dark']);
  });

  it('quem desmontou não é mais avisado', () => {
    const store = createThemeStore(pagina('dark'));
    const ficou = vi.fn();
    const saiu = vi.fn();
    store.subscribe(ficou);
    const sair = store.subscribe(saiu);

    sair();
    store.toggle();

    expect(ficou).toHaveBeenCalledTimes(1);
    expect(saiu).not.toHaveBeenCalled();
  });
});

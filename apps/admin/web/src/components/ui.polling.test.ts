import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startPolling } from './ui.js';

/**
 * O ciclo do `usePolling` (`tasks/051`). A tabela de sessões busca na montagem
 * pelo próprio efeito; com o poll chamando na hora também, a mesma consulta
 * saía duas vezes. `immediate: false` pula **só** a primeira chamada — voltar à
 * aba precisa continuar atualizando na hora.
 */

/** O mínimo de `document` que o ciclo usa: `hidden` e o evento de visibilidade. */
function fakeDocument() {
  const listeners = new Set<() => void>();
  const doc = {
    hidden: false,
    addEventListener: (_type: string, listener: () => void) => void listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => void listeners.delete(listener),
  };
  return {
    doc: doc as unknown as Document,
    listeners,
    /** Esconde ou mostra a aba, como o navegador faria. */
    setHidden(hidden: boolean) {
      doc.hidden = hidden;
      for (const listener of [...listeners]) listener();
    },
  };
}

describe('startPolling', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('por padrão chama na hora e depois a cada intervalo', () => {
    const fn = vi.fn();
    const { doc } = fakeDocument();
    const stop = startPolling(fn, 15_000, { doc });
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(15_000);
    expect(fn).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(30_000);
    expect(fn).toHaveBeenCalledTimes(4);
    stop();
  });

  it('immediate: false não chama na montagem — a primeira é só depois do intervalo', () => {
    const fn = vi.fn();
    const { doc } = fakeDocument();
    const stop = startPolling(fn, 15_000, { immediate: false, doc });
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(14_999);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    stop();
  });

  it('immediate: false pula só a primeira: voltar à aba atualiza na hora', () => {
    const fn = vi.fn();
    const aba = fakeDocument();
    const stop = startPolling(fn, 15_000, { immediate: false, doc: aba.doc });

    aba.setHidden(true);
    vi.advanceTimersByTime(60_000);
    expect(fn, 'aba escondida não consulta').not.toHaveBeenCalled();

    aba.setHidden(false);
    expect(fn, 'voltou: consulta na hora').toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(15_000);
    expect(fn, 'e o relógio foi rearmado').toHaveBeenCalledTimes(2);
    stop();
  });

  it('esconder a aba para o relógio; mostrar não acumula relógios', () => {
    const fn = vi.fn();
    const aba = fakeDocument();
    const stop = startPolling(fn, 1_000, { doc: aba.doc });
    expect(fn).toHaveBeenCalledTimes(1);

    aba.setHidden(true);
    vi.advanceTimersByTime(10_000);
    expect(fn).toHaveBeenCalledTimes(1);

    // Dois eventos "visível" seguidos: um relógio só, não dois.
    aba.setHidden(false);
    aba.setHidden(false);
    expect(fn).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(1_000);
    expect(fn).toHaveBeenCalledTimes(4);
    stop();
  });

  it('o que ele devolve desliga o relógio e solta o evento', () => {
    const fn = vi.fn();
    const aba = fakeDocument();
    const stop = startPolling(fn, 1_000, { doc: aba.doc });
    expect(aba.listeners.size).toBe(1);

    stop();
    expect(aba.listeners.size).toBe(0);
    vi.advanceTimersByTime(10_000);
    aba.setHidden(false);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('cada ciclo pula a própria primeira chamada (o StrictMode monta duas vezes)', () => {
    const fn = vi.fn();
    const { doc } = fakeDocument();
    startPolling(fn, 1_000, { immediate: false, doc })();
    const stop = startPolling(fn, 1_000, { immediate: false, doc });
    expect(fn).not.toHaveBeenCalled();
    stop();
  });
});

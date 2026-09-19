import { afterEach, describe, expect, it, vi } from 'vitest';
import { armChord, isChordKey } from './ui.js';

/** Um `keydown` qualquer: para o acorde só a identidade do objeto importa. */
const key = (name: string) => ({ key: name }) as KeyboardEvent;

describe('acorde "g + tecla"', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('não reclama a tecla quando ninguém apertou g', () => {
    expect(isChordKey(key('c'))).toBe(false);
  });

  it('responde igual para o mesmo evento, quantas vezes perguntarem', () => {
    const c = key('c');
    armChord();
    // Os dois listeners de `document` — a navegação e os atalhos do palco —
    // recebem este mesmo evento, em ordem que muda a cada remontagem; se o
    // segundo a perguntar ouvisse "não", `g c` navegaria e adicionaria junto.
    expect(isChordKey(c)).toBe(true);
    expect(isChordKey(c)).toBe(true);
  });

  it('vale por uma tecla só: a seguinte já não é do acorde', () => {
    armChord();
    expect(isChordKey(key('c'))).toBe(true);
    expect(isChordKey(key('c'))).toBe(false);
  });

  it('expira passada a janela do acorde', () => {
    vi.useFakeTimers({ now: new Date('2026-09-18T12:00:00Z') });
    armChord();
    vi.advanceTimersByTime(801);
    expect(isChordKey(key('c'))).toBe(false);
  });
});

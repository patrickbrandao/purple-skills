import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SkillMcpRef } from '../api.js';
import { McpChips, armChord, isChordKey, noSite } from './ui.js';

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

/**
 * A regra "está no site" do painel tinha ficado na versão anterior ao acesso
 * granular: só o vínculo com vMCP aberto. O site lista também a skill **marcada
 * pública** (`docs/12-acesso-granular.md` §7), então quem desvinculava uma skill
 * pública lia "sem vínculo: não é exibida no site" com ela ainda no ar, perdia o
 * botão "ver no site" e via o contador descontar (relatório 061 da auditoria de
 * 2026-09-19).
 */
describe('onde a skill está', () => {
  const vmcp = (patch: Partial<SkillMcpRef> = {}): SkillMcpRef => ({
    uuid: 'mcp-1',
    slug: 'time-a',
    name: 'Time A',
    isOpen: false,
    isActive: true,
    isDefault: false,
    asSkill: true,
    asPrompt: false,
    asResource: false,
    direct: true,
    catalogs: [],
    ...patch,
  });
  const skill = (patch: { isActive?: boolean; isPublic?: boolean; mcps?: SkillMcpRef[] } = {}) => ({
    isActive: true,
    isPublic: false,
    mcps: [],
    ...patch,
  });
  const selos = (alvo: ReturnType<typeof skill>) => renderToStaticMarkup(createElement(McpChips, { skill: alvo }));

  describe('noSite', () => {
    it('pública e ligada está no site, mesmo sem vínculo ou só em servidor fechado', () => {
      expect(noSite(skill({ isPublic: true }))).toBe(true);
      expect(noSite(skill({ isPublic: true, mcps: [vmcp()] }))).toBe(true);
    });

    it('não-pública depende do vínculo: servidor aberto e ligado', () => {
      expect(noSite(skill())).toBe(false);
      expect(noSite(skill({ mcps: [vmcp()] }))).toBe(false);
      expect(noSite(skill({ mcps: [vmcp({ isOpen: true, isActive: false })] }))).toBe(false);
      expect(noSite(skill({ mcps: [vmcp({ isOpen: true })] }))).toBe(true);
    });

    it('desligada não está no site, pública ou não', () => {
      expect(noSite(skill({ isActive: false, isPublic: true }))).toBe(false);
      expect(noSite(skill({ isActive: false, mcps: [vmcp({ isOpen: true })] }))).toBe(false);
    });
  });

  describe('McpChips', () => {
    it('pública sem vínculo: ganha o selo "no site", e o "sem vínculo" não afirma que ela saiu de lá', () => {
      const html = selos(skill({ isPublic: true }));

      expect(html).toContain('>sem vínculo<');
      expect(html).toContain('>no site<');
      expect(html).toContain('marcada pública, continua no site');
      expect(html).not.toContain('não é exibida no site');
    });

    it('pública só em servidor fechado: "no site", não "fora do site"', () => {
      const html = selos(skill({ isPublic: true, mcps: [vmcp()] }));

      expect(html).toContain('>no site<');
      expect(html).not.toContain('>fora do site<');
    });

    it('não-pública: sem vínculo ou fora do site, e no site pelo servidor aberto', () => {
      expect(selos(skill())).toContain('>sem vínculo<');
      expect(selos(skill())).not.toContain('>no site<');
      expect(selos(skill({ mcps: [vmcp()] }))).toContain('>fora do site<');
      expect(selos(skill({ mcps: [vmcp({ isOpen: true })] }))).toContain('>no site<');
    });

    // O catálogo público é a perna que o painel não enxerga (`skill.catalogs`
    // não traz o `is_public` dele): o texto não pode negar o que não vê.
    it('nenhum selo nega o site sem a ressalva do catálogo público', () => {
      for (const html of [selos(skill()), selos(skill({ mcps: [vmcp()] }))]) {
        expect(html).toContain('catálogo público');
        expect(html).not.toContain('não é exibida no site nem em servidor algum');
      }
    });

    it('desligada pública não ganha "no site"', () => {
      const html = selos(skill({ isActive: false, isPublic: true }));

      expect(html).toContain('desligada');
      expect(html).not.toContain('>no site<');
    });
  });
});

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EffectiveAccess, Role, SkillMcpRef } from '../api.js';
import { CloneButton, corpoDaClonagem, podeClonar, type CloneKind } from './CloneDialog.js';
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

/**
 * Clonar (`docs/16-clonagem.md`): o botão nas duas superfícies e o corpo da
 * chamada. O diálogo em si não entra aqui — ele navega, e navegar pede o
 * roteador; o que precisa de guarda é o que decide **se** o botão aparece e
 * **o que** vai no corpo.
 */
describe('clonagem', () => {
  const KINDS: CloneKind[] = ['skill', 'catalog', 'mcp'];

  describe('podeClonar', () => {
    // Clonar cria um objeto novo: mexer no original não basta, o papel da
    // sessão também tem de poder criar. Sem isso, um `membro` com `edit`
    // numa skill compartilhada ganharia por aqui um caminho para criar
    // skills que a tela "Nova skill" lhe nega.
    it('o papel que não cria não clona, por mais acesso que tenha no original', () => {
      for (const kind of KINDS) {
        expect(podeClonar(kind, 'owner', 'membro'), kind).toBe(false);
        expect(podeClonar(kind, 'manage', 'membro'), kind).toBe(false);
      }
    });

    it('skill e catálogo pedem edit; o vMCP pede manage', () => {
      for (const role of ['admin', 'editor'] as Role[]) {
        for (const kind of ['skill', 'catalog'] as CloneKind[]) {
          expect(podeClonar(kind, 'view', role), `${kind}/${role}`).toBe(false);
          expect(podeClonar(kind, 'edit', role), `${kind}/${role}`).toBe(true);
        }
        expect(podeClonar('mcp', 'edit', role), role).toBe(false);
        expect(podeClonar('mcp', 'manage', role), role).toBe(true);
        expect(podeClonar('mcp', 'owner', role), role).toBe(true);
      }
    });

    it('sem acesso nenhum, ninguém clona — nem o admin', () => {
      for (const kind of KINDS) {
        expect(podeClonar(kind, null, 'admin'), kind).toBe(false);
      }
    });
  });

  describe('CloneButton', () => {
    const botao = (kind: CloneKind, access: EffectiveAccess, role: Role, shape?: 'botao' | 'linha') =>
      renderToStaticMarkup(
        createElement(CloneButton, { kind, object: { slug: 'minha-skill', name: 'Minha Skill', access }, role, shape, onClone: () => {} }),
      );

    it('some para quem não pode clonar, como Remover já some da linha', () => {
      expect(botao('skill', 'view', 'editor')).toBe('');
      expect(botao('skill', 'owner', 'membro')).toBe('');
      expect(botao('mcp', 'edit', 'admin')).toBe('');
      expect(botao('catalog', null, 'admin')).toBe('');
    });

    it('aparece para quem pode, com o rótulo do tipo no título', () => {
      expect(botao('skill', 'edit', 'editor')).toContain('Clonar');
      expect(botao('catalog', 'edit', 'admin')).toContain('Clonar');
      expect(botao('mcp', 'manage', 'admin', 'linha')).toContain('Clonar servidor');
    });

    it('as duas formas usam classe que já existe no console, e nenhuma é utilitário do Tailwind', () => {
      // A linha da lista é o `row-action` das outras ações da linha; o
      // cabeçalho da ficha é o `btn btn-ghost` dos outros botões de lá.
      expect(botao('skill', 'edit', 'admin', 'linha')).toContain('class="row-action"');
      expect(botao('skill', 'edit', 'admin')).toContain('btn btn-ghost');
    });
  });

  describe('corpoDaClonagem', () => {
    const origem = { slug: 'minha-skill', name: 'Minha Skill' };
    const comoNasce = { name: origem.name, slug: 'minha-skill-2' };

    it('campo intocado não vai no corpo: quem desempata o slug é o servidor', () => {
      const corpo = corpoDaClonagem(origem, comoNasce);

      // `toEqual({})` não bastaria: `{ slug: undefined }` passaria, e o
      // `JSON.stringify` do cliente até o omitiria — mas o dia em que alguém
      // trocar o serializador, a chave voltaria e o 409 com ela.
      expect(Object.keys(corpo)).toEqual([]);
      expect('slug' in corpo).toBe(false);
      expect('name' in corpo).toBe(false);
    });

    it('só o que a pessoa mudou, cada campo por conta própria', () => {
      expect(corpoDaClonagem(origem, { ...comoNasce, slug: 'outra-coisa' })).toEqual({ slug: 'outra-coisa' });
      expect(corpoDaClonagem(origem, { ...comoNasce, name: 'Minha Skill (rascunho)' })).toEqual({ name: 'Minha Skill (rascunho)' });
      expect(corpoDaClonagem(origem, { name: 'Outra', slug: 'outra' })).toEqual({ name: 'Outra', slug: 'outra' });
    });

    it('espaço em volta não conta como edição, e campo vazio fica de fora', () => {
      expect(corpoDaClonagem(origem, { name: '  Minha Skill  ', slug: '  minha-skill-2  ' })).toEqual({});
      expect(corpoDaClonagem(origem, { name: '', slug: '' })).toEqual({});
    });

    it('a sugestão de quem já é cópia também é intocada: clonar a cópia não manda slug', () => {
      const copia = { slug: 'minha-skill-2', name: 'Minha Skill' };

      // A sugestão empilha, porque é o que o servidor faz — ele desempata a
      // partir do slug do original, não do nome. Mandar `-3` é edição.
      expect(corpoDaClonagem(copia, { name: copia.name, slug: 'minha-skill-2-2' })).toEqual({});
      expect(corpoDaClonagem(copia, { name: copia.name, slug: 'minha-skill-3' })).toEqual({ slug: 'minha-skill-3' });
    });
  });
});

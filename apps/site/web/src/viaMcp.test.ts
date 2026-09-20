import { describe, expect, it } from 'vitest';
import { fraseViaMcp, viaMcp } from './viaMcp.js';

/**
 * A seção "Via MCP" da página da skill ensinava `get_skill("<slug>")` sempre —
 * inclusive logo abaixo da frase "só chega ao agente pelo download acima", e em
 * skill publicada só como prompt ou resource, em que `get_skill` responde "Skill
 * não encontrada" (`tasks/076`). A página não tem teste de componente; a regra
 * de quando o cartão aparece mora nesta função, e é ela que fica cobrada.
 */

const porta = (asSkill: boolean, asPrompt = false, asResource = false) => ({
  asSkill,
  asPrompt,
  asResource,
});

describe('o que a seção "Via MCP" pode ensinar', () => {
  it('sem servidor aberto, só o download (docs/12 §7)', () => {
    expect(viaMcp([])).toEqual({ caso: 'sem-servidor' });
  });

  it('com a porta skill em todos, get_skill vale para qualquer um', () => {
    expect(viaMcp([porta(true), porta(true, true)])).toEqual({ caso: 'ferramenta', emTodos: true });
  });

  it('no caso misto o cartão continua, mas a frase aponta os servidores certos', () => {
    expect(viaMcp([porta(false, true), porta(true)])).toEqual({ caso: 'ferramenta', emTodos: false });
  });

  it('só prompt e/ou resource: get_skill não a encontra', () => {
    expect(viaMcp([porta(false, true)])).toEqual({
      caso: 'outras-portas',
      prompt: true,
      resource: false,
    });
    expect(viaMcp([porta(false, false, true)])).toEqual({
      caso: 'outras-portas',
      prompt: false,
      resource: true,
    });
    // As portas somam entre servidores: um só como prompt, outro só como resource.
    expect(viaMcp([porta(false, true), porta(false, false, true)])).toEqual({
      caso: 'outras-portas',
      prompt: true,
      resource: true,
    });
  });

  it('vinculada com as três portas desligadas', () => {
    expect(viaMcp([porta(false)])).toEqual({ caso: 'sem-porta' });
  });
});

describe('a frase da seção "Via MCP"', () => {
  const frase = (mcps: ReturnType<typeof porta>[]) => fraseViaMcp(viaMcp(mcps), mcps.length, 'minha-skill');

  // Os dois-pontos apresentam o cartão `get_skill(...)`: só cabem onde ele aparece.
  it('só termina em dois-pontos quando o cartão vem em seguida', () => {
    expect(frase([porta(true)])).toMatch(/1 servidor aberto\. .*peça pelo slug:$/);
    expect(frase([porta(true), porta(false, true)])).toMatch(/2 servidores abertos\. .*porta skill.*:$/);

    for (const semCartao of [[], [porta(false, true)], [porta(false, false, true)], [porta(false)]]) {
      expect(frase(semCartao)).toMatch(/\.$/);
    }
  });

  it('sem servidor aberto não fala em get_skill: só o download', () => {
    expect(frase([])).not.toContain('get_skill');
    expect(frase([])).toContain('download');
  });

  it('sem a porta skill, diz que get_skill não a encontra e por onde ela sai', () => {
    expect(frase([porta(false, true)])).toContain('get_skill não a encontra');
    expect(frase([porta(false, true)])).toContain('como prompt');
    expect(frase([porta(false, true)])).not.toContain('skill://');

    expect(frase([porta(false, false, true)])).toContain('skill://minha-skill');
    expect(frase([porta(false, true, true)])).toMatch(/como prompt, .* e como resource, em skill:\/\/minha-skill\.$/);
  });
});

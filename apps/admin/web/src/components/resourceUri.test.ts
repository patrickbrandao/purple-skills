import { describe, expect, it } from 'vitest';
import { PORT_HINT } from './canvas/AddSkillDialog.js';
import { SURFACES } from './SkillMcps.js';

/**
 * A dica da porta resources mostra a URI que `resources/read` aceita. Desde a
 * decisão 5 do `docs/17-skills-extension.md`, ela é `skill://<slug>/SKILL.md`;
 * `skill://<slug>` virou o diretório da skill e responde "não encontrado".
 * O painel continuou mostrando a antiga até o relatório 021 da auditoria de
 * 2026-11-07.
 */
describe('URI do resource nas dicas do painel', () => {
  const uris = (texto: string) => texto.match(/skill:\/\/\S*/g) ?? [];

  it('o rótulo da porta no vínculo aponta o SKILL.md', () => {
    const resource = SURFACES.find((s) => s.key === 'asResource')!;
    expect(uris(resource.title)).toEqual(['skill://<slug>/SKILL.md']);
  });

  it('a dica do diálogo de acrescentar skill aponta o SKILL.md', () => {
    const achadas = uris(PORT_HINT.resources);
    expect(achadas).toHaveLength(1);
    expect(achadas[0]).toMatch(/^skill:\/\/<slug>\/SKILL\.md/);
  });
});

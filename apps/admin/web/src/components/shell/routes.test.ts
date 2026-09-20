import { matchRoutes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import {
  IMPORT_SKILL_PATH,
  NEW_SKILL_PATH,
  SKILL_EDIT_ROUTE,
  SKILL_VIEW_ROUTE,
  isLegacyNewSkillPath,
  isNewSkillPath,
  legacyNewSkillTarget,
} from './routes.js';

// As rotas de skill do painel, como o `App.tsx` as declara — mais o `*` do fim.
const ROTAS = [{ path: '/skills' }, { path: NEW_SKILL_PATH }, { path: SKILL_EDIT_ROUTE }, { path: SKILL_VIEW_ROUTE }, { path: '*' }];

/** A rota que o react-router escolhe para um endereço, e os parâmetros dela. */
function escolhida(rotas: { path: string }[], endereco: string) {
  const match = matchRoutes(rotas, endereco)?.at(-1);
  return { path: match?.route.path, params: match?.params };
}

describe('a criação de skill fica fora de /skills/:slug (tasks/087)', () => {
  it('/skills/new é a ficha da skill de slug "new", como a de qualquer outra', () => {
    expect(escolhida(ROTAS, '/skills/new')).toEqual({ path: SKILL_VIEW_ROUTE, params: { slug: 'new', '*': '' } });
    expect(escolhida(ROTAS, '/skills/deploy')).toEqual({ path: SKILL_VIEW_ROUTE, params: { slug: 'deploy', '*': '' } });
    expect(escolhida(ROTAS, '/skills/new/propriedades').path).toBe(SKILL_VIEW_ROUTE);
    expect(escolhida(ROTAS, '/skills/new/editar').path).toBe(SKILL_EDIT_ROUTE);
  });

  it('o formulário tem endereço próprio, que slug nenhum alcança', () => {
    expect(escolhida(ROTAS, NEW_SKILL_PATH).path).toBe(NEW_SKILL_PATH);
    expect(escolhida(ROTAS, IMPORT_SKILL_PATH.split('?')[0]!).path).toBe(NEW_SKILL_PATH);
    expect(IMPORT_SKILL_PATH).toBe('/nova-skill?modo=zip');
    // Não começa por `/skills/`: nenhuma skill, com o slug que for, cai nele.
    expect(NEW_SKILL_PATH.startsWith('/skills/')).toBe(false);
  });

  it('a trilha e a sidebar reconhecem a tela de criação — e só ela', () => {
    expect(isNewSkillPath('/nova-skill')).toBe(true);
    expect(isNewSkillPath('/nova-skill/')).toBe(true);
    // `/skills/new` deixou de ser "nova skill": é a skill de slug `new`.
    expect(isNewSkillPath('/skills/new')).toBe(false);
    expect(isNewSkillPath('/skills')).toBe(false);
  });

  it('a armadilha: uma rota estática sob /skills/ ganha do :slug em qualquer ordem', () => {
    // É por isso que reordenar os <Route> nunca resolveu, e que o formulário
    // não pode voltar para baixo de `/skills/`.
    const noFim = [...ROTAS, { path: '/skills/new' }];
    const noComeco = [{ path: '/skills/new' }, ...ROTAS];
    expect(escolhida(noFim, '/skills/new').path).toBe('/skills/new');
    expect(escolhida(noComeco, '/skills/new').path).toBe('/skills/new');
  });
});

describe('o endereço antigo do formulário', () => {
  it('é só /skills/new exato', () => {
    expect(isLegacyNewSkillPath('new', '')).toBe(true);
    expect(isLegacyNewSkillPath('new', undefined)).toBe(true);
    // As guias da ficha nunca foram do formulário.
    expect(isLegacyNewSkillPath('new', 'propriedades')).toBe(false);
    expect(isLegacyNewSkillPath('news', '')).toBe(false);
    expect(isLegacyNewSkillPath(undefined, '')).toBe(false);
    // O roteador casava a rota estática antiga sem diferenciar maiúsculas.
    expect(isLegacyNewSkillPath('New', '')).toBe(true);
    expect(escolhida([{ path: '/skills/new' }], '/skills/New').path).toBe('/skills/new');
  });

  it('sem a skill "new", leva ao formulário com a query que veio', () => {
    expect(legacyNewSkillTarget('')).toBe('/nova-skill');
    expect(legacyNewSkillTarget('?modo=zip')).toBe(IMPORT_SKILL_PATH);
  });
});

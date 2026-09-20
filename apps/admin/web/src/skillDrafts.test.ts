import { describe, expect, it } from 'vitest';
import type { Grant, SkillDetail, SkillMcpRef } from './api.js';
import { EMPTY_DRAFTS, describeChange, planChanges, pruneDrafts, type SkillDrafts } from './skillDrafts.js';

const mcp = (uuid: string, extra: Partial<SkillMcpRef> = {}): SkillMcpRef => ({
  uuid,
  slug: uuid,
  name: uuid.toUpperCase(),
  isOpen: false,
  isActive: true,
  isDefault: false,
  asSkill: true,
  asPrompt: false,
  asResource: false,
  direct: true,
  catalogs: [],
  ...extra,
});

const grant = (userUuid: string, level: Grant['level']): Grant => ({
  userUuid,
  email: `${userUuid}@x.dev`,
  name: userUuid,
  role: 'membro',
  isActive: true,
  level,
  grantedByUserUuid: null,
  grantedByEmail: null,
  createdAt: '2026-09-16T00:00:00Z',
});

const SKILL = {
  uuid: 's1',
  slug: 'minha',
  name: 'Minha',
  isPublic: false,
  ownerUserUuid: 'dono',
  // O dono se compara pelo e-mail: é o que a busca de contas devolve (`tasks/025`).
  ownerEmail: 'dono@x.dev',
  mcps: [mcp('m1'), mcp('m2', { direct: false, catalogs: [{ uuid: 'c1', slug: 'c1', name: 'C1' }] })],
  catalogs: [
    { uuid: 'c1', slug: 'c1', name: 'C1', isActive: true, memberActive: true },
    { uuid: 'c2', slug: 'c2', name: 'C2', isActive: true, memberActive: false },
  ],
  grants: [grant('ana', 'view'), grant('bia', 'edit')],
} as unknown as SkillDetail;

const drafts = (patch: Partial<SkillDrafts>): SkillDrafts => ({ ...EMPTY_DRAFTS, ...patch });
const types = (value: SkillDrafts) => planChanges(SKILL, value).map((change) => change.type);

describe('planChanges', () => {
  it('sem rascunho não há o que enviar', () => {
    expect(planChanges(SKILL, EMPTY_DRAFTS)).toEqual([]);
  });

  it('desmarcar todas as portas de um vínculo direto tira a skill do servidor', () => {
    const plan = planChanges(SKILL, drafts({ links: { m1: { slug: 'm1', name: 'M1', asSkill: false, asPrompt: false, asResource: false } } }));
    expect(plan).toEqual([{ type: 'unlink', mcpUuid: 'm1', slug: 'm1', name: 'M1' }]);
  });

  it('servidor alcançado só por catálogo sem porta marcada não é pendência', () => {
    expect(types(drafts({ links: { m2: { slug: 'm2', name: 'M2', asSkill: false, asPrompt: false, asResource: false } } }))).toEqual([]);
  });

  it('marcar porta num servidor por catálogo cria o vínculo direto', () => {
    const [change] = planChanges(SKILL, drafts({ links: { m2: { slug: 'm2', name: 'M2', asSkill: false, asPrompt: true, asResource: false } } }));
    expect(change).toMatchObject({ type: 'link', isNew: true, flags: { asSkill: false, asPrompt: true, asResource: false } });
  });

  it('portas iguais às gravadas não mudam nada; diferentes mudam', () => {
    expect(types(drafts({ links: { m1: { slug: 'm1', name: 'M1', asSkill: true, asPrompt: false, asResource: false } } }))).toEqual([]);
    const [change] = planChanges(SKILL, drafts({ links: { m1: { slug: 'm1', name: 'M1', asSkill: true, asPrompt: true, asResource: false } } }));
    expect(change).toMatchObject({ type: 'link', isNew: false });
  });

  it('catálogos: adicionar, desativar, reativar e remover', () => {
    const plan = planChanges(
      SKILL,
      drafts({
        catalogs: {
          c1: { slug: 'c1', name: 'C1', member: true, active: false },
          c2: { slug: 'c2', name: 'C2', member: false, active: false },
          c3: { slug: 'c3', name: 'C3', member: true, active: true },
          c4: { slug: 'c4', name: 'C4', member: false, active: true },
        },
      }),
    );
    expect(plan).toEqual([
      { type: 'catalog-active', catalogUuid: 'c1', slug: 'c1', name: 'C1', active: false },
      { type: 'catalog-remove', catalogUuid: 'c2', slug: 'c2', name: 'C2' },
      { type: 'catalog-add', catalogUuid: 'c3', slug: 'c3', name: 'C3', active: true },
    ]);
  });

  it('acesso: público, concessões e o dono por último', () => {
    const plan = planChanges(
      SKILL,
      drafts({
        access: {
          isPublic: true,
          owner: { uuid: 'nova', email: 'nova@x.dev', name: 'Nova', role: 'editor' },
          grants: {
            'ana@x.dev': { email: 'ana@x.dev', name: 'ana', role: 'membro', level: null },
            'bia@x.dev': { email: 'bia@x.dev', name: 'bia', role: 'membro', level: 'edit' },
            'caio@x.dev': { email: 'caio@x.dev', name: 'caio', role: 'membro', level: 'manage' },
          },
        },
      }),
    );
    expect(plan.map((change) => change.type)).toEqual(['public', 'revoke', 'grant', 'owner']);
    expect(plan[2]).toMatchObject({ email: 'caio@x.dev', level: 'manage', isNew: true });
  });

  it('o público igual ao gravado e o dono atual não são pendência', () => {
    expect(types(drafts({ access: { isPublic: false, owner: { uuid: 'dono', email: 'dono@x.dev', name: 'D', role: 'admin' }, grants: {} } }))).toEqual([]);
  });

  it('mudar o nível de quem já tem concessão não é concessão nova', () => {
    const [change] = planChanges(
      SKILL,
      drafts({ access: { grants: { 'bia@x.dev': { email: 'bia@x.dev', name: 'bia', role: 'membro', level: 'manage' } } } }),
    );
    expect(change).toMatchObject({ type: 'grant', email: 'bia@x.dev', level: 'manage', isNew: false });
  });

  it('revogar quem não tem concessão não é pendência', () => {
    expect(types(drafts({ access: { grants: { 'zeca@x.dev': { email: 'zeca@x.dev', name: 'z', role: 'membro', level: null } } } }))).toEqual([]);
  });
});

describe('pruneDrafts', () => {
  it('guarda só o que ainda muda alguma coisa', () => {
    const pruned = pruneDrafts(
      SKILL,
      drafts({
        links: {
          m1: { slug: 'm1', name: 'M1', asSkill: true, asPrompt: false, asResource: false },
          m3: { slug: 'm3', name: 'M3', asSkill: true, asPrompt: false, asResource: false },
        },
        catalogs: { c1: { slug: 'c1', name: 'C1', member: true, active: true } },
        access: {
          isPublic: false,
          grants: { 'ana@x.dev': { email: 'ana@x.dev', name: 'ana', role: 'membro', level: 'view' } },
        },
      }),
    );
    expect(Object.keys(pruned.links)).toEqual(['m3']);
    expect(pruned.catalogs).toEqual({});
    expect(pruned.access).toEqual({ isPublic: undefined, owner: undefined, grants: {} });
  });
});

describe('describeChange', () => {
  it('dá uma frase para cada tipo', () => {
    expect(describeChange({ type: 'unlink', mcpUuid: 'm1', slug: 'm1', name: 'M1' })).toBe('tirar de "M1"');
    expect(describeChange({ type: 'catalog-add', catalogUuid: 'c', slug: 'c', name: 'C', active: false })).toBe(
      'adicionar ao catálogo "C" (participação desativada)',
    );
  });
});

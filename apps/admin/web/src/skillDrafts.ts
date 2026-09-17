import type { AccessLevel, LinkFlags, Role, SkillDetail, UserLookup } from './api.js';

/**
 * O que a edição da skill guarda até o Salvar (`docs/13-fichas-e-acessos.md`
 * decisão 21): as portas por servidor, a participação nos catálogos e o
 * acesso. Nada disso vai ao servidor na hora — o Salvar do cabeçalho envia
 * tudo junto com o formulário, e o que falhar continua pendente.
 *
 * Cada rascunho descreve o estado **desejado**; o que muda de fato sai de
 * `planChanges`, comparando com a skill gravada. Um vai-e-volta não é
 * pendência, e o rascunho que ficou igual ao gravado some em `pruneDrafts`.
 */

/** As portas desejadas num servidor; todas desmarcadas tira o vínculo direto. */
export type LinkDraft = LinkFlags & { slug: string; name: string };

/** A participação desejada num catálogo. */
export type CatalogDraft = { slug: string; name: string; member: boolean; active: boolean };

/** O nível desejado de uma conta; `null` revoga. */
export type GrantDraft = { userUuid: string; email: string; name: string; role: Role; level: AccessLevel | null };

export type AccessDraft = {
  /** `undefined` não mexe. */
  isPublic?: boolean;
  /** O novo dono; `undefined` não mexe. */
  owner?: UserLookup;
  /** Por uuid da conta. */
  grants: Record<string, GrantDraft>;
};

export type SkillDrafts = {
  /** Por uuid do vMCP. */
  links: Record<string, LinkDraft>;
  /** Por uuid do catálogo. */
  catalogs: Record<string, CatalogDraft>;
  access: AccessDraft;
};

export const EMPTY_ACCESS_DRAFT: AccessDraft = { grants: {} };
export const EMPTY_DRAFTS: SkillDrafts = { links: {}, catalogs: {}, access: EMPTY_ACCESS_DRAFT };

export const noPorts = (flags: LinkFlags) => !flags.asSkill && !flags.asPrompt && !flags.asResource;

const sameFlags = (a: LinkFlags, b: LinkFlags) =>
  a.asSkill === b.asSkill && a.asPrompt === b.asPrompt && a.asResource === b.asResource;

const flagsOf = (value: LinkFlags): LinkFlags => ({
  asSkill: value.asSkill,
  asPrompt: value.asPrompt,
  asResource: value.asResource,
});

/** As portas do vínculo direto gravado, ou `null` sem vínculo direto (por catálogo não conta). */
export function directFlags(skill: SkillDetail, mcpUuid: string): LinkFlags | null {
  const mcp = skill.mcps.find((item) => item.uuid === mcpUuid);
  return mcp?.direct ? flagsOf(mcp) : null;
}

/** A participação gravada num catálogo. */
export function membership(skill: SkillDetail, catalogUuid: string): { member: boolean; active: boolean } {
  const catalog = skill.catalogs.find((item) => item.uuid === catalogUuid);
  return catalog ? { member: true, active: catalog.memberActive } : { member: false, active: false };
}

export type PlannedChange =
  | { type: 'public'; value: boolean }
  | { type: 'link'; mcpUuid: string; slug: string; name: string; flags: LinkFlags; isNew: boolean }
  | { type: 'unlink'; mcpUuid: string; slug: string; name: string }
  | { type: 'catalog-add'; catalogUuid: string; slug: string; name: string; active: boolean }
  | { type: 'catalog-active'; catalogUuid: string; slug: string; name: string; active: boolean }
  | { type: 'catalog-remove'; catalogUuid: string; slug: string; name: string }
  | { type: 'grant'; userUuid: string; email: string; level: AccessLevel; isNew: boolean }
  | { type: 'revoke'; userUuid: string; email: string }
  | { type: 'owner'; user: UserLookup };

function linkChange(skill: SkillDetail, mcpUuid: string, draft: LinkDraft): PlannedChange | null {
  const current = directFlags(skill, mcpUuid);
  const base = { mcpUuid, slug: draft.slug, name: draft.name };
  if (noPorts(draft)) return current ? { type: 'unlink', ...base } : null;
  if (current && sameFlags(current, draft)) return null;
  return { type: 'link', ...base, flags: flagsOf(draft), isNew: current === null };
}

function catalogChange(skill: SkillDetail, catalogUuid: string, draft: CatalogDraft): PlannedChange | null {
  const current = membership(skill, catalogUuid);
  const base = { catalogUuid, slug: draft.slug, name: draft.name };
  if (!draft.member) return current.member ? { type: 'catalog-remove', ...base } : null;
  if (!current.member) return { type: 'catalog-add', ...base, active: draft.active };
  return current.active === draft.active ? null : { type: 'catalog-active', ...base, active: draft.active };
}

function grantChange(skill: SkillDetail, draft: GrantDraft): PlannedChange | null {
  const current = skill.grants.find((item) => item.userUuid === draft.userUuid);
  if (draft.level === null) return current ? { type: 'revoke', userUuid: draft.userUuid, email: draft.email } : null;
  if (current?.level === draft.level) return null;
  return { type: 'grant', userUuid: draft.userUuid, email: draft.email, level: draft.level, isNew: !current };
}

/**
 * O que o Salvar vai enviar, na ordem em que envia: público, portas,
 * catálogos, concessões e, por último, o dono — transferir pode tirar da
 * sessão o direito de fazer o resto.
 */
export function planChanges(skill: SkillDetail, drafts: SkillDrafts): PlannedChange[] {
  const changes: PlannedChange[] = [];
  const { access } = drafts;

  if (access.isPublic !== undefined && access.isPublic !== skill.isPublic) {
    changes.push({ type: 'public', value: access.isPublic });
  }
  for (const [uuid, draft] of Object.entries(drafts.links)) {
    const change = linkChange(skill, uuid, draft);
    if (change) changes.push(change);
  }
  for (const [uuid, draft] of Object.entries(drafts.catalogs)) {
    const change = catalogChange(skill, uuid, draft);
    if (change) changes.push(change);
  }
  for (const draft of Object.values(access.grants)) {
    const change = grantChange(skill, draft);
    if (change) changes.push(change);
  }
  if (access.owner && access.owner.uuid !== skill.ownerUserUuid) {
    changes.push({ type: 'owner', user: access.owner });
  }
  return changes;
}

/** Tira os rascunhos que já não mudam nada — o que foi gravado, ou o vai-e-volta. */
export function pruneDrafts(skill: SkillDetail, drafts: SkillDrafts): SkillDrafts {
  const keep = <T>(record: Record<string, T>, changes: (key: string, value: T) => boolean) =>
    Object.fromEntries(Object.entries(record).filter(([key, value]) => changes(key, value)));

  const { access } = drafts;
  return {
    links: keep(drafts.links, (uuid, draft) => linkChange(skill, uuid, draft) !== null),
    catalogs: keep(drafts.catalogs, (uuid, draft) => catalogChange(skill, uuid, draft) !== null),
    access: {
      isPublic: access.isPublic !== undefined && access.isPublic !== skill.isPublic ? access.isPublic : undefined,
      owner: access.owner && access.owner.uuid !== skill.ownerUserUuid ? access.owner : undefined,
      grants: keep(access.grants, (_uuid, draft) => grantChange(skill, draft) !== null),
    },
  };
}

/** A frase de uma pendência, para a lista do Salvar e para os erros. */
export function describeChange(change: PlannedChange): string {
  switch (change.type) {
    case 'public':
      return change.value ? 'marcar como pública' : 'voltar a privada';
    case 'link':
      return change.isNew ? `publicar em "${change.name}"` : `mudar as portas em "${change.name}"`;
    case 'unlink':
      return `tirar de "${change.name}"`;
    case 'catalog-add':
      return `adicionar ao catálogo "${change.name}"${change.active ? '' : ' (participação desativada)'}`;
    case 'catalog-active':
      return `${change.active ? 'reativar' : 'desativar'} a participação em "${change.name}"`;
    case 'catalog-remove':
      return `tirar do catálogo "${change.name}"`;
    case 'grant':
      return change.isNew ? `compartilhar com ${change.email}` : `mudar o nível de ${change.email}`;
    case 'revoke':
      return `revogar o acesso de ${change.email}`;
    case 'owner':
      return `transferir para ${change.user.email}`;
  }
}

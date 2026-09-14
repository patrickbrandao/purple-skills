/**
 * Papéis de acesso do painel e do MCP administrativo, e os níveis de acesso
 * por objeto (`docs/12-acesso-granular.md`).
 *
 * O papel é **global** e limita a **ação**: criar (editor+) e gerenciar a
 * instalação (admin). O **escopo** — em que skills, catálogos e vMCPs a conta
 * mexe — é do dono e das concessões por objeto (`accessLevel`). Admin não é
 * afetado pela ACL: tem tudo em tudo.
 */
export type Role = 'admin' | 'editor' | 'membro';

export const ROLES: readonly Role[] = ['admin', 'editor', 'membro'];

/** Poder relativo — usado só por `roleAtLeast`, nunca para inferir permissão. */
const RANK: Record<Role, number> = { membro: 0, editor: 1, admin: 2 };

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function roleAtLeast(role: Role, minimum: Role): boolean {
  return RANK[role] >= RANK[minimum];
}

/**
 * Criar skill, catálogo ou MCP virtual — admin e editor (`docs/12` decisão
 * 12). Quem cria vira dono. É a única coisa que separa `editor` de `membro`.
 */
export const canCreate = (role: Role): boolean => roleAtLeast(role, 'editor');

/** @deprecated Nome antigo de `canCreate`: hoje "escrever" no acervo é criar. */
export const canWrite = canCreate;

/** Criar contas, trocar papéis, desativar e resetar senha; ler a auditoria; escolher o MCP padrão. */
export const canManageUsers = (role: Role): boolean => role === 'admin';

/** @deprecated Use `canCreate`. */
export const canCreateVirtualMcp = canCreate;
/** @deprecated Use `canCreate`. */
export const canCreateCatalog = canCreate;

export const ROLE_LABEL: Record<Role, string> = {
  admin: 'administrador',
  editor: 'editor',
  membro: 'membro',
};

// --------------------------------------------------------- acesso por objeto ---

/**
 * O nível de uma concessão (`skill_grants`, `catalog_grants`,
 * `virtual_mcp_grants`). Cumulativos: `manage` inclui `edit`, que inclui
 * `view`. O que cada um cobre está em `docs/12-acesso-granular.md` §3.2.
 */
export type AccessLevel = 'view' | 'edit' | 'manage';

export const ACCESS_LEVELS: readonly AccessLevel[] = ['view', 'edit', 'manage'];

export function isAccessLevel(value: unknown): value is AccessLevel {
  return typeof value === 'string' && (ACCESS_LEVELS as readonly string[]).includes(value);
}

/**
 * O que uma conta pode num objeto: um dos três níveis, `'owner'` (dono ou
 * admin — apaga e transfere, o que nenhum nível dá) ou `null` (não vê).
 */
export type EffectiveAccess = AccessLevel | 'owner' | null;

const ACCESS_RANK: Record<Exclude<EffectiveAccess, null>, number> = {
  view: 1,
  edit: 2,
  manage: 3,
  owner: 4,
};

/**
 * Resolve o acesso de uma conta a um objeto (`docs/12` §3.3).
 *
 * Admin tem `'owner'` em tudo — inclusive a sessão de bootstrap e o
 * `MCP_ADMIN_TOKEN`, que são admin sem conta (`userUuid` nulo). Fora isso, o
 * dono tem `'owner'`, e quem tem concessão tem o nível dela. Contêiner que
 * expõe conteúdo (vMCP e catálogo, decisão 5) **não** entra aqui: isso é
 * leitura resolvida na consulta, e chega ao app já como `'view'`.
 */
export function accessLevel(
  role: Role,
  ownerUserUuid: string | null,
  grant: AccessLevel | null,
  userUuid: string | null,
): EffectiveAccess {
  if (role === 'admin') return 'owner';
  if (userUuid !== null && ownerUserUuid === userUuid) return 'owner';
  return grant;
}

export const accessAtLeast = (access: EffectiveAccess, minimum: AccessLevel | 'owner'): boolean =>
  access !== null && ACCESS_RANK[access] >= ACCESS_RANK[minimum];

/** Ler o objeto (e, num contêiner, o que está dentro). */
export const canView = (access: EffectiveAccess): boolean => accessAtLeast(access, 'view');

/** Conteúdo da skill; membros do catálogo; vínculos, portas e canvas do vMCP. */
export const canEdit = (access: EffectiveAccess): boolean => accessAtLeast(access, 'edit');

/** Slug, estado, público/aberto, chaves do vMCP e as concessões. */
export const canManage = (access: EffectiveAccess): boolean => accessAtLeast(access, 'manage');

/** Apagar e transferir o dono — só dono e admin. */
export const canOwn = (access: EffectiveAccess): boolean => access === 'owner';

export const ACCESS_LABEL: Record<Exclude<EffectiveAccess, null>, string> = {
  view: 'visualizar',
  edit: 'editar',
  manage: 'administrar',
  owner: 'dono',
};

/**
 * Compatibilidade com o modelo anterior (`docs/08` §3.1, `docs/11` §3.4):
 * "admin manda em todos; o dono, no seu". Continua correto como "tem
 * `'owner'`"; o que mudou é que agora há níveis abaixo disso.
 * @deprecated Use `accessLevel` + `canManage`/`canOwn`.
 */
export const canManageVirtualMcp = (
  role: Role,
  ownerUserUuid: string | null,
  userUuid: string | null,
): boolean => canOwn(accessLevel(role, ownerUserUuid, null, userUuid));

/** @deprecated Use `accessLevel` + `canManage`/`canOwn`. */
export const canManageCatalog = canManageVirtualMcp;

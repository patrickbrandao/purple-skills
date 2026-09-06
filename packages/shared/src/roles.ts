/**
 * Papéis de acesso do painel e do MCP administrativo.
 *
 * São **globais**, não por skill: o papel limita a ação, nunca o escopo. Um
 * editor mexe em qualquer skill; o que ele não faz é apagar skill nem
 * gerenciar contas. Ver `docs/05-accounts-and-roles.md` §2.1.
 */
export type Role = 'admin' | 'editor' | 'leitor';

export const ROLES: readonly Role[] = ['admin', 'editor', 'leitor'];

/** Poder relativo — usado só por `roleAtLeast`, nunca para inferir permissão. */
const RANK: Record<Role, number> = { leitor: 0, editor: 1, admin: 2 };

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function roleAtLeast(role: Role, minimum: Role): boolean {
  return RANK[role] >= RANK[minimum];
}

/** Criar/editar skills, arquivos e visibilidade. */
export const canWrite = (role: Role): boolean => roleAtLeast(role, 'editor');

/** Apagar skill — irreversível, só admin. */
export const canDelete = (role: Role): boolean => role === 'admin';

/** Criar contas, trocar papéis, desativar e resetar senha. */
export const canManageUsers = (role: Role): boolean => role === 'admin';

export const ROLE_LABEL: Record<Role, string> = {
  admin: 'administrador',
  editor: 'editor',
  leitor: 'leitor',
};

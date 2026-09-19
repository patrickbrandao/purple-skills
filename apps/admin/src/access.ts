import {
  AppError,
  badRequest,
  getSkillDetail,
  getSkillSummary,
  getUserByEmail,
  lookupUsers,
  notFound,
  removeSkillGrant,
  setSkillGrant,
} from '@purple-skills/db';
import {
  ACCESS_LABEL,
  accessAtLeast,
  canManage,
  isAccessLevel,
  normalizeEmail,
  type AccessLevel,
  type EffectiveAccess,
  type Grant,
  type SkillDetail,
  type SkillSummary,
  type UserLookup,
} from '@purple-skills/shared';
import type { NextFunction, Request, Response } from 'express';
import { actorOf, viewerOf, type AuthUser } from './auth.js';

const SOURCE = 'web-admin' as const;

export const forbidden = (message: string): AppError => new AppError(message, 403, 'forbidden');

/**
 * O acesso por objeto do painel (`docs/12-acesso-granular.md`).
 *
 * As consultas já devolvem só o que a conta enxerga (`viewer`) e dizem, em
 * `access`, o que ela pode em cada linha. Aqui fica o que é do app: exigir o
 * nível mínimo de uma ação, esconder a lista de concessões de quem não a
 * administra e resolver um e-mail numa conta ao compartilhar.
 */

/**
 * Exige um nível mínimo. Quem não vê o objeto recebe 404 — a consulta com
 * `viewer` já devolveu nulo antes de chegar aqui —, quem vê mas não chega ao
 * nível recebe 403 com o nível que tem e o que precisaria.
 */
export function assertAccess(access: EffectiveAccess, minimum: AccessLevel | 'owner', what: string): void {
  if (access === null || access === undefined) throw notFound(`${what} não encontrado`);
  if (!accessAtLeast(access, minimum)) {
    throw forbidden(
      `Seu acesso a este ${what} é "${ACCESS_LABEL[access]}"; esta ação exige "${ACCESS_LABEL[minimum]}"`,
    );
  }
}

/**
 * A lista de concessões só vai para quem tem `manage` (decisão 11): quem tem
 * `view` ou `edit` vê o dono e o flag público, não com quem divide.
 */
export function withGrants<T extends { access: EffectiveAccess; grants: Grant[] }>(object: T): T {
  return canManage(object.access) ? object : { ...object, grants: [] };
}

// ------------------------------------------------------------------ skills ---

export async function loadSkill(user: AuthUser, slug: string, minimum: AccessLevel | 'owner'): Promise<SkillDetail> {
  const detail = await getSkillDetail(slug, { viewer: viewerOf(user) });
  if (!detail) throw notFound('Skill não encontrada');
  assertAccess(detail.access, minimum, 'skill');
  return detail;
}

export async function loadSkillSummary(
  user: AuthUser,
  slug: string,
  minimum: AccessLevel | 'owner',
): Promise<SkillSummary> {
  const skill = await getSkillSummary(slug, { viewer: viewerOf(user) });
  if (!skill) throw notFound('Skill não encontrada');
  assertAccess(skill.access, minimum, 'skill');
  return skill;
}

/**
 * Middleware para as rotas de upload: o nível é conferido **antes** de o
 * multer ler o corpo, para não gastar memória com um .zip que será recusado.
 */
export const requireSkillAccess =
  (minimum: AccessLevel | 'owner') =>
  (req: Request, res: Response, next: NextFunction): void => {
    const slug = String((req.params as Record<string, unknown>).slug ?? '');
    loadSkillSummary(req.user!, slug, minimum)
      .then(() => next())
      .catch((err: unknown) => {
        if (err instanceof AppError) {
          res.status(err.status).json({ error: err.code, message: err.message });
          return;
        }
        next(err);
      });
  };

/**
 * Vincular uma skill a um contêiner exige `view` nela (decisão 6): é o que
 * "posso usá-la nos meus contêineres" significa. Slug desconhecido ou fora
 * do que a conta vê é 404, para não revelar o que existe.
 */
export async function assertSkillsViewable(user: AuthUser, slugs: Iterable<string>): Promise<void> {
  for (const slug of new Set(slugs)) await loadSkillSummary(user, slug, 'view');
}

// -------------------------------------------------------------- concessões ---

export function levelFrom(raw: unknown): AccessLevel {
  if (!isAccessLevel(raw)) throw badRequest('"level" precisa ser view, edit ou manage');
  return raw;
}

/** A conta alvo de uma concessão ou transferência, pelo e-mail. */
export async function accountByEmail(rawEmail: string): Promise<{ uuid: string; email: string }> {
  const email = normalizeEmail(rawEmail);
  if (!email) throw badRequest('Informe o e-mail da conta');
  const user = await getUserByEmail(email);
  if (!user || !user.isActive) throw notFound(`Conta não encontrada ou desativada: ${email}`);
  return { uuid: user.uuid, email: user.email };
}

/**
 * A conta como ela sai do painel: identificada pelo **e-mail**, sem o `uuid`.
 *
 * O `uuid` é o `sub` do cookie de sessão (`auth.ts`), e o único outro campo do
 * payload é uma versão inteira pequena: entregar `uuid` + papel de toda conta
 * ativa a qualquer sessão é dizer a um membro qual crachá forjar. O e-mail já
 * identifica a conta em todas as rotas de concessão, e já é visível para o
 * mesmo público (`docs/12` decisão 13 e §10), então nada de novo vaza aqui.
 *
 * `uuid` continua no objeto como apelido do e-mail só enquanto o painel o ler.
 */
export const withoutUuid = (user: UserLookup): UserLookup => ({
  email: user.email,
  name: user.name,
  role: user.role,
  uuid: user.email,
});

/**
 * Busca de contas para compartilhar (decisão 13): qualquer sessão, só contas
 * ativas, e nunca o `uuid` da conta — ver `withoutUuid`.
 */
export async function lookup(rawQuery: unknown): Promise<UserLookup[]> {
  const q = typeof rawQuery === 'string' ? rawQuery.trim() : '';
  if (q.length < 2) return [];
  return (await lookupUsers(q)).map(withoutUuid);
}

export async function shareSkill(user: AuthUser, slug: string, email: string, rawLevel: unknown): Promise<Grant> {
  const skill = await loadSkillSummary(user, slug, 'manage');
  const target = await accountByEmail(email);
  return setSkillGrant(skill.slug, target.uuid, levelFrom(rawLevel), SOURCE, actorOf(user));
}

export async function unshareSkill(user: AuthUser, slug: string, email: string): Promise<void> {
  const skill = await loadSkillSummary(user, slug, 'manage');
  const target = await accountByEmail(email);
  await removeSkillGrant(skill.slug, target.uuid, SOURCE, actorOf(user));
}

/** UUID canônico, como o banco grava — o que não é e-mail tem de ter esta cara. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const OWNER_FORMAT = 'ownerUserUuid precisa ser o e-mail da conta, um UUID ou null';

/** `ownerUserUuid` do corpo de um PATCH: transferir exige `'owner'` e uma conta ativa. */
export async function ownerFrom(
  user: AuthUser,
  access: EffectiveAccess,
  raw: unknown,
  what: string,
): Promise<string | null | undefined> {
  if (raw === undefined) return undefined;
  assertAccess(access, 'owner', what);
  if (raw === null) {
    // Deixar sem dono é do admin: um dono comum não pode abandonar o objeto
    // num estado em que só o admin o alcança.
    if (user.role !== 'admin') throw forbidden(`Só um administrador deixa um ${what} sem dono`);
    return null;
  }
  if (typeof raw !== 'string' || !raw.trim()) throw badRequest(OWNER_FORMAT);
  const target = raw.trim();
  // A busca de contas não entrega mais o `uuid` (ver `withoutUuid`), então o
  // novo dono chega pelo e-mail — o mesmo identificador das rotas de concessão,
  // e com a conferência de conta ativa que o UUID cru não faz. O UUID continua
  // aceito para quem já integra pela REST.
  if (target.includes('@')) return (await accountByEmail(target)).uuid;
  if (!UUID.test(target)) throw badRequest(OWNER_FORMAT);
  return target;
}

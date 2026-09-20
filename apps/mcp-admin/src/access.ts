import { AppError, badRequest, getSkillSummary, getUserByEmail, notFound } from '@purple-skills/db';
import {
  ACCESS_LABEL,
  accessAtLeast,
  isAccessLevel,
  normalizeEmail,
  type AccessLevel,
  type EffectiveAccess,
  type Grant,
  type Role,
  type SkillSummary,
} from '@purple-skills/shared';
import type { Caller } from './auth.js';

/**
 * O acesso por objeto no MCP administrativo (`docs/12-acesso-granular.md`),
 * com o mesmo alcance do painel: as consultas recebem o `viewer` e devolvem
 * só o que a credencial enxerga, com `access` por linha; aqui fica exigir o
 * nível mínimo de cada tool e resolver e-mails em contas.
 */

/** Quem está lendo: o token global e a sessão sem conta são admin (veem tudo). */
export const viewerOf = (caller: Caller): { role: Role; userUuid: string | null } => ({
  role: caller.role,
  userUuid: caller.actor.userUuid,
});

export const forbidden = (message: string): AppError => new AppError(message, 403, 'forbidden');

/** Exige um nível mínimo; quem não vê o objeto já recebeu 404 antes de chegar aqui. */
export function assertAccess(access: EffectiveAccess, minimum: AccessLevel | 'owner', what: string): void {
  if (access === null || access === undefined) throw notFound(`${what} não encontrado`);
  if (!accessAtLeast(access, minimum)) {
    throw forbidden(
      `Seu acesso a este ${what} é "${ACCESS_LABEL[access]}"; esta ação exige "${ACCESS_LABEL[minimum]}".`,
    );
  }
}

/** Carrega uma skill que a credencial vê, com o nível mínimo da ação. */
export async function loadSkill(caller: Caller, slug: string, minimum: AccessLevel | 'owner'): Promise<SkillSummary> {
  const skill = await getSkillSummary(slug, { viewer: viewerOf(caller) });
  if (!skill) throw notFound(`Skill não encontrada: "${slug}"`);
  assertAccess(skill.access, minimum, 'skill');
  return skill;
}

/** Vincular uma skill a um contêiner exige `view` nela (decisão 6 do `12`). */
export async function assertSkillsViewable(caller: Caller, slugs: Iterable<string>): Promise<void> {
  for (const slug of new Set(slugs)) await loadSkill(caller, slug, 'view');
}

export function levelFrom(raw: unknown): AccessLevel {
  if (!isAccessLevel(raw)) throw badRequest('"level" precisa ser view, edit ou manage');
  return raw;
}

/**
 * A conta alvo de uma **concessão ou transferência**, pelo e-mail: precisa
 * existir e estar ativa. Mudar o nível é a mesma chamada de conceder, e também
 * passa por aqui. Revogar **não**: ver `grantOf`.
 */
export async function accountByEmail(rawEmail: string): Promise<{ uuid: string; email: string }> {
  const email = normalizeEmail(rawEmail);
  if (!email) throw badRequest('Informe o e-mail da conta');
  const user = await getUserByEmail(email);
  if (!user || !user.isActive) throw notFound(`Conta não encontrada ou desativada: ${email}`);
  return { uuid: user.uuid, email: user.email };
}

/**
 * A concessão a revogar, procurada pelo e-mail **na lista do próprio objeto** —
 * a que quem tem `manage` já lê —, e não em `users`. Gêmea da do painel
 * (`apps/admin/src/access.ts`), onde está o porquê inteiro: revogar passava por
 * `accountByEmail`, que exige conta ativa, e a concessão de quem foi desativado
 * depois de recebê-la não saía por tool nenhuma, contra a decisão 10 do
 * `docs/12` (relatório 039 da auditoria de 2026-09-19). Pela lista a resposta
 * também não diz se existe conta com aquele e-mail.
 */
export function grantOf(grants: readonly Grant[], rawEmail: string, where: string): Grant {
  const email = normalizeEmail(rawEmail);
  if (!email) throw badRequest('Informe o e-mail da conta');
  const grant = grants.find((item) => item.email.toLowerCase() === email);
  // `where` é o lugar por extenso — "nesta skill", "neste catálogo".
  if (!grant) throw notFound(`A conta não tem concessão ${where}`);
  return grant;
}

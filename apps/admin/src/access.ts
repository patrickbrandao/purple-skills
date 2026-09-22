import {
  AppError,
  badRequest,
  getSkillDetail,
  getSkillSummary,
  getUserByUsername,
  listSkillGrants,
  lookupUsers,
  notFound,
  removeSkillGrant,
  setSkillGrant,
} from '@purple-skills/db';
import {
  ACCESS_LABEL,
  accessAtLeast,
  canCreate,
  canManage,
  isAccessLevel,
  normalizeUsername,
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
 * Clonar é criar: além do nível cobrado no original, o papel tem de poder
 * criar no acervo (`docs/12-acesso-granular.md` decisão 12), porque a cópia é
 * um objeto novo e quem clonou nasce dono dela.
 *
 * É o mesmo `canCreate` — e a mesma mensagem — do `requireCreate`, conferido
 * aqui e não como guarda na frente da rota: a clonagem também exige acesso ao
 * original, e as duas metades da decisão ficam lado a lado, como já acontece
 * com o "só admin deixa sem dono" do `ownerFrom`. A ordem é objeto primeiro:
 * quem não enxerga o original recebe 404, exista ou não papel para criar.
 */
export function assertCanCreate(user: AuthUser): void {
  if (!canCreate(user.role)) throw forbidden('Seu papel não permite criar no acervo');
}

/** O que skill, catálogo e vMCP têm em comum numa ficha. */
type Sheet = {
  access: EffectiveAccess;
  grants: Grant[];
  ownerUserUuid: string | null;
  ownerUsername: string | null;
};

/**
 * A ficha como ela sai do painel.
 *
 * A lista de concessões só vai para quem tem `manage` (decisão 11): quem tem
 * `view` ou `edit` vê o dono e o flag público, não com quem divide. E nenhuma
 * conta sai pelo `uuid` — ver `ownerByUsername`: o dono e as concessões vão pelo
 * username, e o dono dos contêineres aninhados (os catálogos de um vMCP, os
 * vMCPs de um catálogo), que não tem username ao lado e que o painel não lê, não
 * vai.
 */
export function withGrants<T extends Sheet>(object: T): T {
  const grants = canManage(object.access) ? object.grants.map(grantByUsername) : [];
  return withoutNestedOwners(ownerByUsername({ ...object, grants }));
}

/**
 * O dono como ele sai do painel: pelo **username**, pela mesma razão do
 * `withoutUuid` da busca de contas. `ownerUserUuid` ao lado do rótulo da conta,
 * em toda ficha e lista que a sessão vê, entregava o `sub` do cookie de cada
 * dono — e a busca dá o papel pelo mesmo rótulo, então o par que o
 * `withoutUuid` tirou de circulação continuava reconstruível (relatório 011 da
 * auditoria de 2026-09-19). O campo sobrevive como **apelido do username** até
 * sair do tipo compartilhado; nulo continua "sem dono". Vale para toda sessão,
 * admin inclusive — quem precisa do uuid de verdade tem `/api/users`.
 *
 * **Era o e-mail que ocupava este lugar, e é o que mudou** (`docs/19-username.md`
 * decisão 1): o raciocínio acima continua inteiro, só que o rótulo que ele
 * carrega deixou de ser dado pessoal. A **entrada** `ownerUserUuid` do `PATCH`
 * acompanha: username ou uuid, e e-mail recusado (`ownerFrom`).
 */
export const ownerByUsername = <
  T extends { ownerUserUuid: string | null; ownerUsername: string | null },
>(
  object: T,
): T => ({
  ...object,
  ownerUserUuid: object.ownerUserUuid === null ? null : object.ownerUsername,
});

/** A concessão como ela sai: a conta e quem concedeu, pelo username (ver `ownerByUsername`). */
export const grantByUsername = (grant: Grant): Grant => ({
  ...grant,
  userUuid: grant.username,
  grantedByUserUuid: grant.grantedByUserUuid === null ? null : grant.grantedByUsername,
});

/**
 * Tira o `ownerUserUuid` dos itens de `mcps` e `catalogs`. Só dois tipos o
 * carregam ali (`CatalogMcpRef` e `VirtualMcpCatalog`); nos da skill o campo não
 * existe e nada muda. Sai **omitido**, não nulo: nulo diria "sem dono". O tipo
 * compartilhado ainda o declara obrigatório — daí a conversão no fim.
 */
function withoutNestedOwners<T extends object>(object: T): T {
  const out = { ...object } as Record<string, unknown>;
  for (const key of ['mcps', 'catalogs']) {
    const refs = out[key];
    if (!Array.isArray(refs)) continue;
    out[key] = refs.map((ref: Record<string, unknown>) => {
      const { ownerUserUuid: _omit, ...rest } = ref;
      return rest;
    });
  }
  return out as T;
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

/**
 * A conta alvo de uma **concessão ou transferência**, pelo username: tem de
 * existir e estar ativa — dar acesso, ou o objeto, a quem não entra não faz
 * sentido, e o banco recusa os dois (`setGrant`, `transferOwnerTx`). Mudar o
 * **nível** é a mesma chamada de conceder, e por isso também exige conta ativa.
 * Revogar **não** passa por aqui: ver `grantOf`.
 *
 * E-mail é recusado aqui como qualquer outro texto fora do formato
 * (`normalizeUsername` não deixa passar `@`), o que é a decisão 9 do
 * `docs/19-username.md` no ponto em que ela se realiza: aceitá-lo manteria o
 * endereço viajando na URL da rota de concessão.
 */
export async function accountByUsername(
  rawUsername: string,
): Promise<{ uuid: string; username: string }> {
  const username = normalizeUsername(rawUsername);
  if (!username) throw badRequest('Informe o usuário da conta');
  const user = await getUserByUsername(username);
  if (!user || !user.isActive) throw notFound(`Conta não encontrada ou desativada: ${username}`);
  return { uuid: user.uuid, username: user.username };
}

/**
 * A concessão a revogar, procurada pelo username **na lista do próprio
 * objeto** — a que quem tem `manage` já lê —, e não em `users`.
 *
 * Revogar passava por `accountByUsername`, que exige conta ativa: a concessão de
 * quem foi desativado depois de recebê-la não saía por superfície nenhuma,
 * contra a decisão 10 do `docs/12` ("`manage` revoga qualquer concessão"), e
 * voltava a valer, sem ninguém querer, se a conta fosse reativada (relatório
 * 039 da auditoria de 2026-09-19). A linha existe com a conta em qualquer
 * estado, e `remove*Grant` no banco não olha `is_active`.
 *
 * Pela lista, e não por um `accountByUsername` sem a conferência de conta ativa,
 * porque a resposta de quem consulta `users` distinguiria "não existe conta com
 * este usuário" de "existe, e não tem concessão aqui" — inclusive para conta
 * desativada, que a busca de contas não revela (decisão 13). Aqui a pergunta é
 * uma só: a linha está na lista ou não está.
 */
export function grantOf(grants: readonly Grant[], rawUsername: string, where: string): Grant {
  const username = normalizeUsername(rawUsername);
  if (!username) throw badRequest('Informe o usuário da conta');
  const grant = grants.find((item) => item.username.toLowerCase() === username);
  // `where` é o lugar por extenso — "nesta skill", "neste catálogo".
  if (!grant) throw notFound(`A conta não tem concessão ${where}`);
  return grant;
}

/**
 * A conta como ela sai do painel: identificada pelo **username**, sem o `uuid`.
 *
 * O `uuid` é o `sub` do cookie de sessão (`auth.ts`), e o único outro campo do
 * payload é uma versão inteira pequena: entregar `uuid` + papel de toda conta
 * ativa a qualquer sessão é dizer a um membro qual crachá forjar. O username já
 * identifica a conta em todas as rotas de concessão e é público por desenho
 * (`docs/19-username.md` decisão 1), então nada de novo vaza aqui — ao
 * contrário do e-mail, que ocupava este lugar e saiu.
 *
 * `uuid` continua no objeto como apelido do username só enquanto o painel o ler.
 */
export const withoutUuid = (user: UserLookup): UserLookup => ({
  username: user.username,
  name: user.name,
  role: user.role,
  uuid: user.username,
});

/**
 * Busca de contas para compartilhar (decisão 13): qualquer sessão, só contas
 * ativas, e nunca o `uuid` da conta — ver `withoutUuid`. Casa por username e
 * nome; o e-mail saiu também da **entrada** (`docs/19` decisão 10).
 */
export async function lookup(rawQuery: unknown): Promise<UserLookup[]> {
  const q = typeof rawQuery === 'string' ? rawQuery.trim() : '';
  if (q.length < 2) return [];
  return (await lookupUsers(q)).map(withoutUuid);
}

export async function shareSkill(
  user: AuthUser,
  slug: string,
  username: string,
  rawLevel: unknown,
): Promise<Grant> {
  const skill = await loadSkillSummary(user, slug, 'manage');
  const target = await accountByUsername(username);
  return grantByUsername(
    await setSkillGrant(skill.slug, target.uuid, levelFrom(rawLevel), SOURCE, actorOf(user)),
  );
}

/** Revogar vale para a conta em qualquer estado, inclusive desativada — ver `grantOf`. */
export async function unshareSkill(user: AuthUser, slug: string, username: string): Promise<void> {
  const skill = await loadSkillSummary(user, slug, 'manage');
  const grant = grantOf(await listSkillGrants(skill.uuid), username, 'nesta skill');
  await removeSkillGrant(skill.slug, grant.userUuid, SOURCE, actorOf(user));
}

/** UUID canônico, como o banco grava — o que não é username tem de ter esta cara. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const OWNER_FORMAT = 'ownerUserUuid precisa ser o usuário da conta, um UUID ou null';

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
  // novo dono chega pelo **username** — o mesmo identificador das rotas de
  // concessão, e com a conferência de conta ativa que o UUID cru não faz. O UUID
  // continua aceito para quem já integra pela REST.
  //
  // O UUID é testado **primeiro**, e não o username, porque a ordem inversa
  // dependeria de `normalizeUsername` recusar a forma de uuid — ela recusa, e
  // ainda assim a ordem certa é esta: a que não precisa dessa garantia.
  if (UUID.test(target)) return target;
  // E-mail tem recusa própria em vez de cair no formato genérico: quem manda um
  // endereço aqui está integrando contra a API antiga, e "precisa ser o usuário"
  // não diz que o e-mail parou de valer de propósito (`docs/19` decisão 9).
  if (target.includes('@')) {
    throw badRequest(
      'O dono é indicado pelo usuário da conta, não pelo e-mail — o e-mail deixou de ' +
        'identificar contas nesta API',
    );
  }
  return (await accountByUsername(target)).uuid;
}

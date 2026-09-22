import { listSkillAccesses, type ListSkillAccessesOptions } from '@purple-skills/db';
import type { SkillAccessPage } from '@purple-skills/shared';
import { loadSkill } from './access.js';
import { getAccount } from './accounts.js';
import type { AuthUser } from './auth.js';
import { load as loadCatalog } from './catalogs.js';

/**
 * A guia "Acessos" da skill e do catálogo (`docs/13-fichas-e-acessos.md`):
 * os registros por leitura, mais novos primeiro, filtrados por quem leu
 * (`q`: usuário, nome de chave, IP, cliente ou id de sessão), origem e tipo.
 * A lista traz IPs e nomes de chave de servidores que a conta pode não
 * administrar, por isso é `manage` no objeto — o mesmo critério das
 * concessões e das sessões de um vMCP.
 */
type AccessQuery = { q?: unknown; origin?: unknown; kind?: unknown; limit?: unknown; offset?: unknown };

const texto = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

/** Origem e tipo seguem como texto: o banco recusa com 400 o que estiver fora do CHECK. */
function optionsOf(query: AccessQuery) {
  const limit = Number(query.limit ?? 50);
  const offset = Number(query.offset ?? 0);
  return {
    q: texto(query.q),
    origin: texto(query.origin) as ListSkillAccessesOptions['origin'],
    kind: texto(query.kind) as ListSkillAccessesOptions['kind'],
    limit: Number.isFinite(limit) ? limit : 50,
    offset: Number.isFinite(offset) ? offset : 0,
  };
}

/**
 * A página como ela sai para quem administra o objeto: a conta que leu vai pelo
 * **username**. `userUuid` ao lado do rótulo da conta era mais um caminho por
 * onde o `sub` do cookie de sessão de outra conta chegava a quem não é admin
 * (ver `ownerByUsername`, em `access.ts`); o painel não lê o campo, que fica como
 * apelido do username. `ofUser` é rota de admin, que já tem o uuid na URL, e não
 * muda.
 *
 * **Esta guia é o caso mais agudo da mudança** (`docs/19-username.md` §1): ela é
 * de `manage`, não de admin, então o dono de uma skill via aqui o **e-mail de
 * todo mundo que a leu**. Era a maior superfície de vazamento do painel, e é por
 * isso que a migration `033` não se contentou em trocar o campo — ela apagou a
 * coluna `skill_accesses.user_email`, que guardava esses endereços congelados.
 */
const readersByUsername = (page: SkillAccessPage): SkillAccessPage => ({
  ...page,
  items: page.items.map((entry) => ({
    ...entry,
    userUuid: entry.userUuid === null ? null : entry.userUsername,
  })),
});

export async function ofSkill(user: AuthUser, slug: string, query: AccessQuery): Promise<SkillAccessPage> {
  const skill = await loadSkill(user, slug, 'manage');
  return readersByUsername(await listSkillAccesses({ skillUuid: skill.uuid, ...optionsOf(query) }));
}

/** As leituras feitas por uma conta, pelas chaves `psk_` dela (a rota já exige admin). */
export async function ofUser(uuid: string, query: AccessQuery): Promise<SkillAccessPage> {
  const account = await getAccount(uuid);
  return listSkillAccesses({ userUuid: account.uuid, ...optionsOf(query) });
}

export async function ofCatalog(user: AuthUser, slug: string, query: AccessQuery): Promise<SkillAccessPage> {
  const catalog = await loadCatalog(user, slug, 'manage');
  return readersByUsername(await listSkillAccesses({ catalogUuid: catalog.uuid, ...optionsOf(query) }));
}

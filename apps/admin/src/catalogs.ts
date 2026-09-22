import {
  addCatalogSkill,
  badRequest,
  cloneCatalog,
  createCatalog,
  deleteCatalog,
  getCatalog,
  linkCatalog as dbLinkCatalog,
  listCatalogs,
  notFound,
  removeCatalogGrant,
  removeCatalogSkill,
  setCatalogGrant,
  setCatalogSkillActive,
  setCatalogSkills as dbSetCatalogSkills,
  setVirtualMcpCatalogs,
  unlinkCatalog as dbUnlinkCatalog,
  updateCatalog,
} from '@purple-skills/db';
import {
  isAccessScope,
  type AccessLevel,
  type CatalogDetail,
  type CatalogSkillInput,
  type CatalogSummary,
  type Grant,
  type VirtualMcpCatalogInput,
  type VirtualMcpDetail,
} from '@purple-skills/shared';
import {
  accountByUsername,
  assertAccess,
  assertCanCreate,
  assertSkillsViewable,
  grantByUsername,
  grantOf,
  levelFrom,
  ownerByUsername,
  ownerFrom,
  withGrants,
} from './access.js';
import { actorOf, viewerOf, type AuthUser } from './auth.js';
import { assertNameFits, flagsFrom, load as loadMcp, nameFrom, pointFrom } from './mcps.js';

const SOURCE = 'web-admin' as const;

/**
 * Os catálogos que a sessão enxerga (`docs/12-acesso-granular.md` §3.1):
 * tudo para admin; para os demais, os seus, os concedidos e os públicos.
 */
export async function listMine(user: AuthUser, rawScope?: unknown): Promise<CatalogSummary[]> {
  const items = await listCatalogs({
    viewer: viewerOf(user),
    ...(isAccessScope(rawScope) ? { scope: rawScope } : {}),
  });
  // O dono sai pelo username, nunca pelo uuid da conta (`ownerByUsername`).
  return items.map(ownerByUsername);
}

/**
 * Carrega um catálogo com o nível mínimo da ação (`docs/12` §3.2): `view`
 * lê a lista e os membros; `edit` mexe nos membros; `manage` muda nome,
 * slug, descrição, estado, público e concessões; `owner` apaga e transfere.
 */
export async function load(user: AuthUser, slug: string, minimum: AccessLevel | 'owner'): Promise<CatalogDetail> {
  const catalog = await getCatalog(slug, { viewer: viewerOf(user) });
  if (!catalog) throw notFound(`Catálogo não encontrado: ${slug}`);
  assertAccess(catalog.access, minimum, 'catálogo');
  return catalog;
}

/** O detalhe para o painel: as concessões só para quem as administra. */
export async function detail(user: AuthUser, slug: string): Promise<CatalogDetail> {
  return withGrants(await load(user, slug, 'view'));
}

/**
 * O detalhe devolvido por uma escrita, como quem chamou o vê. As escritas do
 * banco releem **sem** `viewer` — a visão do admin —, então `access` é o da
 * leitura prévia, e `mcps` também: nenhuma escrita de catálogo mexe em vínculo
 * com vMCP (isso é feito pelo lado do servidor), e a lista da escrita traria o
 * servidor fechado de terceiros que o `GET` do mesmo catálogo já não mostra
 * (relatório 010 da auditoria de 2026-09-19). `skills` não precisa: quem escreve
 * tem ao menos `edit`, por dono ou concessão, e lê todo membro.
 */
const seenBy = (current: CatalogDetail, updated: CatalogDetail): CatalogDetail =>
  withGrants({ ...updated, access: current.access, mcps: current.mcps });

export async function create(
  user: AuthUser,
  body: { name?: unknown; slug?: unknown; description?: unknown; isPublic?: unknown },
): Promise<CatalogDetail> {
  // Mesmo teto e mesma recusa de tipo do nome de vMCP — ver `mcps.ts`.
  const name = nameFrom(body.name);
  assertNameFits(name, 'do catálogo');

  const created = await createCatalog(
    {
      name,
      slug: typeof body.slug === 'string' && body.slug.trim() ? body.slug.trim() : undefined,
      description: typeof body.description === 'string' ? body.description : undefined,
      isPublic: body.isPublic === true,
      // Quem cria é o dono. A sessão de bootstrap não tem UUID: o catálogo
      // nasce órfão, administrável só por admin.
      ownerUserUuid: user.uuid,
    },
    SOURCE,
    actorOf(user),
  );
  // Quem cria é o dono, e a escrita já devolve `'owner'`: sai como toda ficha.
  return withGrants(created);
}

/**
 * Clona um catálogo (`docs/16-clonagem.md`): a cópia é um objeto novo, de
 * quem clonou, e **nasce fechada** — nunca `is_public`, mesmo que o original
 * seja público. Quem copia decide de novo o que publicar.
 *
 * O corte é `edit`, o mesmo da lista de membros: quem já mexe no conteúdo
 * inteiro pode levá-lo para uma cópia sua, e a cópia não carrega a ACL do
 * original — é isso que separa este caso do vMCP, que exige `manage` (ver
 * `clone`, em `mcps.ts`). O papel vem depois do objeto (`assertCanCreate`),
 * porque a cópia é uma criação.
 *
 * `name` ausente é o nome do original; `slug` ausente desempata sozinho no
 * banco (`-2`, `-3`, …) e nunca dá 409 — o slug **pedido** que já existe é
 * que volta de lá como 409. Copiar os membros e auditar é do banco.
 */
export async function clone(
  user: AuthUser,
  slug: string,
  body: { name?: unknown; slug?: unknown },
): Promise<CatalogDetail> {
  const current = await load(user, slug, 'edit');
  assertCanCreate(user);

  // Mesmo teto e mesma recusa de tipo do nome de vMCP — ver `mcps.ts`.
  const name = nameFrom(body.name);
  if (name) assertNameFits(name, 'do catálogo');
  const wanted = typeof body.slug === 'string' && body.slug.trim() ? body.slug.trim() : undefined;

  const created = await cloneCatalog(
    current.uuid,
    {
      ...(name ? { name } : {}),
      ...(wanted ? { slug: wanted } : {}),
      // Quem clona é o dono. A sessão de bootstrap não tem UUID: a cópia
      // nasce órfã, administrável só por admin.
      ownerUserUuid: user.uuid,
    },
    SOURCE,
    actorOf(user),
  );
  // Quem clona é o dono, e a escrita já devolve `'owner'`: sai como toda ficha.
  return withGrants(created);
}

export async function update(
  user: AuthUser,
  slug: string,
  body: {
    name?: unknown;
    slug?: unknown;
    description?: unknown;
    isActive?: unknown;
    isPublic?: unknown;
    ownerUserUuid?: unknown;
  },
): Promise<CatalogDetail> {
  const current = await load(user, slug, 'manage');

  const patch: Parameters<typeof updateCatalog>[1] = {};
  if (typeof body.name === 'string') {
    patch.name = body.name.trim();
    // Só para quem renomeia: o nome antigo, mesmo acima do teto, volta no Salvar.
    assertNameFits(patch.name, 'do catálogo', current.name);
  }
  if (typeof body.slug === 'string') patch.slug = body.slug.trim();
  if (typeof body.description === 'string') patch.description = body.description;
  if (typeof body.isActive === 'boolean') patch.isActive = body.isActive;
  if (typeof body.isPublic === 'boolean') patch.isPublic = body.isPublic;

  // Transferir é do dono e do admin (decisão 9 do `12`); o banco recusa conta inativa.
  const owner = await ownerFrom(user, current.access, body.ownerUserUuid, 'catálogo');
  if (owner !== undefined) patch.ownerUserUuid = owner;

  return seenBy(current, await updateCatalog(current.uuid, patch, SOURCE, actorOf(user)));
}

export async function remove(user: AuthUser, slug: string): Promise<void> {
  const current = await load(user, slug, 'owner');
  await deleteCatalog(current.uuid, SOURCE, actorOf(user));
}

// ------------------------------------------------------------------ skills ---

/** A lista é o estado desejado; `isActive` omitido é "ativa" para quem entra e "não mexe" para quem fica. */
export async function setSkills(user: AuthUser, slug: string, body: { skills?: unknown }): Promise<CatalogDetail> {
  const current = await load(user, slug, 'edit');

  if (!Array.isArray(body.skills)) throw badRequest('Envie "skills" como uma lista');
  const skills: CatalogSkillInput[] = body.skills.map((entry: unknown, index: number) => {
    const item = (entry ?? {}) as Record<string, unknown>;
    if (typeof item.slug !== 'string' || !item.slug.trim()) {
      throw badRequest(`skills[${index}]: informe o slug da skill`);
    }
    if (item.isActive !== undefined && typeof item.isActive !== 'boolean') {
      throw badRequest(`skills[${index}] (${item.slug}): "isActive" precisa ser true ou false`);
    }
    return { slug: item.slug.trim(), ...(typeof item.isActive === 'boolean' ? { isActive: item.isActive } : {}) };
  });

  // Quem entra precisa ser visível para a sessão (decisão 6 do `12`).
  const members = new Set(current.skills.map((skill) => skill.slug));
  await assertSkillsViewable(user, skills.map((skill) => skill.slug).filter((s) => !members.has(s)));

  return seenBy(current, await dbSetCatalogSkills(current.uuid, skills, SOURCE, actorOf(user)));
}

/**
 * `PUT …/skills/:skill`: sem corpo adiciona (participação ativa, e não mexe
 * numa que já é membro); com `{ isActive }` liga ou desliga a participação
 * de um membro — desativar não remove (`docs/11` decisão 8).
 */
export async function putSkill(user: AuthUser, slug: string, skillSlug: string, body: unknown): Promise<CatalogDetail> {
  const current = await load(user, slug, 'edit');
  const isActive = (body as { isActive?: unknown } | null)?.isActive;
  if (isActive === undefined) {
    if (!current.skills.some((skill) => skill.slug === skillSlug)) await assertSkillsViewable(user, [skillSlug]);
    return seenBy(current, await addCatalogSkill(current.uuid, skillSlug, SOURCE, actorOf(user)));
  }
  if (typeof isActive !== 'boolean') throw badRequest('"isActive" precisa ser true ou false');
  return seenBy(current, await setCatalogSkillActive(current.uuid, skillSlug, isActive, SOURCE, actorOf(user)));
}

export async function removeSkill(user: AuthUser, slug: string, skillSlug: string): Promise<CatalogDetail> {
  const current = await load(user, slug, 'edit');
  return seenBy(current, await removeCatalogSkill(current.uuid, skillSlug, SOURCE, actorOf(user)));
}

// -------------------------------------------------------------- concessões ---

export async function share(user: AuthUser, slug: string, username: string, rawLevel: unknown): Promise<Grant> {
  const current = await load(user, slug, 'manage');
  const target = await accountByUsername(username);
  return grantByUsername(await setCatalogGrant(current.slug, target.uuid, levelFrom(rawLevel), SOURCE, actorOf(user)));
}

/** Revogar vale para a conta em qualquer estado, inclusive desativada — ver `grantOf`, em `access.ts`. */
export async function unshare(user: AuthUser, slug: string, username: string): Promise<void> {
  const current = await load(user, slug, 'manage');
  const grant = grantOf(current.grants, username, 'neste catálogo');
  await removeCatalogGrant(current.slug, grant.userUuid, SOURCE, actorOf(user));
}

// --------------------------------------------------------- no vMCP -----------

/**
 * O vínculo catálogo↔vMCP exige `edit` no servidor e `view` no catálogo
 * (`docs/12` decisão 7, que revoga a 7 do `11`): quem edita o servidor
 * escolhe o que ele entrega, e quem concedeu `view` num catálogo aceitou que
 * ele seja entregue por servidores alheios.
 */
export async function linkToMcp(user: AuthUser, mcpSlug: string, catalogSlug: string, body: unknown): Promise<VirtualMcpDetail> {
  const mcp = await loadMcp(user, mcpSlug, 'edit');
  const catalog = await load(user, catalogSlug, 'view');
  // A posição vem do canvas: o nó nasce onde foi solto. Ausente, fica onde estava.
  const position = pointFrom((body as { position?: unknown } | null)?.position, 'position');
  const linked = await dbLinkCatalog(mcp.uuid, catalog.uuid, flagsFrom(body), SOURCE, actorOf(user), position ? { position } : undefined);
  return withGrants({ ...linked, access: mcp.access });
}

/** Desvincular é mexer só no servidor: `edit` nele, nada no catálogo. */
export async function unlinkFromMcp(user: AuthUser, mcpSlug: string, catalogSlug: string): Promise<VirtualMcpDetail> {
  const mcp = await loadMcp(user, mcpSlug, 'edit');
  const catalog = mcp.catalogs.find((item) => item.slug === catalogSlug);
  if (!catalog) throw notFound(`O catálogo "${catalogSlug}" não está vinculado a este MCP virtual`);
  const unlinked = await dbUnlinkCatalog(mcp.uuid, catalog.uuid, SOURCE, actorOf(user));
  return withGrants({ ...unlinked, access: mcp.access });
}

/**
 * Declarativa, pelo lado do vMCP: `edit` no servidor, e `view` em cada
 * catálogo que **entra**. Quem sai não exige nada do catálogo — tirar um
 * catálogo da lista é mexer só no servidor.
 */
export async function setMcpCatalogs(user: AuthUser, mcpSlug: string, body: { catalogs?: unknown }): Promise<VirtualMcpDetail> {
  const mcp = await loadMcp(user, mcpSlug, 'edit');

  if (!Array.isArray(body.catalogs)) throw badRequest('Envie "catalogs" como uma lista');
  const wanted: VirtualMcpCatalogInput[] = body.catalogs.map((entry: unknown, index: number) => {
    const item = (entry ?? {}) as Record<string, unknown>;
    if (typeof item.slug !== 'string' || !item.slug.trim()) {
      throw badRequest(`catalogs[${index}]: informe o slug do catálogo`);
    }
    return { slug: item.slug.trim(), ...flagsFrom(item) };
  });

  const linked = new Set(mcp.catalogs.map((item) => item.slug));
  for (const item of wanted) {
    if (!linked.has(item.slug)) await load(user, item.slug, 'view');
  }

  const updated = await setVirtualMcpCatalogs(mcp.uuid, wanted, SOURCE, actorOf(user));
  return withGrants({ ...updated, access: mcp.access });
}

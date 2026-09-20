import {
  badRequest,
  countOnlineMcpSessions,
  createVirtualMcp,
  createVirtualMcpKey,
  deleteVirtualMcp,
  getSkillDetail,
  getVirtualMcp,
  linkSkill as dbLinkSkill,
  listMcpSessions,
  listVirtualMcpKeys,
  listVirtualMcpKeysByCreator,
  listVirtualMcps,
  notFound,
  recordAccountAudit,
  removeVirtualMcpGrant,
  resolveDefaultVirtualMcp,
  revokeVirtualMcpKey,
  setVirtualMcpGrant,
  setDefaultVirtualMcp,
  setVirtualMcpCanvas,
  setVirtualMcpSkills,
  unlinkSkill as dbUnlinkSkill,
  updateVirtualMcp,
  type DefaultMcpResolution,
  type SkillLinkFlags,
  type VirtualMcpKeyWithMcp,
} from '@purple-skills/db';
import {
  VIRTUAL_KEY_SCHEME,
  canManage,
  generateApiKey,
  isAccessScope,
  type AccessLevel,
  type CanvasPoint,
  type Grant,
  type InstallationSettings,
  type McpSessionPage,
  type McpSessionTransport,
  type SkillDetail,
  type SkillLinkInput,
  type VirtualMcpDetail,
  type VirtualMcpKeySummary,
  type VirtualMcpLayout,
  type VirtualMcpSkillInput,
  type VirtualMcpSummary,
} from '@purple-skills/shared';
import {
  accountByEmail,
  assertAccess,
  assertSkillsViewable,
  forbidden,
  grantByEmail,
  grantOf,
  levelFrom,
  ownerByEmail,
  ownerFrom,
  withGrants,
} from './access.js';
import { actorOf, viewerOf, type AuthUser } from './auth.js';
import { config } from './config.js';

const SOURCE = 'web-admin' as const;

/** A janela de "online" do painel, em toda leitura de vMCP e de sessão. */
const janela = () => ({ onlineWindowMs: config.onlineWindowMs });

/**
 * Os MCPs que a sessão enxerga (`docs/12-acesso-granular.md` §3.1): tudo
 * para admin; para os demais, os seus, os concedidos e os abertos. `scope`
 * é o filtro das listas do painel (meus / compartilhados / públicos).
 */
export async function listMine(user: AuthUser, rawScope?: unknown): Promise<VirtualMcpSummary[]> {
  const items = await listVirtualMcps({
    viewer: viewerOf(user),
    ...(isAccessScope(rawScope) ? { scope: rawScope } : {}),
    ...janela(),
  });
  // O dono sai pelo e-mail, nunca pelo uuid da conta (`ownerByEmail`).
  return items.map(ownerByEmail);
}

/**
 * Carrega um MCP virtual com o nível mínimo exigido pela ação
 * (`docs/12-acesso-granular.md` §3.2): `view` lê o canvas e as skills
 * dentro; `edit` mexe nos vínculos, portas e posições; `manage` muda nome,
 * slug, estado, abertura, chaves e concessões; `owner` apaga e transfere.
 * Quem não o vê recebe 404, como se não existisse.
 */
export async function load(
  user: AuthUser,
  slug: string,
  minimum: AccessLevel | 'owner',
): Promise<VirtualMcpDetail> {
  const mcp = await getVirtualMcp(slug, { ...janela(), viewer: viewerOf(user) });
  if (!mcp) throw notFound(`MCP virtual não encontrado: ${slug}`);
  assertAccess(mcp.access, minimum, 'MCP virtual');
  return mcp;
}

/** O detalhe para o painel: as concessões só para quem as administra. */
export async function detail(user: AuthUser, slug: string): Promise<VirtualMcpDetail> {
  return withGrants(await load(user, slug, 'view'));
}

/**
 * Teto do nome de vMCP, de catálogo e de chave `psv_`, em caracteres.
 *
 * Nome não tinha teto nenhum — o único freio era o limite do corpo da
 * requisição, de dezenas de megabytes —, e estes três são copiados por extenso
 * em **cada** linha de `skill_accesses`, que nunca é podada (relatório 042 da
 * auditoria de 2026-09-19). O banco corta a **cópia** em 512; este teto é o que
 * impede o nome gigante de existir. 200 é folgado de propósito: o dobro do teto
 * de slug (96) e duas vezes e meia o da chave `psk_` (`accounts.ts`).
 *
 * É um número, não um contrato: quem precisar de outro muda aqui e no gêmeo do
 * mcp-admin (`apps/mcp-admin/src/mcps.ts`), mantendo-o abaixo dos 512 do corte.
 */
export const NAME_MAX = 200;

/**
 * O nome que chega no corpo: aparado, e 400 quando não é texto.
 * `String(valor ?? '')` num objeto cujo `toString` não é função lança
 * `TypeError` — 500 e uma linha de "erro inesperado" no log por um corpo que é
 * erro de quem chamou (achado do relatório 007 da mesma auditoria). Ausente é
 * vazio: "dê um nome" continua sendo de quem valida o vazio.
 */
export function nameFrom(raw: unknown): string {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') throw badRequest('O campo "name" deve ser uma string');
  return raw.trim();
}

/**
 * Recusa o nome acima do teto. Vale para quem **cria ou renomeia**: nome antigo
 * mais longo continua válido até alguém mexer nele — o Salvar do painel reenvia
 * o nome, e um teto retroativo travaria a edição de um objeto por causa do nome
 * que ele já tem. Por isso quem edita passa o nome atual em `unchanged`.
 */
export function assertNameFits(name: string, what: string, unchanged?: string): void {
  if (name === unchanged?.trim() || name.length <= NAME_MAX) return;
  throw badRequest(`O nome ${what} é longo demais: ${name.length} caracteres (o limite é ${NAME_MAX})`);
}

export async function create(
  user: AuthUser,
  body: { name?: unknown; slug?: unknown; description?: unknown; isOpen?: unknown },
): Promise<VirtualMcpDetail> {
  const name = nameFrom(body.name);
  assertNameFits(name, 'do MCP virtual');

  const created = await createVirtualMcp(
    {
      name,
      slug: typeof body.slug === 'string' && body.slug.trim() ? body.slug.trim() : undefined,
      description: typeof body.description === 'string' ? body.description : undefined,
      // Nasce vazio, então abrir aqui ainda não expõe nada. Quando a primeira
      // skill entrar não há confirmação a pedir: ela saiu no PR2 do `09`
      // (decisão 9 e `§4.4`), e o que informa é o aviso inline do painel
      // (`docs/12-acesso-granular.md`, decisão 15).
      isOpen: body.isOpen === true,
      // Quem cria é o dono. A sessão de bootstrap não tem UUID: o MCP nasce
      // órfão, administrável só por admin.
      ownerUserUuid: user.uuid,
    },
    SOURCE,
    actorOf(user),
  );
  // Quem cria é o dono, e a escrita já devolve `'owner'`: sai como toda ficha.
  return withGrants(created);
}

export async function update(
  user: AuthUser,
  slug: string,
  body: {
    name?: unknown;
    slug?: unknown;
    description?: unknown;
    isOpen?: unknown;
    isActive?: unknown;
    ownerUserUuid?: unknown;
  },
): Promise<VirtualMcpDetail> {
  // Nome, slug, descrição, aberto e ligado são propriedades: `manage`.
  const current = await load(user, slug, 'manage');

  const patch: Parameters<typeof updateVirtualMcp>[1] = {};
  if (typeof body.name === 'string') {
    patch.name = body.name.trim();
    assertNameFits(patch.name, 'do MCP virtual', current.name);
  }
  if (typeof body.slug === 'string') patch.slug = body.slug.trim();
  if (typeof body.description === 'string') patch.description = body.description;
  if (typeof body.isOpen === 'boolean') patch.isOpen = body.isOpen;
  if (typeof body.isActive === 'boolean') patch.isActive = body.isActive;

  // Transferir é do dono e do admin (decisão 9); o banco recusa conta inativa.
  const owner = await ownerFrom(user, current.access, body.ownerUserUuid, 'MCP virtual');
  if (owner !== undefined) patch.ownerUserUuid = owner;

  return withGrants({
    ...(await updateVirtualMcp(current.uuid, patch, SOURCE, actorOf(user))),
    access: current.access,
  });
}

export async function remove(user: AuthUser, slug: string): Promise<void> {
  const current = await load(user, slug, 'owner');
  await deleteVirtualMcp(current.uuid, SOURCE, actorOf(user));
}

/**
 * A lista de skills é o estado desejado, com as três superfícies decididas
 * por linha — a escolha é obrigatória, então uma flag ausente é erro, não
 * `false` (`08`, decisão 3).
 */
export async function setSkills(
  user: AuthUser,
  slug: string,
  body: { skills?: unknown },
): Promise<VirtualMcpDetail> {
  const current = await load(user, slug, 'edit');

  if (!Array.isArray(body.skills)) throw badRequest('Envie "skills" como uma lista');
  const skills: VirtualMcpSkillInput[] = body.skills.map((entry: unknown, index: number) => {
    const item = (entry ?? {}) as Record<string, unknown>;
    if (typeof item.slug !== 'string' || !item.slug.trim()) {
      throw badRequest(`skills[${index}]: informe o slug da skill`);
    }
    for (const flag of ['asSkill', 'asPrompt', 'asResource'] as const) {
      if (typeof item[flag] !== 'boolean') {
        throw badRequest(`skills[${index}] (${item.slug}): "${flag}" precisa ser true ou false`);
      }
    }
    return {
      slug: item.slug.trim(),
      asSkill: item.asSkill as boolean,
      asPrompt: item.asPrompt as boolean,
      asResource: item.asResource as boolean,
    };
  });

  // Quem entra precisa ser visível para a sessão (decisão 6); quem já está
  // fica, mesmo que a sessão tenha perdido o acesso à skill depois.
  const linked = new Set(current.skills.map((skill) => skill.slug));
  await assertSkillsViewable(
    user,
    skills.map((skill) => skill.slug).filter((slug) => !linked.has(slug)),
  );

  return withGrants({
    ...(await setVirtualMcpSkills(current.uuid, skills, SOURCE, actorOf(user))),
    access: current.access,
  });
}

// ------------------------------------------- vínculo pelo lado da skill ---

/** As três portas do vínculo, obrigatórias e ao menos uma ligada. */
export function flagsFrom(body: unknown): SkillLinkFlags {
  const item = (body ?? {}) as Record<string, unknown>;
  for (const flag of ['asSkill', 'asPrompt', 'asResource'] as const) {
    if (typeof item[flag] !== 'boolean') throw badRequest(`"${flag}" precisa ser true ou false`);
  }
  const flags = {
    asSkill: item.asSkill as boolean,
    asPrompt: item.asPrompt as boolean,
    asResource: item.asResource as boolean,
  };
  if (!flags.asSkill && !flags.asPrompt && !flags.asResource) {
    throw badRequest('Escolha ao menos uma superfície: asSkill, asPrompt ou asResource');
  }
  return flags;
}

/**
 * A ficha da skill como **quem chamou** a vê, depois de uma escrita de vínculo.
 *
 * `linkSkill` e `unlinkSkill` do banco releem na visão do admin: `access:
 * 'owner'`, a ACL inteira e todo contêiner, inclusive o servidor fechado e o
 * catálogo privado de terceiros. A ação exige só `edit` em **algum** vMCP e
 * `view` na skill, então repassar aquilo entregava a quem só lê o que o `GET`
 * da mesma skill esconde (relatório 009 da auditoria de 2026-09-19; `docs/12`
 * decisão 11). Nulo quando a skill saiu do alcance da sessão — o que desfazer
 * um vínculo pode causar, e não é erro.
 */
async function skillSeenBy(user: AuthUser, slug: string): Promise<SkillDetail | null> {
  const seen = await getSkillDetail(slug, { viewer: viewerOf(user) });
  return seen ? withGrants(seen) : null;
}

/**
 * Publica a skill num vMCP a partir da página dela
 * (`docs/09-mcp-padrao-e-skills-flutuantes.md` §4.3): `edit` no vMCP alvo e
 * `view` na skill, como no `PUT …/skills` do MCP (decisão 6 do `12`).
 */
export async function linkSkill(
  user: AuthUser,
  mcpSlug: string,
  skillSlug: string,
  body: unknown,
): Promise<SkillDetail | null> {
  const mcp = await load(user, mcpSlug, 'edit');
  await assertSkillsViewable(user, [skillSlug]);
  // A posição vem do canvas: o nó nasce onde foi solto. Ausente, fica onde estava.
  const position = pointFrom((body as { position?: unknown } | null)?.position, 'position');
  const linked = await dbLinkSkill(skillSlug, mcp.uuid, flagsFrom(body), SOURCE, actorOf(user), position ? { position } : undefined);
  // Visível ela continua — o vínculo só soma um caminho, e a sessão vê o vMCP.
  // Nulo aqui é só a skill renomeada ou apagada entre a escrita e a releitura.
  return skillSeenBy(user, linked.slug);
}

/** Um ponto do canvas: `{ x, y }` finitos, arredondados para inteiro. Ausente é `undefined`. */
export function pointFrom(raw: unknown, field: string): CanvasPoint | undefined {
  if (raw === undefined || raw === null) return undefined;
  const point = raw as { x?: unknown; y?: unknown };
  if (typeof point.x !== 'number' || typeof point.y !== 'number' || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw badRequest(`"${field}" precisa ser um ponto { x, y } numérico`);
  }
  return { x: Math.round(point.x), y: Math.round(point.y) };
}

// ------------------------------------------------------------------ canvas ---

/** Uma lista de `{ slug, x, y }` do corpo, ou nada. */
function positionsFrom(raw: unknown, field: string, what: string): { slug: string; x: number; y: number }[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw badRequest(`"${field}" precisa ser uma lista`);
  return raw.map((entry: unknown, index: number) => {
    const item = (entry ?? {}) as { slug?: unknown; x?: unknown; y?: unknown };
    if (typeof item.slug !== 'string' || !item.slug.trim()) {
      throw badRequest(`${field}[${index}]: informe o slug ${what}`);
    }
    const point = pointFrom({ x: item.x, y: item.y }, `${field}[${index}]`)!;
    return { slug: item.slug.trim(), ...point };
  });
}

/**
 * O estado do canvas de um vMCP (`docs/10-admin-canvas-e-sessoes.md`): as
 * posições dos nós fixos (servidor, Internet), das skills e dos catálogos. É
 * estado de tela, compartilhado entre quem administra o servidor — sem
 * auditoria.
 */
export async function setCanvas(
  user: AuthUser,
  slug: string,
  body: { layout?: unknown; positions?: unknown; catalogPositions?: unknown },
): Promise<void> {
  const current = await load(user, slug, 'edit');

  let layout: VirtualMcpLayout | undefined;
  if (body.layout !== undefined && body.layout !== null) {
    if (typeof body.layout !== 'object') throw badRequest('"layout" precisa ser um objeto');
    const raw = body.layout as { server?: unknown; internet?: unknown };
    layout = {};
    const server = pointFrom(raw.server, 'layout.server');
    const internet = pointFrom(raw.internet, 'layout.internet');
    if (server) layout.server = server;
    if (internet) layout.internet = internet;
  }

  await setVirtualMcpCanvas(current.uuid, {
    layout,
    positions: positionsFrom(body.positions, 'positions', 'da skill'),
    catalogPositions: positionsFrom(body.catalogPositions, 'catalogPositions', 'do catálogo'),
  });
}

// ----------------------------------------------------------------- sessões ---

type SessionQuery = { online?: unknown; limit?: unknown; offset?: unknown };

function pageOf(query: SessionQuery) {
  const limit = Number(query.limit ?? 50);
  const offset = Number(query.offset ?? 0);
  return {
    onlineOnly: query.online === '1' || query.online === 'true',
    limit: Number.isFinite(limit) ? limit : 50,
    offset: Number.isFinite(offset) ? offset : 0,
  };
}

/** Clientes online agora num vMCP, por transporte — o contador do globo. */
export async function online(
  user: AuthUser,
  slug: string,
): Promise<{ total: number; byTransport: Record<McpSessionTransport, number> }> {
  const current = await load(user, slug, 'view');
  return countOnlineMcpSessions({ ...janela(), virtualMcpUuid: current.uuid });
}

/** As sessões de um vMCP: IPs e nomes de chave são operação, como as chaves — `manage`. */
export async function sessionsOf(user: AuthUser, slug: string, query: SessionQuery): Promise<McpSessionPage> {
  const current = await load(user, slug, 'manage');
  return listMcpSessions({ ...janela(), virtualMcpUuid: current.uuid, ...pageOf(query) });
}

/**
 * A lista global de sessões: admin vê todas (inclusive de vMCPs já apagados);
 * os demais só as dos vMCPs que administram. `mcp` filtra por slug.
 */
export async function listSessions(
  user: AuthUser,
  query: SessionQuery & { mcp?: unknown },
): Promise<McpSessionPage> {
  const wanted = typeof query.mcp === 'string' && query.mcp.trim() ? query.mcp.trim() : null;

  if (user.role === 'admin') {
    if (!wanted) return listMcpSessions({ ...janela(), ...pageOf(query) });
    const mcp = await getVirtualMcp(wanted);
    if (!mcp) throw notFound(`MCP virtual não encontrado: ${wanted}`);
    return listMcpSessions({ ...janela(), virtualMcpUuid: mcp.uuid, ...pageOf(query) });
  }

  const mine = (await listVirtualMcps({ viewer: viewerOf(user) })).filter((mcp) => canManage(mcp.access));
  if (wanted) {
    const one = mine.find((mcp) => mcp.slug === wanted);
    if (!one) throw forbidden('Você não administra este MCP virtual');
    return listMcpSessions({ ...janela(), virtualMcpUuid: one.uuid, ...pageOf(query) });
  }
  return listMcpSessions({ ...janela(), virtualMcpUuids: mine.map((mcp) => mcp.uuid), ...pageOf(query) });
}

/**
 * Desfaz o vínculo direto: `edit` no vMCP, nada na skill — tirar uma skill da
 * lista é mexer só no servidor, como `catalogs.unlinkFromMcp`.
 */
export async function unlinkSkill(
  user: AuthUser,
  mcpSlug: string,
  skillSlug: string,
): Promise<SkillDetail | null> {
  const mcp = await load(user, mcpSlug, 'edit');
  // Uma resposta só para "não existe" e "não está aqui". O banco distingue as
  // duas — `Skill não encontrada` e `não está vinculada`, ambas 404 —, e a
  // diferença diria a quem edita um servidor qualquer quais slugs de skill
  // privada alheia existem. `mcp.skills` são os vínculos diretos, inclusive de
  // skill desligada ou que a sessão não vê: exatamente o que o banco apagaria.
  if (!mcp.skills.some((skill) => skill.slug === skillSlug)) {
    throw notFound(`A skill "${skillSlug}" não está vinculada a este MCP virtual`);
  }
  const unlinked = await dbUnlinkSkill(skillSlug, mcp.uuid, SOURCE, actorOf(user));
  return skillSeenBy(user, unlinked.slug);
}

/**
 * A lista "publicar em" de uma skill nova: slugs de vMCP e flags, vindos do
 * formulário ou do import, resolvidos em uuids. Cada vMCP exige `edit`:
 * quem não o edita não publica nele, e a skill não é criada.
 */
export async function resolveLinks(user: AuthUser, raw: unknown): Promise<SkillLinkInput[]> {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw badRequest('Envie "mcps" como uma lista');

  const links: SkillLinkInput[] = [];
  for (const [index, entry] of raw.entries()) {
    const item = (entry ?? {}) as Record<string, unknown>;
    if (typeof item.slug !== 'string' || !item.slug.trim()) {
      throw badRequest(`mcps[${index}]: informe o slug do MCP virtual`);
    }
    const mcp = await load(user, item.slug.trim(), 'edit');
    links.push({ virtualMcpUuid: mcp.uuid, ...flagsFrom(item) });
  }
  return links;
}

// ------------------------------------------------------------------ chaves ---

/**
 * As chaves do servidor, para quem o administra. `createdByUserUuid` só sai
 * quando a chave é de quem está lendo: é uuid de conta, sem e-mail ao lado para
 * virar apelido, e o painel não mostra quem emitiu (ver `ownerByEmail`, em
 * `access.ts`). De outra conta ele sai nulo, como o de quem não é conta.
 */
export async function listKeys(user: AuthUser, slug: string): Promise<VirtualMcpKeySummary[]> {
  const current = await load(user, slug, 'manage');
  const keys = await listVirtualMcpKeys(current.uuid);
  return keys.map((key) => ({
    ...key,
    createdByUserUuid: user.uuid !== null && key.createdByUserUuid === user.uuid ? key.createdByUserUuid : null,
  }));
}

/**
 * As chaves `psv_` que a conta emitiu (Meu espaço → Chaves emitidas), só dos
 * servidores que ela ainda enxerga: perdido o acesso, nem o nome aparece.
 */
export async function listIssuedKeys(user: AuthUser): Promise<VirtualMcpKeyWithMcp[]> {
  // A sessão de bootstrap não tem conta: não emitiu nada.
  if (!user.uuid) return [];
  const [keys, visible] = await Promise.all([listVirtualMcpKeysByCreator(user.uuid), listMine(user)]);
  const uuids = new Set(visible.map((mcp) => mcp.uuid));
  return keys.filter((key) => uuids.has(key.virtualMcpUuid));
}

/**
 * O rótulo de uma chave na trilha: `<slug>: <nome> (<prefixo>)`, o mesmo na
 * emissão e na revogação, para as duas linhas se casarem na leitura. O prefixo
 * desempata chaves de mesmo nome e já é público — o segredo é o que vem depois.
 */
const keyLabel = (slug: string, key: { name: string; prefix: string }): string =>
  `${slug}: ${key.name} (${key.prefix})`;

/** Emite uma chave `psv_`. O texto completo só existe na resposta desta chamada. */
export async function issueKey(
  user: AuthUser,
  slug: string,
  rawName: unknown,
): Promise<{ key: VirtualMcpKeySummary; token: string }> {
  // Emitir uma chave entrega a árvore inteira a uma máquina: é ampliar
  // acesso, o mesmo que conceder — `manage` (`docs/12` §3.2).
  const current = await load(user, slug, 'manage');

  const name = nameFrom(rawName);
  if (!name) throw badRequest('Dê um nome à chave (ex.: "CI do projeto X")');
  assertNameFits(name, 'da chave');

  const generated = generateApiKey(VIRTUAL_KEY_SCHEME);
  const key = await createVirtualMcpKey({
    virtualMcpUuid: current.uuid,
    name,
    prefix: generated.prefix,
    keyHash: generated.keyHash,
    createdByUserUuid: user.uuid,
  });

  await recordAccountAudit({
    action: 'mcp.key.create',
    source: SOURCE,
    actor: actorOf(user),
    targetLabel: keyLabel(current.slug, { name, prefix: generated.prefix }),
  });

  return { key, token: generated.token };
}

export async function revokeKey(user: AuthUser, slug: string, id: string): Promise<void> {
  const current = await load(user, slug, 'manage');

  const revoked = await revokeVirtualMcpKey(id, current.uuid);
  if (!revoked) throw notFound('Chave não encontrada ou já revogada');

  // Pelo nome que a revogação devolve, e não pelo uuid da chave — que não
  // aparece em tela nenhuma e some com o vMCP (`ON DELETE CASCADE`), deixando a
  // linha sem referente (relatório 040 da auditoria de 2026-09-19).
  await recordAccountAudit({
    action: 'mcp.key.revoke',
    source: SOURCE,
    actor: actorOf(user),
    targetLabel: keyLabel(current.slug, revoked),
  });
}

// -------------------------------------------------------------- concessões ---

export async function share(user: AuthUser, slug: string, email: string, rawLevel: unknown): Promise<Grant> {
  const current = await load(user, slug, 'manage');
  const target = await accountByEmail(email);
  return grantByEmail(await setVirtualMcpGrant(current.slug, target.uuid, levelFrom(rawLevel), SOURCE, actorOf(user)));
}

/** Revogar vale para a conta em qualquer estado, inclusive desativada — ver `grantOf`, em `access.ts`. */
export async function unshare(user: AuthUser, slug: string, email: string): Promise<void> {
  const current = await load(user, slug, 'manage');
  const grant = grantOf(current.grants, email, 'neste MCP virtual');
  await removeVirtualMcpGrant(current.slug, grant.userUuid, SOURCE, actorOf(user));
}

// ---------------------------------------------------- configuração ---

/**
 * A configuração da instalação (`docs/09-mcp-padrao-e-skills-flutuantes.md`):
 * qual vMCP responde em `/mcp`, ou por que nenhum. Só admin lê e altera —
 * a checagem é da rota.
 */
function settingsView(resolved: DefaultMcpResolution): InstallationSettings {
  if (resolved.status === 'ok') {
    return {
      defaultMcp: {
        status: 'ok',
        uuid: resolved.mcp.uuid,
        slug: resolved.mcp.slug,
        name: resolved.mcp.name,
        isOpen: resolved.mcp.isOpen,
      },
    };
  }
  if (resolved.status === 'inactive') {
    return {
      defaultMcp: { status: 'inactive', uuid: resolved.uuid, slug: resolved.slug, name: null, isOpen: null },
    };
  }
  return { defaultMcp: { status: resolved.status, uuid: null, slug: null, name: null, isOpen: null } };
}

export async function getSettings(): Promise<InstallationSettings> {
  return settingsView(await resolveDefaultVirtualMcp());
}

/**
 * Escolhe o vMCP padrão pelo uuid, ou limpa com `null`. Nenhuma outra guarda:
 * o padrão não tem tratamento especial, e um vMCP desligado ou fechado pode
 * ser escolhido — a raiz responde 404 ou exige chave conforme ele estiver.
 */
export async function setDefaultMcp(user: AuthUser, rawUuid: unknown): Promise<InstallationSettings> {
  if (rawUuid !== null && typeof rawUuid !== 'string') {
    throw badRequest('uuid precisa ser o uuid de um MCP virtual, ou null para nenhum');
  }
  const uuid = rawUuid === null ? null : rawUuid.trim() || null;
  return settingsView(await setDefaultVirtualMcp(uuid, SOURCE, actorOf(user)));
}

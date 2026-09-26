import type { Response } from 'express';
import {
  badRequest,
  getQuarantine,
  getQuarantineApprovers,
  listQuarantine,
  notFound,
  setQuarantineTargets,
  type FileContent,
  type SkillLinkFlags,
} from '@purple-skills/db';
import {
  DEFAULT_MAX_ZIP_ENTRIES,
  QUARANTINE_APPROVERS_LABEL,
  canEdit,
  canPromoteQuarantine,
  canViewQuarantine,
  slugify,
  writeZip,
  type EffectiveAccess,
  type QuarantineDetail,
  type QuarantineMcpTarget,
  type QuarantinePage,
  type QuarantineSheet,
  type QuarantineTargetsInput,
  type SkillLinkInput,
} from '@purple-skills/shared';
import { forbidden, ownerByUsername } from './access.js';
import { actorOf, type AuthUser } from './auth.js';
import * as catalogs from './catalogs.js';
import * as mcps from './mcps.js';

const SOURCE = 'web-admin' as const;

/**
 * A quarentena, do lado do app (`docs/15-quarentena.md`).
 *
 * Aqui não há concessão por objeto: o espaço é simples de propósito. Quem
 * enxerga um envio é o dono dele, o admin e o editor (`canViewQuarantine`), e
 * quem enxerga também edita e descarta. Só **promover** é diferente: passa pela
 * política da instalação (`quarantine.approvers`).
 */

/**
 * O envio, se a sessão o enxerga. Quem não enxerga recebe **404**, como no
 * resto do painel: a existência de um envio alheio não se confirma por 403.
 */
export async function load(user: AuthUser, uuid: string): Promise<QuarantineDetail> {
  const found = await getQuarantine(uuid);
  if (!found || !canViewQuarantine(user.role, found.ownerUserUuid, user.uuid)) {
    throw notFound('Envio não encontrado na quarentena');
  }
  return found;
}

/**
 * A fila que a sessão enxerga. Admin e editor veem tudo; qualquer outro papel
 * vê o que **submeteu** — é o caso da conta que perdeu o papel de editor depois
 * de enviar, e por isso o recorte não repete `requireCreate`.
 *
 * A sessão sem conta (bootstrap, `MCP_ADMIN_TOKEN`) é sempre admin e cai na
 * primeira linha; se um dia deixar de ser, a fila dela fica vazia em vez de
 * virar a de outra pessoa.
 */
export async function list(
  user: AuthUser,
  options: { limit: number; offset: number; search?: string | null },
): Promise<QuarantinePage> {
  const page = { ...options, search: options.search ?? undefined };
  if (user.role === 'admin' || user.role === 'editor') return listQuarantine(page);
  // `ownerUserUuid: null` é "nenhum dono possível" e devolve lista vazia, pelo
  // contrato de `listQuarantine` — não os órfãos, que são só do admin. É o que
  // sobra para uma sessão sem conta que não fosse admin.
  return listQuarantine({ ...page, ownerUserUuid: user.uuid });
}

/**
 * Teto de arquivos por envio.
 *
 * É o mesmo do pacote (`DEFAULT_MAX_ZIP_ENTRIES`), e de propósito: um envio é o
 * retrato de um `.zip`, então o que não cabe num não deve caber no outro. Sem
 * ele, a criação de arquivo um a um não tinha limite nenhum — medido, 600
 * chamadas gravaram 602 arquivos num envio sem nenhuma recusa, enquanto a
 * importação do mesmo conteúdo teria parado em 512.
 */
export const MAX_FILES_POR_ENVIO = DEFAULT_MAX_ZIP_ENTRIES;

/** Recusa antes de gravar quando o envio já está no teto. */
export function assertHasRoom(quarantined: QuarantineDetail): void {
  if (quarantined.files.length < MAX_FILES_POR_ENVIO) return;
  throw badRequest(
    `Este envio já tem ${quarantined.files.length} arquivos, o limite por envio. ` +
      'Remova algum, ou descarte o envio e importe o pacote de novo.',
  );
}

/**
 * Esta sessão pode promover este envio? A política da instalação amplia o
 * portão, nunca o acesso: quem não enxerga o envio já parou no `load`.
 *
 * O painel usa a resposta para decidir se desenha o botão; a rota de promover
 * chama `assertCanPromote`, que é onde a decisão vale.
 */
export async function mayPromote(user: AuthUser, quarantined: QuarantineDetail): Promise<boolean> {
  const approvers = await getQuarantineApprovers();
  return canPromoteQuarantine(approvers, user.role, quarantined.ownerUserUuid, user.uuid);
}

/** O mesmo, como guarda: 403 com a política em vigor na mensagem. */
export async function assertCanPromote(user: AuthUser, quarantined: QuarantineDetail): Promise<void> {
  const approvers = await getQuarantineApprovers();
  if (canPromoteQuarantine(approvers, user.role, quarantined.ownerUserUuid, user.uuid)) return;
  throw forbidden(
    `Nesta instalação quem aprova um envio da quarentena é: ${QUARANTINE_APPROVERS_LABEL[approvers]}`,
  );
}

/**
 * O envio como pacote ZIP, gerado na hora. Ao contrário do pacote de uma skill
 * (`streamSkillZip`), aqui **nada é remontado**: o SKILL.md da quarentena é o
 * arquivo cru, com o frontmatter que veio dentro dele.
 *
 * O nome do envio é livre (não é slug) e vai para um cabeçalho HTTP: passa pelo
 * `slugify` antes, senão uma aspa ou um acento no nome quebra o
 * `Content-Disposition`.
 */
export async function streamZip(
  res: Response,
  quarantined: QuarantineDetail,
  files: readonly FileContent[],
): Promise<void> {
  const name = slugify(quarantined.name) || 'envio';
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${name}.zip"`);
  res.setHeader('Cache-Control', 'no-store');

  try {
    await writeZip(
      files.map((file) => ({ relativePath: `${name}/${file.relativePath}`, content: file.buffer })),
      res,
    );
  } catch (err) {
    // O stream já começou: não dá para trocar por uma resposta de erro JSON.
    console.error('[admin] erro ao gerar pacote do envio:', (err as Error).message);
    res.destroy(err as Error);
  }
}

// ----------------------------------------------------------------- destino ---
//
// Para onde a skill vai quando o envio for aprovado (`docs/15-quarentena.md`
// §11): catálogos em que ela entra e servidores em que ela é publicada. A régua
// é a de publicar direto — `edit` no catálogo e no vMCP —, cobrada **duas**
// vezes: de quem escolhe o destino (no envio e na ficha) e de quem aprova, que é
// quem vira dono da skill e responde pela publicação.

/** O nível da sessão em cada catálogo e vMCP que ela enxerga, por uuid. */
type Alcance = { catalogs: Map<string, EffectiveAccess>; mcps: Map<string, EffectiveAccess> };

/**
 * Duas listagens, uma de cada, em vez de uma leitura por destino: o destino
 * costuma ter um ou dois itens, mas a ficha é aberta a cada visita da fila. O
 * que não está no mapa a sessão não enxerga.
 */
async function alcanceDe(user: AuthUser, envio: QuarantineDetail): Promise<Alcance> {
  const { catalogs: cats, mcps: servers } = envio.targets;
  const [catalogList, mcpList] = await Promise.all([
    cats.length > 0 ? catalogs.listMine(user) : [],
    servers.length > 0 ? mcps.listMine(user) : [],
  ]);
  return {
    catalogs: new Map(catalogList.map((item) => [item.uuid, item.access])),
    mcps: new Map(mcpList.map((item) => [item.uuid, item.access])),
  };
}

/**
 * O destino pedido pelo painel, resolvido para o banco: catálogos pelo slug e
 * servidores na forma de "Publicar em" (`[{ slug, asSkill, asPrompt,
 * asResource }]`). Cada um exige `edit` — o mesmo que publicar direto —, e o
 * que a sessão não enxerga é 404, antes de gravar qualquer coisa.
 *
 * `aceitos` é o que já é destino e não se cobra de novo (`setTargets`): o
 * catálogo pelo slug, e o servidor pelo slug **com as mesmas portas** — mudar
 * a porta é publicar de outro jeito, e aí a cobrança volta.
 */
export async function resolveTargets(
  user: AuthUser,
  raw: { catalogs?: unknown; mcps?: unknown },
  aceitos: { catalogs: Map<string, string>; mcps: Map<string, SkillLinkInput> } = {
    catalogs: new Map(),
    mcps: new Map(),
  },
): Promise<QuarantineTargetsInput> {
  const catalogList = raw.catalogs ?? [];
  if (!Array.isArray(catalogList)) throw badRequest('Envie "catalogs" como uma lista de slugs');
  const catalogUuids: string[] = [];
  for (const [index, entry] of catalogList.entries()) {
    if (typeof entry !== 'string' || !entry.trim()) {
      throw badRequest(`catalogs[${index}]: informe o slug do catálogo`);
    }
    const slug = entry.trim();
    catalogUuids.push(aceitos.catalogs.get(slug) ?? (await catalogs.load(user, slug, 'edit')).uuid);
  }

  // O laço de `mcps.resolveLinks`, com o atalho do que já era destino.
  const mcpList = raw.mcps ?? [];
  if (!Array.isArray(mcpList)) throw badRequest('Envie "mcps" como uma lista');
  const links: SkillLinkInput[] = [];
  for (const [index, entry] of mcpList.entries()) {
    const item = (entry ?? {}) as Record<string, unknown>;
    if (typeof item.slug !== 'string' || !item.slug.trim()) {
      throw badRequest(`mcps[${index}]: informe o slug do MCP virtual`);
    }
    const slug = item.slug.trim();
    const flags = mcps.flagsFrom(item);
    const atual = aceitos.mcps.get(slug);
    if (atual && mesmasPortas(atual, flags)) {
      links.push(atual);
      continue;
    }
    links.push({ virtualMcpUuid: (await mcps.load(user, slug, 'edit')).uuid, ...flags });
  }

  return { catalogs: catalogUuids, mcps: links };
}

const mesmasPortas = (a: SkillLinkFlags, b: SkillLinkFlags) =>
  a.asSkill === b.asSkill && a.asPrompt === b.asPrompt && a.asResource === b.asResource;

/**
 * A ficha como a sessão a vê (`QuarantineSheet`): o destino só com o que ela
 * enxerga, cada item dizendo se ela o edita, e o resto contado sem nome.
 */
export async function sheetOf(user: AuthUser, envio: QuarantineDetail): Promise<QuarantineSheet> {
  const [alcance, canPromote] = await Promise.all([alcanceDe(user, envio), mayPromote(user, envio)]);
  const catalogsVistos = envio.targets.catalogs.filter((item) => alcance.catalogs.has(item.uuid));
  const mcpsVistos = envio.targets.mcps.filter((item) => alcance.mcps.has(item.uuid));
  const escondidos =
    envio.targets.catalogs.length - catalogsVistos.length + envio.targets.mcps.length - mcpsVistos.length;

  return {
    ...ownerByUsername(envio),
    canPromote,
    targets: {
      catalogs: catalogsVistos.map((item) => ({ ...item, editable: canEdit(alcance.catalogs.get(item.uuid)!) })),
      mcps: mcpsVistos.map((item) => ({ ...item, editable: canEdit(alcance.mcps.get(item.uuid)!) })),
    },
    hiddenTargetCount: escondidos,
  };
}

/**
 * Troca o destino do envio (`PUT /api/quarantine/:uuid/targets`). A lista é o
 * estado desejado **do que a sessão enxerga**:
 *
 * - o que **entra** — e o servidor que já estava mas mudou de porta — exige
 *   `edit`, como no envio: ampliar a publicação é publicar;
 * - o que **fica** como estava não é cobrado de novo, e o que **sai** também
 *   não: tirar um destino só reduz o que a aprovação vai publicar, e é o
 *   gesto de quem revisa e não pode aprovar com ele;
 * - os destinos que a sessão **não** enxerga ficam como estão, porque ela nem
 *   sabe que existem, a menos que `dropHidden` venha verdadeiro — é o "remover
 *   os destinos a que você não tem acesso" da ficha, que destrava a aprovação
 *   sem revelar o que era.
 */
export async function setTargets(
  user: AuthUser,
  envio: QuarantineDetail,
  body: { catalogs?: unknown; mcps?: unknown; dropHidden?: unknown },
): Promise<QuarantineSheet> {
  if (body.dropHidden !== undefined && typeof body.dropHidden !== 'boolean') {
    throw badRequest('"dropHidden" precisa ser true ou false');
  }
  const alcance = await alcanceDe(user, envio);
  const vistos = {
    catalogs: envio.targets.catalogs.filter((item) => alcance.catalogs.has(item.uuid)),
    mcps: envio.targets.mcps.filter((item) => alcance.mcps.has(item.uuid)),
  };

  const pedido = await resolveTargets(user, body, {
    catalogs: new Map(vistos.catalogs.map((item) => [item.slug, item.uuid])),
    mcps: new Map(vistos.mcps.map((item) => [item.slug, linkDe(item)])),
  });

  // Os que a sessão não enxerga seguem como estão, salvo pedido explícito.
  const escondidos: QuarantineTargetsInput =
    body.dropHidden === true
      ? { catalogs: [], mcps: [] }
      : {
          catalogs: envio.targets.catalogs.filter((item) => !alcance.catalogs.has(item.uuid)).map((item) => item.uuid),
          mcps: envio.targets.mcps.filter((item) => !alcance.mcps.has(item.uuid)).map(linkDe),
        };

  const updated = await setQuarantineTargets(
    envio.uuid,
    { catalogs: [...pedido.catalogs, ...escondidos.catalogs], mcps: [...pedido.mcps, ...escondidos.mcps] },
    SOURCE,
    actorOf(user),
  );
  return sheetOf(user, updated);
}

/** O destino gravado de volta na forma de entrada do banco. */
const linkDe = (item: QuarantineMcpTarget): SkillLinkInput => ({
  virtualMcpUuid: item.uuid,
  asSkill: item.asSkill,
  asPrompt: item.asPrompt,
  asResource: item.asResource,
});

/**
 * Quem aprova precisa poder publicar em **todo** o destino: `edit` em cada
 * catálogo e em cada servidor, como se estivesse publicando à mão. Faltando um,
 * é **403** e nada é criado — aprovar pela metade publicaria menos do que o
 * envio promete, sem ninguém ter decidido isso.
 *
 * Devolve o destino que foi conferido, para a promoção comparar com o gravado
 * dentro da transação: quem trocar o destino entre esta leitura e a gravação
 * faz a aprovação cair com 409, em vez de publicar o que não foi conferido.
 */
export async function assertCanPublishTargets(user: AuthUser, envio: QuarantineDetail): Promise<QuarantineTargetsInput> {
  const alcance = await alcanceDe(user, envio);

  const escondidos =
    envio.targets.catalogs.filter((item) => !alcance.catalogs.has(item.uuid)).length +
    envio.targets.mcps.filter((item) => !alcance.mcps.has(item.uuid)).length;
  if (escondidos > 0) {
    throw forbidden(
      escondidos === 1
        ? 'O envio tem um destino a que você não tem acesso. Remova-o na ficha do envio, ou peça a quem tem acesso para aprovar.'
        : `O envio tem ${escondidos} destinos a que você não tem acesso. Remova-os na ficha do envio, ou peça a quem tem acesso para aprovar.`,
    );
  }
  for (const item of envio.targets.catalogs) {
    if (!canEdit(alcance.catalogs.get(item.uuid)!)) {
      throw forbidden(
        `Seu acesso ao catálogo "${item.name}" não permite pôr skill nele. Tire-o do destino do envio, ou peça a quem o edita para aprovar.`,
      );
    }
  }
  for (const item of envio.targets.mcps) {
    if (!canEdit(alcance.mcps.get(item.uuid)!)) {
      throw forbidden(
        `Seu acesso ao servidor "${item.name}" não permite publicar nele. Tire-o do destino do envio, ou peça a quem o edita para aprovar.`,
      );
    }
  }

  return {
    catalogs: envio.targets.catalogs.map((item) => item.uuid),
    mcps: envio.targets.mcps.map(linkDe),
  };
}

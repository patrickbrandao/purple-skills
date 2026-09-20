import type { Response } from 'express';
import {
  badRequest,
  getQuarantine,
  getQuarantineApprovers,
  listQuarantine,
  notFound,
  type FileContent,
} from '@purple-skills/db';
import {
  DEFAULT_MAX_ZIP_ENTRIES,
  QUARANTINE_APPROVERS_LABEL,
  canPromoteQuarantine,
  canViewQuarantine,
  slugify,
  writeZip,
  type QuarantineDetail,
  type QuarantinePage,
} from '@purple-skills/shared';
import { forbidden } from './access.js';
import type { AuthUser } from './auth.js';

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

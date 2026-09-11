import {
  AppError,
  badRequest,
  createVirtualMcp,
  createVirtualMcpKey,
  deleteVirtualMcp,
  getVirtualMcp,
  listVirtualMcpKeys,
  listVirtualMcps,
  notFound,
  recordAccountAudit,
  revokeVirtualMcpKey,
  setVirtualMcpSkills,
  updateVirtualMcp,
} from '@purple-skills/db';
import {
  VIRTUAL_KEY_SCHEME,
  canManageVirtualMcp,
  generateApiKey,
  type VirtualMcpDetail,
  type VirtualMcpKeySummary,
  type VirtualMcpSkillInput,
  type VirtualMcpSummary,
} from '@purple-skills/shared';
import { actorOf, type AuthUser } from './auth.js';

const SOURCE = 'web-admin' as const;

const forbidden = (message: string) => new AppError(message, 403, 'forbidden');

/**
 * Pede confirmação explícita antes de deixar skill privada legível sem chave.
 *
 * É a decisão 6 de `docs/08-mcp-virtual.md`: um virtual aberto com skill
 * privada dentro é publicação de fato, e o sistema **permite** — mas só com
 * `confirmOpen: true` no corpo, que o painel manda depois de a pessoa marcar
 * que entendeu. Sem o campo, a resposta é um 400 com código próprio, que a UI
 * usa para abrir o aviso em vez de mostrar um erro genérico.
 */
const CONFIRM_REQUIRED = 'confirm_open_required';

function exigirConfirmacao(willBeOpen: boolean, privateCount: number, confirmed: unknown): void {
  if (!willBeOpen || privateCount === 0 || confirmed === true) return;
  throw new AppError(
    `Este MCP virtual ficará aberto (sem chave) com ${privateCount} skill(s) privada(s) dentro: ` +
      'qualquer pessoa que souber o endereço passa a lê-las. Confirme para continuar.',
    400,
    CONFIRM_REQUIRED,
  );
}

/** Os MCPs que a sessão enxerga: todos para admin, os próprios para os demais. */
export function listMine(user: AuthUser): Promise<VirtualMcpSummary[]> {
  return listVirtualMcps(user.role === 'admin' ? undefined : { ownerUserUuid: user.uuid });
}

/**
 * Carrega um MCP virtual que a sessão pode administrar.
 *
 * É a única exceção do projeto ao "papel limita a ação, não o escopo": o
 * virtual tem dono. Admin passa em qualquer um; o dono, no seu.
 */
export async function loadManaged(user: AuthUser, slug: string): Promise<VirtualMcpDetail> {
  const mcp = await getVirtualMcp(slug);
  if (!mcp) throw notFound(`MCP virtual não encontrado: ${slug}`);
  if (!canManageVirtualMcp(user.role, mcp.ownerUserUuid, user.uuid)) {
    throw forbidden('Este MCP virtual pertence a outra conta');
  }
  return mcp;
}

export async function create(
  user: AuthUser,
  body: { name?: unknown; slug?: unknown; description?: unknown; isOpen?: unknown },
): Promise<VirtualMcpDetail> {
  return createVirtualMcp(
    {
      name: String(body.name ?? '').trim(),
      slug: typeof body.slug === 'string' && body.slug.trim() ? body.slug.trim() : undefined,
      description: typeof body.description === 'string' ? body.description : undefined,
      // Nasce vazio, então abrir aqui ainda não expõe nada — a confirmação
      // entra quando a primeira skill privada for vinculada.
      isOpen: body.isOpen === true,
      // Quem cria é o dono. A sessão de bootstrap não tem UUID: o MCP nasce
      // órfão, administrável só por admin.
      ownerUserUuid: user.uuid,
    },
    SOURCE,
    actorOf(user),
  );
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
    confirmOpen?: unknown;
  },
): Promise<VirtualMcpDetail> {
  const current = await loadManaged(user, slug);

  const patch: Parameters<typeof updateVirtualMcp>[1] = {};
  if (typeof body.name === 'string') patch.name = body.name.trim();
  if (typeof body.slug === 'string') patch.slug = body.slug.trim();
  if (typeof body.description === 'string') patch.description = body.description;
  if (typeof body.isOpen === 'boolean') patch.isOpen = body.isOpen;
  if (typeof body.isActive === 'boolean') patch.isActive = body.isActive;

  // Transferir o dono é do admin: o dono atual não escolhe quem o substitui.
  if (body.ownerUserUuid !== undefined) {
    if (user.role !== 'admin') throw forbidden('Só um administrador transfere o dono de um MCP virtual');
    if (body.ownerUserUuid !== null && typeof body.ownerUserUuid !== 'string') {
      throw badRequest('ownerUserUuid precisa ser um UUID ou null');
    }
    patch.ownerUserUuid = body.ownerUserUuid;
  }

  if (patch.isOpen === true && !current.isOpen) {
    exigirConfirmacao(true, current.privateSkillCount, body.confirmOpen);
  }

  return updateVirtualMcp(current.uuid, patch, SOURCE, actorOf(user));
}

export async function remove(user: AuthUser, slug: string): Promise<void> {
  const current = await loadManaged(user, slug);
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
  body: { skills?: unknown; confirmOpen?: unknown },
  privateSlugs: (slugs: string[]) => Promise<number>,
): Promise<VirtualMcpDetail> {
  const current = await loadManaged(user, slug);

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

  if (current.isOpen) {
    exigirConfirmacao(true, await privateSlugs(skills.map((skill) => skill.slug)), body.confirmOpen);
  }

  return setVirtualMcpSkills(current.uuid, skills, SOURCE, actorOf(user));
}

// ------------------------------------------------------------------ chaves ---

export async function listKeys(user: AuthUser, slug: string): Promise<VirtualMcpKeySummary[]> {
  const current = await loadManaged(user, slug);
  return listVirtualMcpKeys(current.uuid);
}

/** Emite uma chave `psv_`. O texto completo só existe na resposta desta chamada. */
export async function issueKey(
  user: AuthUser,
  slug: string,
  rawName: unknown,
): Promise<{ key: VirtualMcpKeySummary; token: string }> {
  const current = await loadManaged(user, slug);

  const name = String(rawName ?? '').trim();
  if (!name) throw badRequest('Dê um nome à chave (ex.: "CI do projeto X")');

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
    targetLabel: `${current.slug}: ${name}`,
  });

  return { key, token: generated.token };
}

export async function revokeKey(user: AuthUser, slug: string, id: string): Promise<void> {
  const current = await loadManaged(user, slug);

  const revoked = await revokeVirtualMcpKey(id, current.uuid);
  if (!revoked) throw notFound('Chave não encontrada ou já revogada');

  await recordAccountAudit({
    action: 'mcp.key.revoke',
    source: SOURCE,
    actor: actorOf(user),
    targetLabel: `${current.slug}: ${id}`,
  });
}

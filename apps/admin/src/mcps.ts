import {
  AppError,
  badRequest,
  createVirtualMcp,
  createVirtualMcpKey,
  deleteVirtualMcp,
  getVirtualMcp,
  linkSkill as dbLinkSkill,
  listVirtualMcpKeys,
  listVirtualMcps,
  notFound,
  recordAccountAudit,
  resolveDefaultVirtualMcp,
  revokeVirtualMcpKey,
  setDefaultVirtualMcp,
  setVirtualMcpSkills,
  unlinkSkill as dbUnlinkSkill,
  updateVirtualMcp,
  type DefaultMcpResolution,
  type SkillLinkFlags,
} from '@purple-skills/db';
import {
  VIRTUAL_KEY_SCHEME,
  canManageVirtualMcp,
  generateApiKey,
  type InstallationSettings,
  type SkillDetail,
  type SkillLinkInput,
  type VirtualMcpDetail,
  type VirtualMcpKeySummary,
  type VirtualMcpSkillInput,
  type VirtualMcpSummary,
} from '@purple-skills/shared';
import { actorOf, type AuthUser } from './auth.js';

const SOURCE = 'web-admin' as const;

const forbidden = (message: string) => new AppError(message, 403, 'forbidden');

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
  body: { skills?: unknown },
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

  return setVirtualMcpSkills(current.uuid, skills, SOURCE, actorOf(user));
}

// ------------------------------------------- vínculo pelo lado da skill ---

/** As três portas do vínculo, obrigatórias e ao menos uma ligada. */
function flagsFrom(body: unknown): SkillLinkFlags {
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
 * Publica a skill num vMCP a partir da página dela
 * (`docs/09-mcp-padrao-e-skills-flutuantes.md` §4.3). A permissão é a do
 * vMCP alvo — dono ou admin — exatamente como no `PUT …/skills` do MCP.
 */
export async function linkSkill(
  user: AuthUser,
  mcpSlug: string,
  skillSlug: string,
  body: unknown,
): Promise<SkillDetail> {
  const mcp = await loadManaged(user, mcpSlug);
  return dbLinkSkill(skillSlug, mcp.uuid, flagsFrom(body), SOURCE, actorOf(user));
}

export async function unlinkSkill(
  user: AuthUser,
  mcpSlug: string,
  skillSlug: string,
): Promise<SkillDetail> {
  const mcp = await loadManaged(user, mcpSlug);
  return dbUnlinkSkill(skillSlug, mcp.uuid, SOURCE, actorOf(user));
}

/**
 * A lista "publicar em" de uma skill nova: slugs de vMCP e flags, vindos do
 * formulário ou do import, resolvidos em uuids. Cada vMCP passa por
 * `loadManaged`: quem não o administra não publica nele, e a skill não é
 * criada.
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
    const mcp = await loadManaged(user, item.slug.trim());
    links.push({ virtualMcpUuid: mcp.uuid, ...flagsFrom(item) });
  }
  return links;
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

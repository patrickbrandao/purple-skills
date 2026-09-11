import {
  AppError,
  badRequest,
  createVirtualMcp,
  createVirtualMcpKey,
  deleteVirtualMcp,
  getSkillSummary,
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
  canCreateVirtualMcp,
  canManageVirtualMcp,
  generateApiKey,
  type VirtualMcpDetail,
  type VirtualMcpSkillInput,
} from '@purple-skills/shared';
import type { Caller } from './auth.js';

const SOURCE = 'mcp-admin' as const;

type ToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};

const text = (value: string): ToolResult => ({ content: [{ type: 'text', text: value }] });
const asJson = (value: unknown): ToolResult => text(JSON.stringify(value, null, 2));
const fail = (message: string): ToolResult => ({
  content: [{ type: 'text', text: message }],
  isError: true,
});

const forbidden = (message: string) => new AppError(message, 403, 'forbidden');

/** O que uma tool devolve de um MCP virtual — o mesmo shape do painel. */
const view = (mcp: VirtualMcpDetail) => ({
  slug: mcp.slug,
  name: mcp.name,
  description: mcp.description,
  isActive: mcp.isActive,
  isOpen: mcp.isOpen,
  owner: mcp.ownerEmail,
  path: `/virtual/${mcp.slug}/mcp`,
  skills: mcp.skills.map((skill) => ({
    slug: skill.slug,
    name: skill.name,
    visibility: skill.isPublic ? 'public' : 'private',
    asSkill: skill.asSkill,
    asPrompt: skill.asPrompt,
    asResource: skill.asResource,
    views: skill.viewCount,
    downloads: skill.downloadCount,
  })),
  activeKeys: mcp.activeKeyCount,
});

/**
 * Handlers das tools de MCP virtual do MCP administrativo.
 *
 * O `caller` decide o alcance como no painel: o token global e uma chave de
 * admin administram qualquer MCP; a chave de um usuário, os MCPs de que ele é
 * dono. `caller.actor.userUuid` é o usuário — nulo para o token global.
 */
export function createMcpHandlers(caller: Caller) {
  const actor = caller.actor;
  const userUuid = actor.userUuid;

  async function managed(slug: string): Promise<VirtualMcpDetail> {
    const mcp = await getVirtualMcp(slug);
    if (!mcp) throw notFound(`MCP virtual não encontrado: "${slug}"`);
    if (!canManageVirtualMcp(caller.role, mcp.ownerUserUuid, userUuid)) {
      throw forbidden(`O MCP virtual "${slug}" pertence a outra conta; só o dono ou um admin mexem nele.`);
    }
    return mcp;
  }

  /**
   * Abrir um MCP com skill privada dentro é publicação: exige `confirm_open`
   * (`docs/08-mcp-virtual.md`, decisão 6).
   */
  function exigirConfirmacao(privateCount: number, confirmed: boolean | undefined): ToolResult | null {
    if (privateCount === 0 || confirmed === true) return null;
    return fail(
      `Este MCP virtual ficará aberto (sem chave) com ${privateCount} skill(s) privada(s) dentro: ` +
        'qualquer pessoa que souber o endereço passa a lê-las. Passe confirm_open: true para continuar.',
    );
  }

  return {
    async list_virtual_mcps(): Promise<ToolResult> {
      const items = await listVirtualMcps(
        caller.role === 'admin' ? undefined : { ownerUserUuid: userUuid },
      );
      return asJson({
        mcps: items.map((mcp) => ({
          slug: mcp.slug,
          name: mcp.name,
          isActive: mcp.isActive,
          isOpen: mcp.isOpen,
          owner: mcp.ownerEmail,
          skills: mcp.skillCount,
          privateSkills: mcp.privateSkillCount,
          activeKeys: mcp.activeKeyCount,
          path: `/virtual/${mcp.slug}/mcp`,
        })),
      });
    },

    async get_virtual_mcp(args: { slug: string }): Promise<ToolResult> {
      return asJson(view(await managed(args.slug)));
    },

    async create_virtual_mcp(args: {
      name: string;
      slug?: string;
      description?: string;
      is_open?: boolean;
    }): Promise<ToolResult> {
      if (!canCreateVirtualMcp(caller.role)) {
        return fail(`Criar MCP virtual exige papel "editor" ou "admin"; sua credencial é "${caller.role}".`);
      }
      const mcp = await createVirtualMcp(
        {
          name: args.name,
          slug: args.slug,
          description: args.description,
          isOpen: args.is_open === true,
          // Quem cria é o dono. O token global não é uma conta: o MCP nasce
          // órfão, administrável só por admin.
          ownerUserUuid: userUuid,
        },
        SOURCE,
        actor,
      );
      return text(
        `MCP virtual criado: "${mcp.name}" em /virtual/${mcp.slug}/mcp (${
          mcp.isOpen ? 'aberto' : 'exige chave'
        }). Use set_virtual_mcp_skills para escolher as skills e create_virtual_mcp_key para emitir uma chave.`,
      );
    },

    async update_virtual_mcp(args: {
      slug: string;
      name?: string;
      new_slug?: string;
      description?: string;
      is_open?: boolean;
      is_active?: boolean;
      confirm_open?: boolean;
    }): Promise<ToolResult> {
      const current = await managed(args.slug);

      if (args.is_open === true && !current.isOpen) {
        const denied = exigirConfirmacao(current.privateSkillCount, args.confirm_open);
        if (denied) return denied;
      }

      const mcp = await updateVirtualMcp(
        current.uuid,
        {
          name: args.name,
          slug: args.new_slug,
          description: args.description,
          isOpen: args.is_open,
          isActive: args.is_active,
        },
        SOURCE,
        actor,
      );
      return text(`MCP virtual atualizado: "${mcp.name}" em /virtual/${mcp.slug}/mcp.`);
    },

    async delete_virtual_mcp(args: { slug: string; confirm: boolean }): Promise<ToolResult> {
      const current = await managed(args.slug);
      if (args.confirm !== true) {
        return fail('Passe confirm: true para confirmar a remoção do MCP virtual, seus vínculos e chaves.');
      }
      await deleteVirtualMcp(current.uuid, SOURCE, actor);
      return text(`MCP virtual "${args.slug}" removido, com seus vínculos e chaves.`);
    },

    async set_virtual_mcp_skills(args: {
      slug: string;
      skills: VirtualMcpSkillInput[];
      confirm_open?: boolean;
    }): Promise<ToolResult> {
      const current = await managed(args.slug);

      const semSuperficie = args.skills.filter(
        (skill) => !skill.asSkill && !skill.asPrompt && !skill.asResource,
      );
      if (semSuperficie.length > 0) {
        return fail(
          'Toda skill precisa sair por ao menos uma superfície (asSkill, asPrompt ou asResource): ' +
            semSuperficie.map((skill) => skill.slug).join(', '),
        );
      }

      if (current.isOpen) {
        const found = await Promise.all(
          args.skills.map((skill) => getSkillSummary(skill.slug, { includePrivate: true })),
        );
        const privadas = found.filter((skill) => skill && !skill.isPublic).length;
        const denied = exigirConfirmacao(privadas, args.confirm_open);
        if (denied) return denied;
      }

      const mcp = await setVirtualMcpSkills(current.uuid, args.skills, SOURCE, actor);
      return text(
        `${mcp.skills.length} skill(s) no MCP virtual "${mcp.slug}":\n` +
          mcp.skills
            .map(
              (skill) =>
                `- ${skill.slug} (${skill.isPublic ? 'pública' : 'privada'}): ${[
                  skill.asSkill && 'skill',
                  skill.asPrompt && 'prompt',
                  skill.asResource && 'resource',
                ]
                  .filter(Boolean)
                  .join(', ')}`,
            )
            .join('\n'),
      );
    },

    async list_virtual_mcp_keys(args: { slug: string }): Promise<ToolResult> {
      const current = await managed(args.slug);
      const keys = await listVirtualMcpKeys(current.uuid);
      return asJson({
        keys: keys.map((key) => ({
          id: key.id,
          name: key.name,
          prefix: `psv_${key.prefix}_…`,
          lastUsedAt: key.lastUsedAt,
          revokedAt: key.revokedAt,
          createdAt: key.createdAt,
        })),
      });
    },

    /** O texto completo da chave só existe nesta resposta. */
    async create_virtual_mcp_key(args: { slug: string; name: string }): Promise<ToolResult> {
      const current = await managed(args.slug);
      const name = (args.name ?? '').trim();
      if (!name) throw badRequest('Dê um nome à chave (ex.: "CI do projeto X")');

      const generated = generateApiKey(VIRTUAL_KEY_SCHEME);
      const key = await createVirtualMcpKey({
        virtualMcpUuid: current.uuid,
        name,
        prefix: generated.prefix,
        keyHash: generated.keyHash,
        createdByUserUuid: userUuid,
      });
      await recordAccountAudit({
        action: 'mcp.key.create',
        source: SOURCE,
        actor,
        targetLabel: `${current.slug}: ${name}`,
      });

      return asJson({
        id: key.id,
        name: key.name,
        token: generated.token,
        warning: 'Guarde agora: o token não volta a aparecer.',
        usage: `Authorization: Bearer ${generated.token} em /virtual/${current.slug}/mcp`,
      });
    },

    async revoke_virtual_mcp_key(args: { slug: string; key_id: string }): Promise<ToolResult> {
      const current = await managed(args.slug);
      const revoked = await revokeVirtualMcpKey(args.key_id, current.uuid);
      if (!revoked) return fail('Chave não encontrada neste MCP virtual, ou já revogada.');

      await recordAccountAudit({
        action: 'mcp.key.revoke',
        source: SOURCE,
        actor,
        targetLabel: `${current.slug}: ${args.key_id}`,
      });
      return text(`Chave ${args.key_id} revogada.`);
    },
  };
}

export type McpHandlers = ReturnType<typeof createMcpHandlers>;

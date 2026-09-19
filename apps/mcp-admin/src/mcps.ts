import {
  badRequest,
  createVirtualMcp,
  createVirtualMcpKey,
  deleteVirtualMcp,
  getVirtualMcp,
  linkSkill,
  listVirtualMcpKeys,
  listVirtualMcps,
  notFound,
  recordAccountAudit,
  removeVirtualMcpGrant,
  resolveDefaultVirtualMcp,
  revokeVirtualMcpKey,
  setDefaultVirtualMcp,
  setVirtualMcpGrant,
  setVirtualMcpSkills,
  unlinkSkill,
  updateVirtualMcp,
  type DefaultMcpResolution,
} from '@purple-skills/db';
import {
  ACCESS_LABEL,
  VIRTUAL_KEY_SCHEME,
  canCreate,
  canManage,
  generateApiKey,
  isAccessScope,
  type AccessLevel,
  type VirtualMcpDetail,
  type VirtualMcpSkillInput,
} from '@purple-skills/shared';
import { accountByEmail, assertAccess, assertSkillsViewable, levelFrom, viewerOf } from './access.js';
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

/** O que uma tool devolve de um MCP virtual — o mesmo shape do painel. */
const view = (mcp: VirtualMcpDetail) => ({
  slug: mcp.slug,
  name: mcp.name,
  description: mcp.description,
  isActive: mcp.isActive,
  isOpen: mcp.isOpen,
  isDefault: mcp.isDefault,
  owner: mcp.ownerEmail,
  access: mcp.access,
  // A lista de concessões só para quem as administra (`docs/12` decisão 11).
  grants: canManage(mcp.access)
    ? mcp.grants.map((grant) => ({ email: grant.email, name: grant.name, level: grant.level }))
    : undefined,
  path: `/virtual/${mcp.slug}/mcp`,
  skills: mcp.skills.map((skill) => ({
    slug: skill.slug,
    name: skill.name,
    asSkill: skill.asSkill,
    asPrompt: skill.asPrompt,
    asResource: skill.asResource,
    views: skill.viewCount,
    downloads: skill.downloadCount,
  })),
  // Catálogos vinculados: todas as skills ativas de cada um saem pelas portas
  // do vínculo, menos as que já têm vínculo direto acima (que prevalece).
  catalogs: mcp.catalogs.map((catalog) => ({
    slug: catalog.slug,
    name: catalog.name,
    isActive: catalog.isActive,
    asSkill: catalog.asSkill,
    asPrompt: catalog.asPrompt,
    asResource: catalog.asResource,
    activeSkills: catalog.activeSkillCount,
  })),
  activeKeys: mcp.activeKeyCount,
  // Quantas skills saem por cada porta — os mesmos contadores do card do painel.
  tools: mcp.toolCount,
  prompts: mcp.promptCount,
  resources: mcp.resourceCount,
});

/**
 * Handlers das tools de MCP virtual do MCP administrativo.
 *
 * O `caller` decide o alcance como no painel (`docs/12-acesso-granular.md`):
 * o token global e uma chave de admin veem e administram qualquer MCP; a
 * chave de um usuário, os seus, os concedidos (no nível da concessão) e os
 * abertos (leitura). `caller.actor.userUuid` é o usuário — nulo para o token
 * global.
 */
export function createMcpHandlers(caller: Caller) {
  const actor = caller.actor;
  const userUuid = actor.userUuid;
  const viewer = viewerOf(caller);

  /** O MCP padrão responde em /mcp para a instalação inteira: só admin escolhe. */
  const denySettings = (): ToolResult | null =>
    caller.role === 'admin'
      ? null
      : fail(`Escolher o MCP padrão exige papel "admin"; sua credencial é "${caller.role}".`);

  /** O vMCP com o nível mínimo da ação; 404 se a credencial não o vê. */
  async function managed(slug: string, minimum: AccessLevel | 'owner'): Promise<VirtualMcpDetail> {
    const mcp = await getVirtualMcp(slug, { viewer });
    if (!mcp) throw notFound(`MCP virtual não encontrado: "${slug}"`);
    assertAccess(mcp.access, minimum, 'MCP virtual');
    return mcp;
  }

  return {
    async list_virtual_mcps(args: { scope?: string } = {}): Promise<ToolResult> {
      const items = await listVirtualMcps({
        viewer,
        ...(isAccessScope(args.scope) ? { scope: args.scope } : {}),
      });
      return asJson({
        mcps: items.map((mcp) => ({
          slug: mcp.slug,
          name: mcp.name,
          isActive: mcp.isActive,
          isOpen: mcp.isOpen,
          isDefault: mcp.isDefault,
          owner: mcp.ownerEmail,
          access: mcp.access,
          skills: mcp.skillCount,
          catalogs: mcp.catalogCount,
          tools: mcp.toolCount,
          prompts: mcp.promptCount,
          resources: mcp.resourceCount,
          activeKeys: mcp.activeKeyCount,
          path: `/virtual/${mcp.slug}/mcp`,
        })),
      });
    },

    async get_virtual_mcp(args: { slug: string }): Promise<ToolResult> {
      return asJson(view(await managed(args.slug, 'view')));
    },

    async create_virtual_mcp(args: {
      name: string;
      slug?: string;
      description?: string;
      is_open?: boolean;
    }): Promise<ToolResult> {
      if (!canCreate(caller.role)) {
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
    }): Promise<ToolResult> {
      // Nome, slug, descrição, aberto e ligado são propriedades: `manage`.
      const current = await managed(args.slug, 'manage');

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
      const current = await managed(args.slug, 'owner');
      if (args.confirm !== true) {
        return fail('Passe confirm: true para confirmar a remoção do MCP virtual, seus vínculos e chaves.');
      }
      await deleteVirtualMcp(current.uuid, SOURCE, actor);
      return text(`MCP virtual "${args.slug}" removido, com seus vínculos e chaves.`);
    },

    async set_virtual_mcp_skills(args: {
      slug: string;
      skills: VirtualMcpSkillInput[];
    }): Promise<ToolResult> {
      const current = await managed(args.slug, 'edit');

      const semSuperficie = args.skills.filter(
        (skill) => !skill.asSkill && !skill.asPrompt && !skill.asResource,
      );
      if (semSuperficie.length > 0) {
        return fail(
          'Toda skill precisa sair por ao menos uma superfície (asSkill, asPrompt ou asResource): ' +
            semSuperficie.map((skill) => skill.slug).join(', '),
        );
      }

      // Quem entra precisa ser visível para a credencial (`docs/12` decisão 6).
      const linked = new Set(current.skills.map((skill) => skill.slug));
      await assertSkillsViewable(caller, args.skills.map((skill) => skill.slug).filter((slug) => !linked.has(slug)));

      const mcp = await setVirtualMcpSkills(current.uuid, args.skills, SOURCE, actor);
      return text(
        `${mcp.skills.length} skill(s) no MCP virtual "${mcp.slug}":\n` +
          mcp.skills
            .map(
              (skill) =>
                `- ${skill.slug}: ${[
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

    /**
     * Vínculo pelo lado da skill (`docs/09-mcp-padrao-e-skills-flutuantes.md`
     * §4.3): `edit` no vMCP alvo e `view` na skill, como em
     * `set_virtual_mcp_skills`.
     */
    async link_skill(args: {
      skill: string;
      mcp: string;
      asSkill: boolean;
      asPrompt: boolean;
      asResource: boolean;
    }): Promise<ToolResult> {
      const current = await managed(args.mcp, 'edit');
      await assertSkillsViewable(caller, [args.skill]);
      if (!args.asSkill && !args.asPrompt && !args.asResource) {
        return fail('Escolha ao menos uma superfície: asSkill, asPrompt ou asResource.');
      }

      const detail = await linkSkill(
        args.skill,
        current.uuid,
        { asSkill: args.asSkill, asPrompt: args.asPrompt, asResource: args.asResource },
        SOURCE,
        actor,
      );
      return text(
        `"${detail.slug}" publicada em "${current.slug}" como ${[
          args.asSkill && 'skill',
          args.asPrompt && 'prompt',
          args.asResource && 'resource',
        ]
          .filter(Boolean)
          .join(', ')}. Agora está em ${detail.mcps.length} MCP(s) virtual(is).`,
      );
    },

    async unlink_skill(args: { skill: string; mcp: string }): Promise<ToolResult> {
      const current = await managed(args.mcp, 'edit');
      const detail = await unlinkSkill(args.skill, current.uuid, SOURCE, actor);
      return text(
        `"${detail.slug}" saiu de "${current.slug}". ${
          detail.mcps.length > 0
            ? `Continua em ${detail.mcps.map((mcp) => mcp.slug).join(', ')}.`
            : 'Ficou sem vínculo: não é exibida em lugar nenhum.'
        }`,
      );
    },

    async list_virtual_mcp_keys(args: { slug: string }): Promise<ToolResult> {
      const current = await managed(args.slug, 'manage');
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
      // Emitir uma chave entrega a árvore inteira a uma máquina: `manage`.
      const current = await managed(args.slug, 'manage');
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
      const current = await managed(args.slug, 'manage');
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

    // ----------------------------------------------------------- acesso ---

    async share_mcp(args: { slug: string; email: string; level: string }): Promise<ToolResult> {
      const current = await managed(args.slug, 'manage');
      const target = await accountByEmail(args.email);
      const grant = await setVirtualMcpGrant(current.slug, target.uuid, levelFrom(args.level), SOURCE, actor);
      return text(`${grant.email} agora pode ${ACCESS_LABEL[grant.level]} o MCP virtual "${current.slug}".`);
    },

    async unshare_mcp(args: { slug: string; email: string }): Promise<ToolResult> {
      const current = await managed(args.slug, 'manage');
      const target = await accountByEmail(args.email);
      await removeVirtualMcpGrant(current.slug, target.uuid, SOURCE, actor);
      return text(`${target.email} perdeu o acesso ao MCP virtual "${current.slug}".`);
    },

    async transfer_mcp(args: { slug: string; email: string }): Promise<ToolResult> {
      const current = await managed(args.slug, 'owner');
      const target = await accountByEmail(args.email);
      await updateVirtualMcp(current.uuid, { ownerUserUuid: target.uuid }, SOURCE, actor);
      return text(`O MCP virtual "${current.slug}" agora é de ${target.email}.`);
    },

    // ------------------------------------------------------- MCP padrão ---

    /**
     * Qual vMCP responde em `/mcp`, para **qualquer** credencial: sem
     * `denySettings()` e sem `viewer`, de propósito.
     *
     * É a decisão registrada: `docs/09-mcp-padrao-e-skills-flutuantes.md` §3.6
     * diz "`get_default_virtual_mcp()` (qualquer credencial) e
     * `set_default_virtual_mcp(slug | null)` (só admin)". E não é vazamento:
     * quem configura um cliente precisa do endereço e de saber se ele exige
     * chave, e o `GET /` do próprio mcp-public anuncia `{ status, slug, name,
     * auth }` ao **anônimo**, com o padrão aberto ou fechado (§3.2 e a linha 8
     * da tabela do §2 — o padrão não tem tratamento especial). A descrição do
     * vMCP, que é texto livre, não sai aqui — ver `defaultView`.
     */
    async get_default_virtual_mcp(): Promise<ToolResult> {
      return asJson(defaultView(await resolveDefaultVirtualMcp()));
    },

    /**
     * Escolhe o vMCP que responde em /mcp, ou limpa com slug nulo. Sem guarda
     * além do papel: o padrão não tem tratamento especial, e escolher um
     * desligado ou fechado é permitido — a raiz responde de acordo.
     */
    async set_default_virtual_mcp(args: { slug: string | null }): Promise<ToolResult> {
      const denied = denySettings();
      if (denied) return denied;

      let uuid: string | null = null;
      if (args.slug !== null) {
        const mcp = await getVirtualMcp(args.slug);
        if (!mcp) throw notFound(`MCP virtual não encontrado: "${args.slug}"`);
        uuid = mcp.uuid;
      }

      const resolved = await setDefaultVirtualMcp(uuid, SOURCE, actor);
      return text(
        resolved.status === 'ok'
          ? `/mcp agora responde pelo MCP virtual "${resolved.mcp.slug}" (${
              resolved.mcp.isOpen ? 'aberto' : 'exige chave psv_'
            }).`
          : resolved.status === 'inactive'
            ? `/mcp aponta para "${resolved.slug}", que está desligado: responde 404 até religar.`
            : 'Nenhum MCP padrão: /mcp responde 404.',
      );
    },
  };
}

/**
 * O que `get_default_virtual_mcp` devolve: qual vMCP responde em /mcp, ou por
 * que nenhum. Os mesmos campos do `GET /` do mcp-public, mais os dois
 * caminhos — e **sem** a descrição, que é texto livre e que esta tool entrega a
 * qualquer credencial, inclusive quando o padrão é um vMCP fechado.
 */
function defaultView(resolved: DefaultMcpResolution) {
  if (resolved.status === 'ok') {
    return {
      status: 'ok',
      slug: resolved.mcp.slug,
      name: resolved.mcp.name,
      auth: resolved.mcp.isOpen ? 'open' : 'key',
      path: '/mcp',
      alsoAt: `/virtual/${resolved.mcp.slug}/mcp`,
    };
  }
  return {
    status: resolved.status,
    slug: resolved.slug,
    hint:
      resolved.status === 'inactive'
        ? 'O MCP padrão está desligado: /mcp responde 404 até religar (update_virtual_mcp is_active=true) ou escolher outro.'
        : resolved.status === 'deleted'
          ? 'O MCP padrão foi removido: /mcp responde 404 até set_default_virtual_mcp escolher outro.'
          : 'Nenhum MCP padrão: /mcp responde 404 até set_default_virtual_mcp escolher um.',
  };
}

export type McpHandlers = ReturnType<typeof createMcpHandlers>;

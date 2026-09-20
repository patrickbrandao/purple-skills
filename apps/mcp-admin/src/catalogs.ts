import {
  createCatalog,
  deleteCatalog,
  getCatalog,
  getVirtualMcp,
  listCatalogs,
  notFound,
  removeCatalogGrant,
  setCatalogGrant,
  setCatalogSkills,
  setVirtualMcpCatalogs,
  updateCatalog,
} from '@purple-skills/db';
import {
  ACCESS_LABEL,
  canCreate,
  canManage,
  isAccessScope,
  type AccessLevel,
  type CatalogDetail,
  type CatalogSkillInput,
  type VirtualMcpCatalogInput,
  type VirtualMcpDetail,
} from '@purple-skills/shared';
import { accountByEmail, assertAccess, assertSkillsViewable, grantOf, levelFrom, viewerOf } from './access.js';
import type { Caller } from './auth.js';
import { assertNameFits } from './mcps.js';

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

/**
 * O que uma tool devolve de um catálogo — o mesmo shape do painel.
 *
 * Só para um detalhe **lido com `viewer`** (`managed`): é a leitura que recorta
 * `mcps` aos servidores que a credencial vê e `skills` aos membros que ela abre.
 * As escritas do banco releem sem `viewer`, na visão do admin — por isso as
 * tools de escrita respondem com texto montado do que quem escreve já alcança
 * (nome, estado, membros), e nunca com `view(...)` do detalhe que a escrita
 * devolve (relatório 010 da auditoria de 2026-09-19).
 */
const view = (catalog: CatalogDetail) => ({
  slug: catalog.slug,
  name: catalog.name,
  description: catalog.description,
  isActive: catalog.isActive,
  isPublic: catalog.isPublic,
  owner: catalog.ownerEmail,
  access: catalog.access,
  // A lista de concessões só para quem as administra (`docs/12` decisão 11).
  // `isActive: false` é a conta desativada: a linha fica, inerte, volta a valer
  // se a conta for reativada — e `unshare_catalog` a revoga assim mesmo.
  grants: canManage(catalog.access)
    ? catalog.grants.map((grant) => ({ email: grant.email, name: grant.name, level: grant.level, isActive: grant.isActive }))
    : undefined,
  activeSkills: catalog.activeSkillCount,
  views: catalog.viewCount,
  downloads: catalog.downloadCount,
  skills: catalog.skills.map((skill) => ({
    slug: skill.slug,
    name: skill.name,
    // A participação no catálogo e a skill em si: as duas precisam estar
    // ligadas para a skill ser entregue.
    isActive: skill.isActive,
    skillIsActive: skill.skillIsActive,
  })),
  mcps: catalog.mcps.map((mcp) => ({
    slug: mcp.slug,
    name: mcp.name,
    isActive: mcp.isActive,
    isOpen: mcp.isOpen,
    asSkill: mcp.asSkill,
    asPrompt: mcp.asPrompt,
    asResource: mcp.asResource,
  })),
});

/**
 * Handlers das tools de catálogo do MCP administrativo
 * (`docs/11-catalogos.md` §6.3). O alcance é o do painel
 * (`docs/12-acesso-granular.md`): o token global e uma chave de admin veem e
 * administram qualquer catálogo; a chave de um usuário, os seus, os
 * concedidos (no nível da concessão) e os públicos (leitura).
 */
export function createCatalogHandlers(caller: Caller) {
  const actor = caller.actor;
  const userUuid = actor.userUuid;
  const viewer = viewerOf(caller);

  async function managed(slug: string, minimum: AccessLevel | 'owner'): Promise<CatalogDetail> {
    const catalog = await getCatalog(slug, { viewer });
    if (!catalog) throw notFound(`Catálogo não encontrado: "${slug}"`);
    assertAccess(catalog.access, minimum, 'catálogo');
    return catalog;
  }

  async function managedMcp(slug: string, minimum: AccessLevel | 'owner'): Promise<VirtualMcpDetail> {
    const mcp = await getVirtualMcp(slug, { viewer });
    if (!mcp) throw notFound(`MCP virtual não encontrado: "${slug}"`);
    assertAccess(mcp.access, minimum, 'MCP virtual');
    return mcp;
  }

  return {
    async list_catalogs(args: { scope?: string } = {}): Promise<ToolResult> {
      const items = await listCatalogs({
        viewer,
        ...(isAccessScope(args.scope) ? { scope: args.scope } : {}),
      });
      return asJson({
        catalogs: items.map((catalog) => ({
          slug: catalog.slug,
          name: catalog.name,
          isActive: catalog.isActive,
          isPublic: catalog.isPublic,
          owner: catalog.ownerEmail,
          access: catalog.access,
          skills: catalog.skillCount,
          activeSkills: catalog.activeSkillCount,
          mcps: catalog.mcpCount,
          views: catalog.viewCount,
          downloads: catalog.downloadCount,
        })),
      });
    },

    async get_catalog(args: { slug: string }): Promise<ToolResult> {
      return asJson(view(await managed(args.slug, 'view')));
    },

    async create_catalog(args: {
      name: string;
      slug?: string;
      description?: string;
      is_public?: boolean;
    }): Promise<ToolResult> {
      if (!canCreate(caller.role)) {
        return fail(`Criar catálogo exige papel "editor" ou "admin"; sua credencial é "${caller.role}".`);
      }
      // Mesmo teto do nome de vMCP — ver `NAME_MAX`, em `mcps.ts`.
      assertNameFits(args.name, 'do catálogo');
      const catalog = await createCatalog(
        {
          name: args.name,
          slug: args.slug,
          description: args.description,
          isPublic: args.is_public === true,
          // Quem cria é o dono. O token global não é uma conta: o catálogo
          // nasce órfão, administrável só por admin.
          ownerUserUuid: userUuid,
        },
        SOURCE,
        actor,
      );
      return text(
        `Catálogo criado: "${catalog.name}" (slug: ${catalog.slug}). Use set_catalog_skills para escolher as skills e set_virtual_mcp_catalogs para vinculá-lo a um MCP virtual.`,
      );
    },

    async update_catalog(args: {
      slug: string;
      name?: string;
      new_slug?: string;
      description?: string;
      is_active?: boolean;
      is_public?: boolean;
    }): Promise<ToolResult> {
      const current = await managed(args.slug, 'manage');
      // Só para quem renomeia: reenviar o nome que o catálogo já tem não é renomear.
      if (args.name !== undefined) assertNameFits(args.name, 'do catálogo', current.name);
      const catalog = await updateCatalog(
        current.uuid,
        {
          name: args.name,
          slug: args.new_slug,
          description: args.description,
          isActive: args.is_active,
          isPublic: args.is_public,
        },
        SOURCE,
        actor,
      );
      return text(
        `Catálogo atualizado: "${catalog.name}" (slug: ${catalog.slug}, ${catalog.isActive ? 'ligado' : 'desligado'}${
          catalog.isPublic ? ', público' : ''
        }).`,
      );
    },

    async delete_catalog(args: { slug: string; confirm: boolean }): Promise<ToolResult> {
      const current = await managed(args.slug, 'owner');
      if (args.confirm !== true) {
        return fail('Passe confirm: true para confirmar a remoção do catálogo e dos vínculos dele com MCPs virtuais.');
      }
      await deleteCatalog(current.uuid, SOURCE, actor);
      return text(`Catálogo "${args.slug}" removido. As skills continuam existindo.`);
    },

    async set_catalog_skills(args: { slug: string; skills: CatalogSkillInput[] }): Promise<ToolResult> {
      const current = await managed(args.slug, 'edit');
      // Quem entra precisa ser visível para a credencial (`docs/12` decisão 6).
      const members = new Set(current.skills.map((skill) => skill.slug));
      await assertSkillsViewable(caller, args.skills.map((skill) => skill.slug).filter((slug) => !members.has(slug)));
      const catalog = await setCatalogSkills(current.uuid, args.skills, SOURCE, actor);
      return text(
        `${catalog.skills.length} skill(s) no catálogo "${catalog.slug}" (${catalog.activeSkillCount} entregue(s)):\n` +
          catalog.skills
            .map(
              (skill) =>
                `- ${skill.slug}: ${skill.isActive ? 'participação ativa' : 'participação desativada'}${
                  skill.skillIsActive ? '' : ' · skill desligada'
                }`,
            )
            .join('\n'),
      );
    },

    // ----------------------------------------------------------- acesso ---

    async share_catalog(args: { slug: string; email: string; level: string }): Promise<ToolResult> {
      const current = await managed(args.slug, 'manage');
      const target = await accountByEmail(args.email);
      const grant = await setCatalogGrant(current.slug, target.uuid, levelFrom(args.level), SOURCE, actor);
      return text(`${grant.email} agora pode ${ACCESS_LABEL[grant.level]} o catálogo "${current.slug}".`);
    },

    /** Revogar vale para a conta em qualquer estado, inclusive desativada — ver `grantOf`. */
    async unshare_catalog(args: { slug: string; email: string }): Promise<ToolResult> {
      const current = await managed(args.slug, 'manage');
      const grant = grantOf(current.grants, args.email, 'neste catálogo');
      await removeCatalogGrant(current.slug, grant.userUuid, SOURCE, actor);
      return text(`${grant.email} perdeu o acesso ao catálogo "${current.slug}".`);
    },

    async transfer_catalog(args: { slug: string; email: string }): Promise<ToolResult> {
      const current = await managed(args.slug, 'owner');
      const target = await accountByEmail(args.email);
      await updateCatalog(current.uuid, { ownerUserUuid: target.uuid }, SOURCE, actor);
      return text(`O catálogo "${current.slug}" agora é de ${target.email}.`);
    },

    /**
     * Declarativa, pelo lado do vMCP: `edit` no servidor e `view` em cada
     * catálogo que entra (`docs/12` decisão 7). Quem sai não exige nada do
     * catálogo.
     */
    async set_virtual_mcp_catalogs(args: { slug: string; catalogs: VirtualMcpCatalogInput[] }): Promise<ToolResult> {
      const mcp = await managedMcp(args.slug, 'edit');

      const semSuperficie = args.catalogs.filter((item) => !item.asSkill && !item.asPrompt && !item.asResource);
      if (semSuperficie.length > 0) {
        return fail(
          'Todo catálogo precisa sair por ao menos uma superfície (asSkill, asPrompt ou asResource): ' +
            semSuperficie.map((item) => item.slug).join(', '),
        );
      }

      const linked = new Set(mcp.catalogs.map((item) => item.slug));
      for (const item of args.catalogs) {
        if (!linked.has(item.slug)) await managed(item.slug, 'view');
      }

      const updated = await setVirtualMcpCatalogs(mcp.uuid, args.catalogs, SOURCE, actor);
      return text(
        `${updated.catalogs.length} catálogo(s) no MCP virtual "${updated.slug}":\n` +
          updated.catalogs
            .map(
              (catalog) =>
                `- ${catalog.slug}: ${[catalog.asSkill && 'skill', catalog.asPrompt && 'prompt', catalog.asResource && 'resource']
                  .filter(Boolean)
                  .join(', ')} (${catalog.activeSkillCount} skill(s) ativa(s))`,
            )
            .join('\n'),
      );
    },
  };
}

export type CatalogHandlers = ReturnType<typeof createCatalogHandlers>;

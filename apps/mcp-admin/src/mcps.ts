import {
  badRequest,
  cloneVirtualMcp,
  createVirtualMcp,
  createVirtualMcpKey,
  deleteVirtualMcp,
  getSkillSummary,
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
import { accountByUsername, assertAccess, assertSkillsViewable, grantOf, levelFrom, viewerOf } from './access.js';
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

/**
 * Teto do nome de vMCP, de catálogo e de chave `psv_`, em caracteres — gêmeo do
 * `NAME_MAX` do painel (`apps/admin/src/mcps.ts`), onde está o porquê inteiro:
 * nome não tinha teto nenhum, e estes são copiados em cada linha de
 * `skill_accesses`, que nunca é podada (relatório 042 da auditoria de
 * 2026-09-19). É um número, não um contrato: quem mudar um muda o outro,
 * mantendo-o abaixo dos 512 em que o banco corta a cópia.
 *
 * Fica no handler, e não como `.max()` no schema zod da tool, por dois motivos:
 * a recusa chega ao agente em português, dizendo o limite, em vez do erro de
 * validação do protocolo; e o schema não conhece o nome **atual**.
 */
export const NAME_MAX = 200;

/**
 * Recusa o nome acima do teto. Vale para quem **cria ou renomeia**: nome antigo
 * mais longo continua válido até alguém mexer nele — reenviar o nome que o
 * objeto já tem (`unchanged`) não é renomear.
 */
export function assertNameFits(rawName: string, what: string, unchanged?: string): void {
  const name = (rawName ?? '').trim();
  if (name === unchanged?.trim() || name.length <= NAME_MAX) return;
  throw badRequest(`O nome ${what} é longo demais: ${name.length} caracteres (o limite é ${NAME_MAX})`);
}

/**
 * O rótulo de uma chave na trilha: `<slug>: <nome> (<prefixo>)`, o mesmo na
 * emissão e na revogação, como no painel. O prefixo desempata chaves de mesmo
 * nome e já é público — o segredo é o que vem depois.
 */
const keyLabel = (slug: string, key: { name: string; prefix: string }): string =>
  `${slug}: ${key.name} (${key.prefix})`;

/** O que uma tool devolve de um MCP virtual — o mesmo shape do painel. */
const view = (mcp: VirtualMcpDetail) => ({
  slug: mcp.slug,
  name: mcp.name,
  description: mcp.description,
  isActive: mcp.isActive,
  isOpen: mcp.isOpen,
  isDefault: mcp.isDefault,
  owner: mcp.ownerUsername,
  access: mcp.access,
  // A lista de concessões só para quem as administra (`docs/12` decisão 11).
  // `isActive: false` é a conta desativada: a linha fica, inerte, volta a valer
  // se a conta for reativada — e `unshare_mcp` a revoga assim mesmo.
  grants: canManage(mcp.access)
    ? mcp.grants.map((grant) => ({ username: grant.username, name: grant.name, level: grant.level, isActive: grant.isActive }))
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
          owner: mcp.ownerUsername,
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
      assertNameFits(args.name, 'do MCP virtual');
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

    /**
     * Clona o MCP virtual. A cópia é de quem clonou, nasce fechada (`is_open`
     * sempre falso) e, sem `new_slug`, o slug do original ganha sufixo (`-2`,
     * `-3`…) — o desempate é do banco, e nessa forma não há 409; um `new_slug`
     * já em uso, sim.
     *
     * Leva as propriedades, os vínculos com skills e com catálogos — com as
     * portas e as posições do canvas — e as concessões. **Não** leva as chaves
     * `psv_`: a cópia nasce sem chave nenhuma, e quem clona precisa saber
     * disso antes de apontar um cliente para ela.
     *
     * Exige `manage` no original, e não o `edit` que basta para clonar skill e
     * catálogo: a cópia leva a ACL, e ler a ACL é poder de `manage` (decisão
     * 11 do `docs/12-acesso-granular.md`).
     */
    async clone_virtual_mcp(args: { slug: string; name?: string; new_slug?: string }): Promise<ToolResult> {
      if (!canCreate(caller.role)) {
        return fail(
          `Clonar um MCP virtual faz nascer um MCP virtual novo: exige papel "editor" ou "admin"; sua credencial é "${caller.role}".`,
        );
      }
      const origem = await managed(args.slug, 'manage');
      // Só para quem dá nome à cópia: sem `name` ela repete o do original.
      if (args.name !== undefined) assertNameFits(args.name, 'do MCP virtual');

      const copia = await cloneVirtualMcp(
        origem.uuid,
        {
          name: args.name,
          slug: args.new_slug,
          // Quem clona é o dono. O token global não é uma conta: a cópia nasce
          // órfã, como em `create_virtual_mcp`.
          ownerUserUuid: userUuid,
        },
        SOURCE,
        actor,
      );

      return text(
        `MCP virtual clonado de "${origem.slug}": "${copia.name}" em /virtual/${copia.slug}/mcp, com ` +
          `${copia.skills.length} skill(s), ${copia.catalogs.length} catálogo(s) e ${copia.grants.length} ` +
          'concessão(ões). A cópia é sua e nasce fechada. As chaves psv_ não são copiadas: ela não tem ' +
          'chave nenhuma, e nada chega a ela até create_virtual_mcp_key emitir uma.',
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
      if (args.name !== undefined) assertNameFits(args.name, 'do MCP virtual', current.name);

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
      // A escrita relê na visão do admin: a contagem sai do que **esta**
      // credencial vê — número agregado também é alcance (`docs/12` §3.1).
      const seen = await getSkillSummary(detail.slug, { viewer });
      return text(
        `"${detail.slug}" publicada em "${current.slug}" como ${[
          args.asSkill && 'skill',
          args.asPrompt && 'prompt',
          args.asResource && 'resource',
        ]
          .filter(Boolean)
          .join(', ')}.${seen ? ` Agora está em ${seen.mcps.length} MCP(s) virtual(is) que esta credencial vê.` : ''}`,
      );
    },

    /** Desfaz o vínculo direto: `edit` no vMCP, nada na skill — é mexer só no servidor. */
    async unlink_skill(args: { skill: string; mcp: string }): Promise<ToolResult> {
      const current = await managed(args.mcp, 'edit');
      // Uma resposta só para "não existe" e "não está aqui". O banco distingue
      // as duas, e a diferença diria a quem edita um servidor qualquer quais
      // slugs de skill privada alheia existem (relatório 009 da auditoria de
      // 2026-09-19). `current.skills` são os vínculos diretos — o que sairia.
      if (!current.skills.some((skill) => skill.slug === args.skill)) {
        throw notFound(`A skill "${args.skill}" não está vinculada a este MCP virtual`);
      }
      const detail = await unlinkSkill(args.skill, current.uuid, SOURCE, actor);

      // O detalhe da escrita é a visão do admin: ele nomearia todo servidor em
      // que a skill continua, inclusive o fechado de terceiros. O texto conta só
      // o que esta credencial vê — e ela pode ter deixado de ver a própria skill.
      const seen = await getSkillSummary(detail.slug, { viewer });
      const onde = seen?.mcps.map((mcp) => mcp.slug) ?? [];
      const resto = !seen
        ? 'Esta credencial deixou de vê-la: ela só chegava aqui por este servidor.'
        : onde.length > 0
          ? `Continua em ${onde.join(', ')}.`
          : viewer.role === 'admin'
            ? 'Ficou sem vínculo: não é exibida em lugar nenhum.'
            : 'Não está em nenhum outro MCP virtual que esta credencial veja.';
      return text(`"${detail.slug}" saiu de "${current.slug}". ${resto}`);
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
      assertNameFits(name, 'da chave');

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
        targetLabel: keyLabel(current.slug, { name, prefix: generated.prefix }),
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

      // Pelo nome que a revogação devolve, e não pelo uuid da chave — que some
      // com o vMCP (`ON DELETE CASCADE`) e deixava a linha sem referente
      // (relatório 040 da auditoria de 2026-09-19).
      await recordAccountAudit({
        action: 'mcp.key.revoke',
        source: SOURCE,
        actor,
        targetLabel: keyLabel(current.slug, revoked),
      });
      return text(`Chave "${revoked.name}" (psv_${revoked.prefix}_…) revogada.`);
    },

    // ----------------------------------------------------------- acesso ---

    async share_mcp(args: { slug: string; username: string; level: string }): Promise<ToolResult> {
      const current = await managed(args.slug, 'manage');
      const target = await accountByUsername(args.username);
      const grant = await setVirtualMcpGrant(current.slug, target.uuid, levelFrom(args.level), SOURCE, actor);
      return text(`${grant.username} agora pode ${ACCESS_LABEL[grant.level]} o MCP virtual "${current.slug}".`);
    },

    /** Revogar vale para a conta em qualquer estado, inclusive desativada — ver `grantOf`. */
    async unshare_mcp(args: { slug: string; username: string }): Promise<ToolResult> {
      const current = await managed(args.slug, 'manage');
      const grant = grantOf(current.grants, args.username, 'neste MCP virtual');
      await removeVirtualMcpGrant(current.slug, grant.userUuid, SOURCE, actor);
      return text(`${grant.username} perdeu o acesso ao MCP virtual "${current.slug}".`);
    },

    async transfer_mcp(args: { slug: string; username: string }): Promise<ToolResult> {
      const current = await managed(args.slug, 'owner');
      const target = await accountByUsername(args.username);
      await updateVirtualMcp(current.uuid, { ownerUserUuid: target.uuid }, SOURCE, actor);
      return text(`O MCP virtual "${current.slug}" agora é de ${target.username}.`);
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

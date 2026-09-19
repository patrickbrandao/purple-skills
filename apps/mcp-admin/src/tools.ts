import { randomUUID } from 'node:crypto';
import {
  AppError,
  createSkill,
  deleteFile,
  deleteSkill,
  getSkillDetail,
  getVirtualMcp,
  listFiles,
  listSkills,
  listTags,
  readFile,
  recordSkillAccess,
  removeSkillGrant,
  setFile,
  setFiles,
  setSkillGrant,
  stats,
  updateSkill,
} from '@purple-skills/db';
import {
  ACCESS_LABEL,
  SKILL_MD,
  ZipError,
  canCreate,
  canManage,
  composeSkillMd,
  extractZip,
  isSkillMd,
  normalizeRelativePath,
  isAccessScope,
  readIntEnv,
  stripFrontmatter,
  type AccessLevel,
  type SkillSummary,
} from '@purple-skills/shared';
import { accountByEmail, assertAccess, levelFrom, loadSkill, viewerOf } from './access.js';
import { TOKEN_CALLER, type Caller } from './auth.js';
import { config } from './config.js';

/** Teto do payload base64 do `set_files_bulk` (~32 MB codificados). */
const MAX_ZIP_BASE64_CHARS = readIntEnv('MCP_MAX_ZIP_BASE64', 32 * 1024 * 1024, { min: 1024 });

const SOURCE = 'mcp-admin' as const;

export type ToolResult = {
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
 * Converte erros de domínio em resultados `isError` (o agente consegue ler a
 * mensagem e corrigir a chamada) e embrulha o que for imprevisto.
 *
 * `AppError` é erro de negócio — 400, 403, 404, 409 — escrito para o agente
 * ler, e continua chegando com a mensagem inteira: é o que deixa quem opera
 * corrigir a chamada. A mensagem de uma falha imprevista é o oposto: a do `pg`
 * cita tabela, índice e constraint, e quem lê aqui é um agente de IA, que pode
 * repetir o texto num resumo, num log ou numa issue pública. Então vale a
 * mesma política do `http.ts`: o detalhe vai para o log, a resposta é genérica
 * — com uma referência curta nos dois lados, para o operador casar a
 * reclamação do agente com a linha do log sem expor nada.
 */
export async function guard(run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof AppError) return fail(err.message);
    const ref = randomUUID().slice(0, 8);
    console.error(`[mcp-admin] erro inesperado (ref ${ref}):`, err);
    return fail(
      `Erro interno do servidor (ref ${ref}). Tente de novo; se persistir, passe esta ` +
        'referência a quem opera a instalação — o detalhe está no log do servidor.',
    );
  }
}

/**
 * A página no site existe quando a skill está ligada **e** é pública, ou está
 * em algum vMCP aberto e ligado, ou participa de catálogo público e ligado
 * (`docs/12-acesso-granular.md` §7 — revoga a regra do `09` §4.1, que era só
 * o vínculo aberto, de quando `is_public` não existia).
 *
 * O terceiro ramo fica sem sinal: `skill.catalogs` traz o estado do catálogo e
 * o da participação, não o `is_public` dele. Enquanto o banco não expuser um
 * `onSite` derivado de `OPEN_EXPOSURE`, essa skill segue sem link — errar para
 * menos (link ausente) é melhor que errar para mais (link para um 404).
 */
const pageUrl = (skill: SkillSummary): string | undefined =>
  skill.isActive && (skill.isPublic || skill.mcps.some((mcp) => mcp.isOpen && mcp.isActive))
    ? `${config.siteBaseUrl}/skills/${skill.slug}`
    : undefined;

/**
 * Os vínculos de uma skill, como as tools os mostram. `direct: false` é um
 * vMCP alcançado só por catálogo (`viaCatalogs`), com as portas do catálogo —
 * o vínculo direto, quando existe, sobrescreve (`docs/11-catalogos.md` §3.2).
 */
const mcpsOf = (skill: SkillSummary) =>
  skill.mcps.map((mcp) => ({
    slug: mcp.slug,
    name: mcp.name,
    isOpen: mcp.isOpen,
    isActive: mcp.isActive,
    isDefault: mcp.isDefault,
    asSkill: mcp.asSkill,
    asPrompt: mcp.asPrompt,
    asResource: mcp.asResource,
    direct: mcp.direct,
    viaCatalogs: mcp.catalogs.map((catalog) => catalog.slug),
  }));

/** Os catálogos de que a skill participa: o catálogo e a participação, ligados ou não. */
const catalogsOf = (skill: SkillSummary) =>
  skill.catalogs.map((catalog) => ({
    slug: catalog.slug,
    name: catalog.name,
    isActive: catalog.isActive,
    memberActive: catalog.memberActive,
  }));

/** Quantos caminhos a recusa do `set_files_bulk` lista antes de resumir o resto. */
const MAX_CAMINHOS_NA_RECUSA = 20;

/**
 * O que um `set_files_bulk` com `replace` removeria: o que já está gravado e
 * não veio no .zip.
 *
 * Repete a régua do `setFiles` no banco, que apaga por
 * `lower(relative_path) <> ALL(<caminhos enviados> + SKILL.md)`: a comparação
 * ignora a caixa e o SKILL.md nunca sai. `normalizeRelativePath` é aplicado de
 * novo porque o banco também o aplica — um `pasta/skill.md` que o `extractZip`
 * desembrulhou para `skill.md` só vira `SKILL.md` aí.
 *
 * É uma prévia, não uma garantia: a skill não fica trancada entre esta leitura
 * e a transação — um `SELECT … FOR UPDATE` em `skills` daria deadlock com o
 * gatilho `files_rag_stale_trg`. Serve para o agente decidir com a lista na
 * mão, e conferir o número na segunda chamada é o que recusa a remoção quando
 * a árvore mudou no meio.
 */
async function aRemover(
  skillUuid: string,
  enviados: readonly { relativePath: string }[],
): Promise<string[]> {
  const chegando = new Set(
    enviados.map((file) =>
      (normalizeRelativePath(file.relativePath) ?? file.relativePath).toLowerCase(),
    ),
  );
  const atuais = await listFiles(skillUuid);
  return atuais
    .map((file) => file.relativePath)
    .filter((path) => !isSkillMd(path) && !chegando.has(path.toLowerCase()));
}

/** A recusa da remoção: o que sairia e as duas saídas, com o número a repetir. */
function recusaDeRemocao(removidos: readonly string[], confirmado: number | undefined): string {
  const lista = removidos.slice(0, MAX_CAMINHOS_NA_RECUSA).map((path) => `- ${path}`);
  if (removidos.length > MAX_CAMINHOS_NA_RECUSA) {
    lista.push(`- … e outros ${removidos.length - MAX_CAMINHOS_NA_RECUSA}`);
  }

  return [
    confirmado === undefined
      ? `Este .zip removeria ${removidos.length} arquivo(s) que não estão nele:`
      : `confirm_deletions: ${confirmado} não corresponde — este .zip removeria ${removidos.length} arquivo(s):`,
    ...lista,
    'A remoção não se desfaz pela API: a auditoria registra cada caminho removido, com o ' +
      'conteúdo anterior dos arquivos de texto, mas quem reconstrói a árvore é você. Repita com ' +
      `confirm_deletions: ${removidos.length} para removê-los, ou com replace: false para apenas ` +
      'acrescentar e sobrescrever, sem remover nada.',
  ].join('\n');
}

/** Entrada de `create_skill.mcps`: o vMCP pelo slug e as três portas. */
type McpLinkArg = { slug: string; asSkill: boolean; asPrompt: boolean; asResource: boolean };

/** O que a tool mostra do acesso: o dono, se é pública e o que a credencial pode. */
const accessOf = (skill: SkillSummary) => ({
  owner: skill.ownerEmail,
  isPublic: skill.isPublic,
  access: skill.access,
});

/**
 * Handlers das ferramentas administrativas, testáveis sem transporte HTTP.
 *
 * São criados **por chamada**, com a credencial revalidada na requisição em
 * curso (`createMcpServer`): o papel decide se ele cria, o acesso por objeto
 * (`docs/12-acesso-granular.md`) decide o resto, e o ator, o IP e o agente vão
 * juntos para o `audit_log` e para o registro de acessos. Uma chave de
 * `membro` vê o que é seu, o que lhe foi concedido e o que é público, e
 * administra o que é seu.
 */
export function createHandlers(caller: Caller = TOKEN_CALLER) {
  const actor = caller.actor;
  const viewer = viewerOf(caller);

  /**
   * O registro por leitura (`docs/13-fichas-e-acessos.md`): `get_skill` por
   * uma chave `psk_` vira uma linha com a conta e a chave. O token global não
   * é uma conta e não entra — como o painel, é o operador lendo o próprio
   * acervo. Melhor esforço: uma falha vai para o log, não para a resposta.
   */
  const registrarLeitura = (skillUuid: string): void => {
    if (!actor.userUuid) return;
    Promise.resolve()
      .then(() =>
        recordSkillAccess({
          skillUuid,
          kind: 'view',
          surface: 'admin-tool',
          origin: 'mcp-admin',
          auth: 'user',
          userUuid: actor.userUuid ?? undefined,
          apiKeyId: caller.apiKeyId ?? undefined,
          ip: caller.ip,
          userAgent: caller.userAgent,
        }),
      )
      .catch((err: unknown) => {
        console.warn('[mcp-admin] não foi possível registrar o acesso:', (err as Error).message);
      });
  };

  /** `null` quando pode criar; um `ToolResult` de recusa quando não. */
  const denyCreate = (): ToolResult | null =>
    canCreate(caller.role)
      ? null
      : fail(
          `Criar skill exige papel "editor" ou "admin"; sua credencial é "${caller.role}". ` +
            'Um membro edita o que é seu ou lhe foi concedido, mas não cria.',
        );

  /** A skill com o nível mínimo da ação; 404 se a credencial não a vê. */
  const skillWith = (slug: string, minimum: AccessLevel | 'owner') => loadSkill(caller, slug, minimum);

  /**
   * Resolve a lista "publicar em" de `create_skill`: cada vMCP pelo slug, com
   * a mesma permissão de `set_virtual_mcp_skills` — `edit` no servidor. Um
   * que a credencial não edite recusa a criação inteira.
   */
  async function resolveLinks(entries: McpLinkArg[] | undefined) {
    const links = [];
    for (const entry of entries ?? []) {
      const mcp = await getVirtualMcp(entry.slug, { viewer });
      if (!mcp) throw new AppError(`MCP virtual não encontrado: "${entry.slug}"`, 404, 'not_found');
      assertAccess(mcp.access, 'edit', 'MCP virtual');
      if (!entry.asSkill && !entry.asPrompt && !entry.asResource) {
        throw new AppError(
          `"${entry.slug}": escolha ao menos uma superfície (asSkill, asPrompt ou asResource)`,
          400,
          'bad_request',
        );
      }
      links.push({
        virtualMcpUuid: mcp.uuid,
        asSkill: entry.asSkill,
        asPrompt: entry.asPrompt,
        asResource: entry.asResource,
      });
    }
    return links;
  }

  return {
    async list_skills(args: {
      query?: string;
      tag?: string;
      limit?: number;
      offset?: number;
      scope?: string;
    }): Promise<ToolResult> {
      const result = await listSkills({
        query: args.query ?? null,
        tag: args.tag ?? null,
        limit: args.limit ?? 50,
        offset: args.offset ?? 0,
        // O que a credencial enxerga, inclusive as flutuantes e desligadas:
        // é o painel do agente (`docs/12` §3.1).
        viewer,
        ...(isAccessScope(args.scope) ? { scope: args.scope } : {}),
        sort: args.query ? undefined : 'recent',
      });

      return asJson({
        total: result.total,
        // O teto real de `limit` é aplicado na query; devolvê-lo evita que o
        // agente calcule a paginação com um valor que não foi o usado.
        limit: result.limit,
        offset: result.offset,
        skills: result.items.map((skill) => ({
          slug: skill.slug,
          name: skill.name,
          description: skill.description,
          isActive: skill.isActive,
          ...accessOf(skill),
          mcps: mcpsOf(skill),
          catalogs: catalogsOf(skill),
          tags: skill.tags,
          files: skill.fileCount,
          views: skill.viewCount,
          downloads: skill.downloadCount,
          updatedAt: skill.updatedAt,
        })),
      });
    },

    async get_skill(args: { slug: string }): Promise<ToolResult> {
      const detail = await getSkillDetail(args.slug, { viewer });
      if (!detail) return fail(`Skill não encontrada: "${args.slug}"`);

      registrarLeitura(detail.uuid);

      return asJson({
        slug: detail.slug,
        name: detail.name,
        description: detail.description,
        isActive: detail.isActive,
        ...accessOf(detail),
        // A lista de concessões só para quem as administra (decisão 11).
        grants: canManage(detail.access)
          ? detail.grants.map((grant) => ({ email: grant.email, name: grant.name, level: grant.level }))
          : undefined,
        mcps: mcpsOf(detail),
        catalogs: catalogsOf(detail),
        tags: detail.tags,
        views: detail.viewCount,
        downloads: detail.downloadCount,
        url: pageUrl(detail),
        files: detail.files.map((file) => ({
          path: file.relativePath,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
          isText: file.isText,
        })),
        // Os metadados estão nos campos acima; aqui vai só o corpo do prompt.
        skillMd: stripFrontmatter(detail.skillMd),
      });
    },

    async get_file(args: { slug: string; path: string }): Promise<ToolResult> {
      const detail = await getSkillDetail(args.slug, { viewer });
      if (!detail) return fail(`Skill não encontrada: "${args.slug}"`);

      const path = normalizeRelativePath(args.path);
      if (!path) return fail(`Caminho inválido: "${args.path}"`);

      const file = await readFile(detail.uuid, path);
      if (!file) return fail(`Arquivo não encontrado em "${args.slug}": ${path}`);
      if (!file.isText) {
        return fail(`"${path}" é binário (${file.mimeType}, ${file.sizeBytes} bytes) e não pode ser lido como texto.`);
      }

      // O SKILL.md é montado na hora: o frontmatter sai dos metadados da skill.
      const content = file.buffer.toString('utf8');
      return text(isSkillMd(path) ? composeSkillMd(detail, content) : content);
    },

    async create_skill(args: {
      name: string;
      description?: string;
      icon?: string;
      skill_md_content: string;
      tags?: string[];
      slug?: string;
      mcps?: McpLinkArg[];
      is_public?: boolean;
    }): Promise<ToolResult> {
      const denied = denyCreate();
      if (denied) return denied;

      const detail = await createSkill(
        {
          name: args.name,
          slug: args.slug,
          description: args.description,
          icon: args.icon,
          isPublic: args.is_public === true,
          // Os metadados vêm dos campos; um frontmatter no corpo é descartado.
          skillMd: stripFrontmatter(args.skill_md_content),
          tags: args.tags,
          mcps: await resolveLinks(args.mcps),
        },
        SOURCE,
        actor,
      );

      const onde =
        detail.mcps.length > 0
          ? `publicada em ${detail.mcps.map((mcp) => mcp.slug).join(', ')}`
          : 'sem vínculo — use link_skill para publicá-la em um MCP virtual';
      const page = pageUrl(detail);
      return text(`Skill criada: "${detail.name}" (slug: ${detail.slug}, ${onde}).${page ? `\n${page}` : ''}`);
    },

    async edit_skill(args: {
      slug: string;
      name?: string;
      description?: string;
      icon?: string;
      tags?: string[];
      new_slug?: string;
      is_active?: boolean;
      is_public?: boolean;
    }): Promise<ToolResult> {
      // Nome, descrição, ícone e tags são `edit`; slug, estado e público são
      // `manage` (`docs/12` §3.2).
      const touchesProperties =
        args.new_slug !== undefined || args.is_active !== undefined || args.is_public !== undefined;
      const current = await skillWith(args.slug, touchesProperties ? 'manage' : 'edit');

      const detail = await updateSkill(
        current.slug,
        {
          name: args.name,
          description: args.description,
          // Omitido não mexe; vazio limpa. A forma (emoji ou URL) é conferida no banco.
          icon: args.icon === undefined ? undefined : args.icon.trim() || null,
          tags: args.tags,
          slug: args.new_slug,
          isActive: args.is_active,
          isPublic: args.is_public,
        },
        SOURCE,
        actor,
      );

      return text(
        `Skill atualizada: "${detail.name}" (slug: ${detail.slug}${detail.isActive ? '' : ', desligada — não é entregue em servidor nenhum'}${
          detail.isPublic ? ', pública' : ''
        }).`,
      );
    },

    async set_file(args: { slug: string; path: string; content: string }): Promise<ToolResult> {
      await skillWith(args.slug, 'edit');

      // Normaliza **antes** de decidir, como `get_file`: `isSkillMd` compara o
      // texto exato em minúsculas, então `"./SKILL.md"` não é o arquivo
      // principal para ele — mas `setFile` canoniza para `SKILL.md` na hora de
      // gravar. Decidir com o caminho cru gravava o frontmatter enviado na
      // linha do SKILL.md, e nem `edit` deveria mexer em metadados (é `manage`).
      const path = normalizeRelativePath(args.path);
      if (!path) return fail(`Caminho inválido: "${args.path}"`);

      // Gravar o SKILL.md não redefine os metadados da skill (isso é
      // edit_skill): o frontmatter enviado é descartado.
      const content = isSkillMd(path) ? stripFrontmatter(args.content) : args.content;
      const file = await setFile(args.slug, path, content, SOURCE, actor);
      return text(`Arquivo gravado em "${args.slug}": ${file.relativePath} (${file.sizeBytes} bytes).`);
    },

    async set_files_bulk(args: {
      slug: string;
      zip_base64: string;
      replace?: boolean;
      confirm_deletions?: number;
    }): Promise<ToolResult> {
      const skill = await skillWith(args.slug, 'edit');

      // Recusa antes de decodificar: o único teto até aqui era o limite do corpo
      // JSON (64 MB), e um .zip desse tamanho descomprime para muito mais.
      if (args.zip_base64.length > MAX_ZIP_BASE64_CHARS) {
        return fail(
          `zip_base64 grande demais (limite de ~${Math.round(MAX_ZIP_BASE64_CHARS / (1024 * 1024))} MB codificados).`,
        );
      }

      // `Buffer.from(..., 'base64')` nunca lança: bytes inválidos simplesmente
      // produzem um ZIP ilegível, tratado logo abaixo como erro de formato.
      const buffer = Buffer.from(args.zip_base64, 'base64');

      let extracted: ReturnType<typeof extractZip>;
      try {
        extracted = extractZip(buffer);
      } catch (err) {
        // Limite estourado ou arquivo ilegível são erros do payload enviado pelo
        // agente, não falhas do servidor: devolvemos a mensagem para ele corrigir.
        if (err instanceof ZipError) return fail(err.message);
        throw err;
      }
      if (extracted.length === 0) return fail('O .zip não contém nenhum arquivo aproveitável.');

      // `replace` (o padrão) trata o .zip como a árvore inteira: o que não veio
      // é apagado. Isso é o desejado num "substituir tudo" e catastrófico num
      // envio parcial, e o audit da escrita em massa não guarda o conteúdo (uma
      // linha `update`, com `previousContent: null`), então não há como desfazer.
      // Uma tool MCP não pergunta nada, então a confirmação só pode ser
      // argumento — e pedimos o **número** de arquivos a remover, não um
      // `confirm: true`, porque o acidente que se quer evitar é justamente o do
      // agente que não olhou a árvore: um booleano é o campo que ele preenche
      // por reflexo, enquanto o número só sai desta recusa (ou de `get_skill`).
      // De quebra, se a árvore mudar entre a recusa e a segunda chamada o número
      // deixa de bater e a remoção é recusada de novo, em vez de levar arquivo
      // que ninguém viu. Só o caso destrutivo pede confirmação: um .zip que não
      // remove nada continua passando na primeira chamada, como antes.
      const replace = args.replace !== false;
      const removidos = replace ? await aRemover(skill.uuid, extracted) : [];
      if (removidos.length > 0 && args.confirm_deletions !== removidos.length) {
        return fail(recusaDeRemocao(removidos, args.confirm_deletions));
      }

      let files: Awaited<ReturnType<typeof setFiles>>;
      try {
        files = await setFiles(
          args.slug,
          extracted.map((file) => ({
            relativePath: file.relativePath,
            // Um SKILL.md vindo do .zip entra só com o corpo: os metadados da
            // skill já cadastrada mandam.
            content: isSkillMd(file.relativePath)
              ? Buffer.from(stripFrontmatter(file.textContent ?? ''), 'utf8')
              : (file.binaryContent ?? Buffer.from(file.textContent ?? '', 'utf8')),
          })),
          SOURCE,
          // O zip representa o estado desejado completo da árvore (seção 4 das
          // decisões de arquitetura); passe replace: false para só adicionar.
          //
          // `expectedDeletions` refaz a conferência de `confirm_deletions`
          // **dentro** da transação, com a árvore travada: a contagem acima é
          // prévia (ela e a escrita são idas ao banco distintas), e é nessa
          // janela que outra aba, outro operador ou outra sessão MCP podiam
          // acrescentar arquivo que o .zip levaria sem ninguém ter visto.
          { replace, expectedDeletions: removidos.length },
          actor,
        );
      } catch (err) {
        // 409 nesta chamada é só a divergência da contagem — `setFiles` não tem
        // outro. A mensagem de negócio chega inteira (`tasks/031`); o que falta
        // nela é o próximo passo, e quem sabe qual é são as tools daqui.
        if (err instanceof AppError && err.status === 409) {
          return fail(
            `${err.message}.\n` +
              `Releia a árvore com get_skill (slug: "${args.slug}") e repita set_files_bulk com ` +
              'confirm_deletions igual ao número de arquivos que sairiam agora, ou com ' +
              'replace: false para só acrescentar e sobrescrever, sem remover nada.',
          );
        }
        throw err;
      }

      return text(
        `${extracted.length} arquivo(s) importado(s) para "${args.slug}".\n` +
          (removidos.length > 0 ? `${removidos.length} arquivo(s) removido(s), como confirmado.\n` : '') +
          `Árvore final (${files.length} arquivos):\n` +
          files.map((file) => `- ${file.relativePath}`).join('\n'),
      );
    },

    async delete_file(args: { slug: string; path: string }): Promise<ToolResult> {
      await skillWith(args.slug, 'edit');

      if (isSkillMd(args.path)) {
        return fail(`O arquivo ${SKILL_MD} não pode ser removido — use set_file para sobrescrevê-lo.`);
      }
      await deleteFile(args.slug, args.path, SOURCE, actor);
      return text(`Arquivo removido de "${args.slug}": ${args.path}`);
    },

    async delete_skill(args: { slug: string; confirm: boolean }): Promise<ToolResult> {
      // Apagar é do dono e do admin: nenhum nível de concessão chega lá.
      await skillWith(args.slug, 'owner');

      if (args.confirm !== true) {
        return fail('Passe confirm: true para confirmar a remoção definitiva da skill.');
      }
      await deleteSkill(args.slug, SOURCE, actor);
      return text(`Skill "${args.slug}" removida, junto com todos os seus arquivos.`);
    },

    // ---------------------------------------------------------- acesso ---

    async share_skill(args: { slug: string; email: string; level: string }): Promise<ToolResult> {
      const skill = await skillWith(args.slug, 'manage');
      const target = await accountByEmail(args.email);
      const grant = await setSkillGrant(skill.slug, target.uuid, levelFrom(args.level), SOURCE, actor);
      return text(`${grant.email} agora pode ${ACCESS_LABEL[grant.level]} a skill "${skill.slug}".`);
    },

    async unshare_skill(args: { slug: string; email: string }): Promise<ToolResult> {
      const skill = await skillWith(args.slug, 'manage');
      const target = await accountByEmail(args.email);
      await removeSkillGrant(skill.slug, target.uuid, SOURCE, actor);
      return text(`${target.email} perdeu o acesso à skill "${skill.slug}".`);
    },

    async transfer_skill(args: { slug: string; email: string }): Promise<ToolResult> {
      const skill = await skillWith(args.slug, 'owner');
      const target = await accountByEmail(args.email);
      await updateSkill(skill.slug, { ownerUserUuid: target.uuid }, SOURCE, actor);
      return text(`A skill "${skill.slug}" agora é de ${target.email}.`);
    },

    async list_tags(): Promise<ToolResult> {
      return asJson({ tags: await listTags({ viewer }) });
    },

    /**
     * Os números, recortados pelo que a credencial enxerga (`docs/12` §3.1) —
     * o mesmo recorte de `/api/stats` no painel, pelo mesmo motivo.
     *
     * `stats()` conta a instalação inteira, inclusive as contas, e não aceita
     * `viewer`: contagem agregada mora no SQL e é camada do dba. Até lá, uma
     * credencial que não é admin recebe o que dá para recortar com as funções
     * que já recebem `viewer`, mais `openSkills` — o número que o site mostra
     * a qualquer anônimo. Os de arquivos, visitas, downloads e flutuantes
     * dimensionariam o acervo privado, e os de contas são dado da instalação:
     * saem do corpo em vez de sair globais.
     */
    async get_stats(): Promise<ToolResult> {
      if (viewer.role === 'admin') return asJson(await stats());

      const [instalacao, skills, tags] = await Promise.all([
        stats(),
        listSkills({ viewer, limit: 1 }),
        listTags({ viewer }),
      ]);
      return asJson({ totalSkills: skills.total, openSkills: instalacao.openSkills, totalTags: tags.length });
    },
  };
}

export type Handlers = ReturnType<typeof createHandlers>;

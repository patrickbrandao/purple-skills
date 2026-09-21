import { randomUUID } from 'node:crypto';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import {
  AppError,
  getSkillDetail,
  getSkillSummary,
  listFiles,
  listPublishedSkills,
  listSkills,
  listSkillsManifest,
  listTags,
  readFile,
  readSkillMdBodies,
  SEARCH_QUERY_MAX_LENGTH,
  type SkillManifestEntry,
  type SkillManifestFile,
  type VirtualMcpRuntime,
} from '@purple-skills/db';
import {
  SKILL_MD,
  composeSkillMd,
  frontmatterObject,
  isSkillMd,
  normalizeRelativePath,
  readIntEnv,
  stripFrontmatter,
  type SkillDetail,
  type SkillFileMeta,
  type SkillSummary,
} from '@purple-skills/shared';
import { logDaBusca } from '@purple-skills/rag';
import { config } from './config.js';
import { buscaSemantica } from './rag.js';
import { registrarAcesso, type AccessContext } from './access.js';
import { cacheDeDigesto, medirSkillMd, type SkillMdMedido } from './digest.js';

export type ToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};

const text = (value: string): ToolResult => ({ content: [{ type: 'text', text: value }] });
const fail = (message: string): ToolResult => ({
  content: [{ type: 'text', text: message }],
  isError: true,
});
const asJson = (value: unknown): ToolResult => text(JSON.stringify(value, null, 2));

/**
 * Loga o detalhe de uma falha imprevista e devolve a mensagem que vai ao
 * cliente, com a **mesma** referência curta nos dois lados.
 *
 * A mensagem de uma exceção não prevista é escrita para quem opera, não para
 * quem chama: a do `pg` cita tabela, índice e constraint. Aqui quem lê é um
 * agente de IA — anônimo por padrão, neste servidor — que pode repetir o texto
 * num resumo, num log ou numa issue pública. Então vale a política do
 * `http.ts`: resposta genérica, detalhe no log, e a referência para o operador
 * casar a reclamação do agente com a linha do log sem expor nada.
 */
function erroInterno(err: unknown): string {
  const ref = randomUUID().slice(0, 8);
  console.error(`[mcp-public] erro inesperado (ref ${ref}):`, err);
  return (
    `Erro interno do servidor (ref ${ref}). Tente de novo; se persistir, passe esta ` +
    'referência a quem opera a instalação — o detalhe está no log do servidor.'
  );
}

/**
 * Embrulha o handler de uma tool. Toda tool é registrada por ele (`server.ts`):
 * sem isso a exceção sobe ao `McpServer`, que monta o `isError` com a `message`
 * crua — é o mesmo defeito que o `guard` do mcp-admin fechou.
 *
 * Nada de útil é engolido. `AppError` é erro de negócio — 400, 403, 404, 409 —
 * escrito para o agente ler, e continua chegando com a mensagem inteira (o
 * `badRequest` do `semanticScope` chega por aqui). As recusas das próprias
 * ferramentas — skill fora do vínculo, caminho inválido, arquivo ausente — já
 * são `fail` dentro do handler, e não exceção; a validação dos argumentos é do
 * Zod e acontece no SDK, antes daqui; e a perna semântica nunca lança, por
 * desenho (`rag.ts`).
 */
export async function guard(run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof AppError) return fail(err.message);
    return fail(erroInterno(err));
  }
}

/**
 * O mesmo cuidado nas superfícies de prompt e resource, que respondem com erro
 * de protocolo em vez de resultado: o SDK monta o erro do JSON-RPC com a
 * `message` da exceção, então uma falha do banco vazaria pelo mesmo caminho.
 *
 * `McpError` é a recusa escrita para o cliente (`naoEncontrado`) e passa
 * inteira; `AppError` vira `InvalidParams`, que é o que o cliente pode
 * corrigir.
 */
export async function guardSurface<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof McpError) throw err;
    if (err instanceof AppError) throw new McpError(ErrorCode.InvalidParams, err.message);
    throw new McpError(ErrorCode.InternalError, erroInterno(err));
  }
}

/**
 * O MCP virtual em que as ferramentas estão rodando.
 *
 * Sempre há um: a raiz (`/mcp`) é o vMCP padrão da instalação, e
 * `/virtual/<slug>` é qualquer outro (`docs/09-mcp-padrao-e-skills-flutuantes.md`).
 * Toda leitura é recortada pelo vínculo `virtual_mcp_skills` — que traz skill
 * privada — e os downloads apontam para o próprio servidor, sob o caminho por
 * onde ele foi chamado (`docs/08-mcp-virtual.md` §3, §4).
 */
export type VirtualScope = {
  mcp: VirtualMcpRuntime;
  /** Base pública deste ponto de montagem: `<origem>` na raiz, `<origem>/virtual/<slug>` nos demais, sem barra final. */
  baseUrl: string;
  /** Quem está lendo, para o registro de acessos; ausente nos testes e conta como "aberto". */
  access?: AccessContext;
};

const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

/**
 * O site mostra a skill quando ela está ligada **e** é pública, ou está em vMCP
 * aberto e ligado, ou participa de catálogo público e ligado
 * (`docs/12-acesso-granular.md` §7 — revoga a regra do `09` §4.1, que era só o
 * vínculo aberto, de quando `is_public` não existia). Aqui `is_active` é dado:
 * o recorte do vínculo já exige a skill ligada.
 *
 * O terceiro ramo fica sem sinal: nesta visibilidade o `catalogs` da skill vem
 * vazio, e o `catalogs` de cada vMCP diz por qual catálogo ela chega ao
 * servidor, não se esse catálogo é público. Enquanto o banco não expuser um
 * `onSite` derivado de `OPEN_EXPOSURE`, essa skill segue sem link — errar para
 * menos (link ausente) é melhor que errar para mais (link para um 404).
 */
const noSite = (skill: SkillSummary) =>
  skill.isPublic || skill.mcps.some((mcp) => mcp.isOpen && mcp.isActive);

/**
 * As URLs que as ferramentas devolvem.
 *
 * Download e arquivo apontam para o mcp-public, que os serve com a mesma
 * credencial do MCP — uma skill que só existe em vMCP fechado não está no
 * site. A página é do site, e só quando a skill está lá.
 */
function urlsFor(scope: VirtualScope) {
  const base = scope.baseUrl;
  return {
    page: (skill: SkillSummary): string | undefined =>
      noSite(skill) ? `${config.siteBaseUrl}/skills/${skill.slug}` : undefined,
    download: (slug: string) => `${base}/skills/${encodeURIComponent(slug)}/download`,
    file: (slug: string, path: string) =>
      `${base}/skills/${encodeURIComponent(slug)}/files/${encodePath(path)}`,
    downloadHint: scope.mcp.isOpen
      ? 'Baixe com: curl -L -o skill.zip "<downloadUrl>"'
      : 'Baixe com a mesma chave deste MCP: ' +
        'curl -L -H "Authorization: Bearer <chave>" -o skill.zip "<downloadUrl>"',
  };
}

/**
 * O recorte de toda leitura das ferramentas: o vínculo com `as_skill`, e nada
 * mais — nem `is_public`, nem qualquer flag da skill (`08` §3.2).
 *
 * O filtro é da consulta e não daqui: `search_skills` pagina, e um descarte
 * pós-consulta furaria o `total` e a página; a contagem de `list_tags` não
 * pode somar skill que nenhuma ferramenta mostra.
 */
const recorteDasFerramentas = (scope: VirtualScope) =>
  ({ virtualMcp: { uuid: scope.mcp.uuid, surface: 'skill' } }) as const;

/**
 * A consulta como as **duas** pernas da busca vão lê-la.
 *
 * O teto é o `SEARCH_QUERY_MAX_LENGTH` do `@purple-skills/db` — o mesmo número
 * em que o `normalizeQuery` de lá corta a perna textual, importado e não
 * repetido: uma cópia local aqui e outra no site deixavam quem mudasse o número
 * no banco sem efeito nenhum, e quem o mudasse só nos apps com as duas pernas
 * lendo perguntas diferentes (relatório 037 da auditoria de 2026-09-19). O que
 * os apps **não** compartilham com o banco é o algoritmo: o corte daqui é mais
 * cuidadoso (fronteira de palavra, par surrogate) e vem antes.
 *
 * `listSkills` já cortava em 200 caracteres, mas o embedding era resolvido
 * antes, com o texto cru: a perna vetorial embutia uma pergunta que a textual
 * nunca leu, e quem escolhia o tamanho do que ia ao provedor — pago, e que no
 * nível gratuito do Google é lido por revisores humanos — era o visitante
 * anônimo. Normalizar aqui, uma vez, resolve as duas coisas.
 *
 * Conta caractere e não byte, pelo mesmo motivo de ser um número só: contar
 * byte encurtaria a consulta a cada acento, e uma frase em português perderia
 * palavras que a mesma frase em inglês manteria.
 *
 * E corta na fronteira de palavra: termo partido é pior que termo ausente —
 * `websearch_to_tsquery` junta os termos com AND, então uma palavra que ninguém
 * escreveu zera a perna textual, além de embutir no vetor um pedaço de palavra.
 */
function consultaDaBusca(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const texto = raw.trim();
  if (texto === '') return null;
  if (texto.length <= SEARCH_QUERY_MAX_LENGTH) return texto;

  // O caractere a mais revela se o limite cai dentro de uma palavra; `\S*$`
  // tira a palavra partida e o `trimEnd`, o espaço que sobra.
  const naFronteira = texto.slice(0, SEARCH_QUERY_MAX_LENGTH + 1).replace(/\S*$/, '').trimEnd();
  if (naFronteira !== '') return naFronteira;

  // Consulta sem espaço nenhum (um blob colado): corta no limite, sem deixar
  // sozinha a metade alta de um par surrogate — ela viraria U+FFFD no JSON do
  // provedor.
  const duro = texto.slice(0, SEARCH_QUERY_MAX_LENGTH);
  const ultimo = duro.charCodeAt(duro.length - 1);
  return ultimo >= 0xd800 && ultimo <= 0xdbff ? duro.slice(0, -1) : duro;
}

/**
 * Teto do texto que as leituras devolvem **dentro** da resposta — as quatro:
 * `get_skill_file`, `get_skill`, `prompts/get` e `resources/read`.
 *
 * O arquivo já chega inteiro do banco, mas devolvê-lo como texto custa outras
 * duas cópias — a string UTF-16 e o JSON-RPC da resposta —, e um arquivo de
 * skill pode ser enorme (`ZIP_MAX_UNCOMPRESSED_BYTES` são 256 MB). Acima do
 * teto a resposta passa a ser a URL de download, exatamente como já acontece com
 * arquivo binário. Quatro MiB de texto são muitas vezes a janela de qualquer
 * agente: o teto não corta leitura útil, corta o pedido que derruba o processo.
 *
 * O SKILL.md não é exceção: nada limita o tamanho dele por skill (o "sem limite
 * por skill" do `docs/02` é decisão de armazenamento, não de resposta), e o
 * teto nasceu só em `get_skill_file` — o mesmo byte tinha teto por uma porta e
 * não tinha pelas outras três (relatório 032 da auditoria de 2026-09-19).
 */
const MAX_TEXTO_INLINE_BYTES = readIntEnv('MCP_MAX_FILE_TEXT_BYTES', 4 * 1024 * 1024, {
  min: 1024,
});

/**
 * Bytes UTF-8 do SKILL.md gravado quando ele passa do teto, ou `null` quando
 * cabe. Mede o texto **lido**, nunca o `sizeBytes` declarado — a lição do `004`
 * —, e mede o que está gravado, antes de tirar ou montar frontmatter: é a mesma
 * régua de `get_skill_file`, então a skill que uma porta recusa as outras três
 * recusam também, e nenhuma cópia a mais nasce só para ser medida.
 */
const excedeTetoInline = (skillMd: string): number | null => {
  const bytes = Buffer.byteLength(skillMd, 'utf8');
  return bytes > MAX_TEXTO_INLINE_BYTES ? bytes : null;
};

/**
 * Handlers das ferramentas do MCP público. Ficam separados do registro no
 * servidor para poderem ser testados sem subir o transporte HTTP, e são
 * criados **por escopo**: cada vMCP — inclusive o padrão, na raiz — tem o seu.
 */
export function createHandlers(scope: VirtualScope) {
  const recorte = recorteDasFerramentas(scope);
  const urls = urlsFor(scope);

  return {
    async search_skills(args: {
      query?: string;
      tag?: string;
      limit?: number;
      offset?: number;
    }): Promise<ToolResult> {
      // Uma normalização só, antes das duas pernas: o vetor e o texto precisam
      // ler a mesma pergunta (ver `consultaDaBusca`).
      const query = consultaDaBusca(args.query);
      // A perna vetorial é resolvida antes da consulta: falha ou prazo estourado
      // devolvem `undefined` e a busca sai textual, sem erro para o cliente.
      const { semantic } = await buscaSemantica.resolver(query);

      const result = await listSkills({
        query,
        tag: args.tag ?? null,
        limit: args.limit ?? 10,
        offset: args.offset ?? 0,
        ...recorte,
        ...(semantic ? { semantic } : {}),
      });

      // As distâncias vão para o log, não para o cliente (§8.1 item 7).
      if (result.mode === 'hybrid') console.log(logDaBusca(result.mode, result.neighbors));

      if (result.items.length === 0) {
        return text(
          // A consulta ecoada é a normalizada: é o que foi procurado, e é
          // assim que o cliente descobre que a dele foi cortada.
          `Nenhuma skill encontrada${query ? ` para "${query}"` : ''}${
            args.tag ? ` na tag "${args.tag}"` : ''
          }.`,
        );
      }

      return asJson({
        mode: result.mode,
        total: result.total,
        limit: result.limit,
        offset: result.offset,
        results: result.items.map((skill) => ({
          slug: skill.slug,
          name: skill.name,
          description: skill.description,
          tags: skill.tags,
          score: skill.score,
          files: skill.fileCount,
          url: urls.page(skill),
        })),
      });
    },

    /** Retorna o SKILL.md completo. Conta um acesso no vínculo e na skill. */
    async get_skill(args: { slug: string }): Promise<ToolResult> {
      const detail = await getSkillDetail(args.slug, recorte);
      if (!detail) return fail(`Skill não encontrada: "${args.slug}"`);

      const attachments = detail.files.filter(
        (file) => file.relativePath.toLowerCase() !== 'skill.md',
      );
      const page = urls.page(detail);

      const header = [
        `# ${detail.name}`,
        detail.description && `\n${detail.description}`,
        `\nslug: ${detail.slug}`,
        detail.tags.length > 0 && `tags: ${detail.tags.join(', ')}`,
        page && `página: ${page}`,
        `download (zip): ${urls.download(detail.slug)}`,
        attachments.length > 0 &&
          `\nArquivos anexados (use get_skill_file para ler):\n${attachments
            .map((file) => `- ${file.relativePath} (${file.mimeType}, ${file.sizeBytes} bytes)`)
            .join('\n')}`,
        '\n---\n',
      ]
        .filter(Boolean)
        .join('\n');

      // SKILL.md grande demais para o resultado: vão os metadados e o link, como
      // em `get_skill_file`. Sem `registrarAcesso` — leitura que não entregou o
      // texto não é visualização, e quem seguir o link conta na rota do arquivo
      // (`downloads.ts`); contar aqui também daria duas por leitura.
      const excedeu = excedeTetoInline(detail.skillMd);
      if (excedeu !== null) {
        return text(
          `${header}\nO SKILL.md desta skill é grande demais para vir no resultado ` +
            `(${excedeu} bytes; o teto é ${MAX_TEXTO_INLINE_BYTES}). ` +
            `Baixe pela URL: ${urls.file(detail.slug, SKILL_MD)}`,
        );
      }

      registrarAcesso(scope, detail.uuid, 'view', 'tool');

      return text(`${header}\n${stripFrontmatter(detail.skillMd)}`);
    },

    /** Lê um arquivo anexado da skill. Não conta acesso (só o SKILL.md conta). */
    async get_skill_file(args: { slug: string; path: string }): Promise<ToolResult> {
      const skill = await getSkillSummary(args.slug, recorte);
      if (!skill) return fail(`Skill não encontrada: "${args.slug}"`);

      const path = normalizeRelativePath(args.path);
      if (!path) return fail(`Caminho inválido: "${args.path}"`);

      const file = await readFile(skill.uuid, path);
      if (!file) return fail(`Arquivo não encontrado em "${args.slug}": ${path}`);

      if (!file.isText) {
        return text(
          `O arquivo "${path}" é binário (${file.mimeType}, ${file.sizeBytes} bytes). ` +
            `Baixe pela URL: ${urls.file(skill.slug, path)}`,
        );
      }

      // Texto grande demais para o resultado da ferramenta: a URL de download
      // serve o arquivo sem as cópias que o JSON-RPC exigiria — a rota faz
      // `readFile` + `res.send`, o `Buffer` lido e mais nada; quem sai em fluxo é
      // o `.zip` (`zip.ts`), não o arquivo avulso. O tamanho é o dos bytes lidos,
      // não o `sizeBytes` gravado — a lição do `004` é não decidir limite por
      // número declarado.
      if (file.buffer.byteLength > MAX_TEXTO_INLINE_BYTES) {
        return text(
          `O arquivo "${path}" é grande demais para vir no resultado ` +
            `(${file.buffer.byteLength} bytes; o teto é ${MAX_TEXTO_INLINE_BYTES}). ` +
            `Baixe pela URL: ${urls.file(skill.slug, path)}`,
        );
      }

      // O SKILL.md é montado na hora: o frontmatter sai dos metadados da skill.
      const content = file.buffer.toString('utf8');
      return text(isSkillMd(path) ? composeSkillMd(skill, content) : content);
    },

    /** Devolve a URL de download; o zip é gerado quando ela é seguida. */
    async download_skill(args: { slug: string }): Promise<ToolResult> {
      const skill = await getSkillSummary(args.slug, recorte);
      if (!skill) return fail(`Skill não encontrada: "${args.slug}"`);

      return asJson({
        slug: skill.slug,
        name: skill.name,
        downloadUrl: urls.download(skill.slug),
        format: 'zip',
        files: skill.fileCount,
        hint: urls.downloadHint,
      });
    },

    async list_tags(): Promise<ToolResult> {
      const tags = await listTags(recorte);
      if (tags.length === 0) return text('Nenhuma tag cadastrada.');
      return asJson({ tags });
    },
  };
}

export type Handlers = ReturnType<typeof createHandlers>;

// ------------------------------------------- prompts e resources -----------

/**
 * Esquema das URIs desta instalação, no endereço que a SEP-2640 define
 * (`docs/17-skills-extension.md` §4.1): cada **arquivo** da skill é um resource,
 * e o último segmento do caminho da skill é o `name` do frontmatter — que aqui
 * é o slug, por construção.
 *
 * ```
 * skill://<slug>/SKILL.md      o SKILL.md
 * skill://<slug>/<caminho>     um arquivo de apoio
 * skill://<slug>               o diretório-raiz
 * skill://<slug>/<sub>         um subdiretório
 * ```
 *
 * `skill://<slug>` **deixou de ser o SKILL.md** e passou a ser o diretório
 * (decisão 5, que revoga a decisão 5 do `docs/06`): sob a SEP a raiz da skill é
 * um diretório, e conviver com o significado antigo faria a mesma URI ser
 * arquivo numa porta e diretório na outra.
 */
const RESOURCE_SCHEME = 'skill://';

/** Uma URI desta instalação: a skill e, dentro dela, um arquivo — ou o diretório, no caminho vazio. */
export type SkillUriAlvo = { slug: string; path: string };

/**
 * Monta a URI de um arquivo da skill; sem caminho, a do diretório-raiz, sem
 * barra final, como a SEP escreve diretório.
 *
 * A codificação é **por segmento**, e não do caminho inteiro, para que `#`, `?`
 * ou espaço num nome de arquivo sobrevivam à ida e à volta sem cortar a URI
 * (o `/` continua sendo separador, não conteúdo). Para o slug, que é `a-z0-9-`,
 * a codificação é identidade; fica assim mesmo, por simetria com a análise.
 */
export function skillUri(slug: string, path = ''): string {
  const segmentos = path === '' ? [slug] : [slug, ...path.split('/')];
  return `${RESOURCE_SCHEME}${segmentos.map(encodeURIComponent).join('/')}`;
}

/**
 * O par de `skillUri`: devolve a skill e o caminho, ou `null` quando a URI não
 * é desta instalação — esquema errado, percentual malformado, travessia de
 * diretório, caminho que o `normalizeRelativePath` recusa. Quem chama responde
 * a **mesma** recusa indistinta de sempre (`§5.5` do `docs/06`), sem dizer qual
 * dos casos foi.
 */
export function parseSkillUri(uri: string): SkillUriAlvo | null {
  if (typeof uri !== 'string' || !uri.startsWith(RESOURCE_SCHEME)) return null;

  let segmentos: string[];
  try {
    segmentos = uri.slice(RESOURCE_SCHEME.length).split('/').map(decodeURIComponent);
  } catch {
    // `%zz` e companhia: o `decodeURIComponent` lança em vez de devolver nada.
    return null;
  }

  const [slug, ...resto] = segmentos;
  if (!slug) return null;

  // `skill://<slug>` e `skill://<slug>/` são a raiz — o caminho vazio.
  const caminho = resto.join('/');
  if (caminho === '') return { slug, path: '' };

  const path = normalizeRelativePath(caminho);
  return path ? { slug, path } : null;
}

/**
 * Mesma recusa para skill fora do vínculo, inexistente e vinculada sem a flag
 * da superfície: distingui-las entregaria slugs a quem sonda um servidor que
 * pode estar aberto.
 */
const naoEncontrado = (mensagem: string) => new McpError(ErrorCode.InvalidParams, mensagem);

/** Um arquivo no manifesto de uma entrada: a URI, o digest dos bytes servidos e o tamanho deles. */
type RecursoDaEntrada = { uri: string; digest: string; size: number };

/**
 * A entrada de uma skill, igual em `skills/list` e em `skills/get` (§6.2 do
 * `docs/17-skills-extension.md`): a URI do `SKILL.md`, o frontmatter como JSON e
 * o inventário **completo** dos arquivos — ou o marcador `"dynamic"`, quando o
 * manifesto não pode ser verificável.
 */
type EntradaDeSkill = {
  uri: string;
  frontmatter: Record<string, unknown>;
  resources: RecursoDaEntrada[] | 'dynamic';
};

/** A skill que tem o que publicar: a linha do `SKILL.md` é a URI da entrada. */
type SkillPublicavel = { skill: SkillManifestEntry; skillMd: SkillManifestFile };

/**
 * Mede o `SKILL.md` **composto**, que é o que o `resources/read` devolve.
 *
 * O frontmatter remontado acrescenta bytes, então um corpo que cabia no teto
 * pode não caber depois de composto — e a entrada só é verificável quando a
 * leitura entrega o mesmo conteúdo (decisão 25).
 */
const medirComposto = (skill: SkillManifestEntry, corpo: string): SkillMdMedido => {
  const medida = medirSkillMd(composeSkillMd(skill, corpo));
  return medida.size > MAX_TEXTO_INLINE_BYTES ? 'dynamic' : medida;
};

/**
 * Monta as entradas de um manifesto, com uma consulta de corpo só para os furos
 * do cache — é o que impede `skills/list` de ler todo `SKILL.md` do vMCP a cada
 * chamada (decisão 24; num vMCP aberto não há credencial que segure a repetição).
 *
 * A ordem é a que vem do banco (por slug) e não é refeita aqui: lista
 * reembaralhada entre duas chamadas é ruído para quem compara.
 */
async function entradasDoManifesto(skills: SkillManifestEntry[]): Promise<EntradaDeSkill[]> {
  const publicaveis: SkillPublicavel[] = [];
  for (const skill of skills) {
    const skillMd = skill.files.find((file) => isSkillMd(file.relativePath));
    // Skill sem linha de `SKILL.md` não é publicável: a entrada da SEP **é** a
    // URI do SKILL.md, e a leitura dela não teria o que devolver. Fica fora da
    // listagem, em vez de entrar quebrada.
    if (skillMd) publicaveis.push({ skill, skillMd });
  }

  const medidas = new Map<string, SkillMdMedido>();
  const furos: SkillPublicavel[] = [];
  for (const { skill, skillMd } of publicaveis) {
    const conhecida = cacheDeDigesto.ler(skill.uuid, skill.updatedAt);
    if (conhecida) {
      medidas.set(skill.uuid, conhecida);
      continue;
    }

    // O corpo sozinho já passa do teto: o composto passa também, e a leitura o
    // recusaria. **Não ler é o ponto** — hashear 200 MB para publicar o digest
    // de algo que o `resources/read` recusa em seguida é carregar o arquivo à
    // toa, a pedido de quem quiser, num servidor que pode estar aberto (§5.4).
    if (skillMd.sizeBytes > MAX_TEXTO_INLINE_BYTES) {
      medidas.set(skill.uuid, cacheDeDigesto.guardar(skill.uuid, skill.updatedAt, 'dynamic'));
      continue;
    }

    furos.push({ skill, skillMd });
  }

  if (furos.length > 0) {
    const corpos = new Map(
      // Sem ordem definida: o lote é fatiado no banco, e o casamento é pelo uuid.
      (await readSkillMdBodies(furos.map(({ skill }) => skill.uuid))).map((linha) => [
        linha.skillUuid,
        linha.body,
      ]),
    );
    for (const { skill } of furos) {
      const corpo = corpos.get(skill.uuid);
      // Corpo que não veio é `SKILL.md` gravado como binário (ou apagado entre
      // as duas consultas): não dá para compor, e publicar digest de uma
      // composição que ninguém mediu é exatamente a falha silenciosa da §5.2.
      const medida = corpo === undefined ? 'dynamic' : medirComposto(skill, corpo);
      medidas.set(skill.uuid, cacheDeDigesto.guardar(skill.uuid, skill.updatedAt, medida));
    }
  }

  return publicaveis.map(({ skill, skillMd }) =>
    // O `?? 'dynamic'` não tem caso: toda publicável passou por uma das pernas
    // acima. Se um dia tiver, publicar manifesto sem medida é que seria errado.
    entradaDaSkill(skill, skillMd, medidas.get(skill.uuid) ?? 'dynamic'),
  );
}

/**
 * A entrada de uma skill. O digest dos arquivos de apoio vem pronto do banco —
 * é o `content_sha256` da `020`, dos mesmos bytes que a leitura devolve —, e o
 * do `SKILL.md` **não**: aquele hash é o do corpo gravado, sem frontmatter, e
 * publicá-lo faria toda skill falhar na verificação de todo host, em silêncio
 * (§5.2). Por isso ele chega medido de fora, do composto.
 */
function entradaDaSkill(
  skill: SkillManifestEntry,
  skillMd: SkillManifestFile,
  medida: SkillMdMedido,
): EntradaDeSkill {
  return {
    uri: skillUri(skill.slug, skillMd.relativePath),
    // O espelho do YAML que o `resources/read` devolve, montado da mesma fonte
    // (`frontmatterObject`, no shared): a SEP exige identidade campo a campo.
    frontmatter: frontmatterObject(skill),
    resources:
      medida === 'dynamic'
        ? 'dynamic'
        : skill.files.map((file) => ({
            uri: skillUri(skill.slug, file.relativePath),
            ...(isSkillMd(file.relativePath)
              ? medida
              : { digest: `sha256:${file.sha256}`, size: file.sizeBytes }),
          })),
  };
}

/** Um filho de diretório, na forma de `Resource` que a SEP devolve no `directory/read`. */
type FilhoDeDiretorio = { uri: string; name: string; mimeType: string };

/** O mimeType que marca diretório, na SEP e no resto do mundo POSIX. */
const MIME_DIRETORIO = 'inode/directory';

/**
 * Os filhos **diretos** de um diretório da skill, derivados em TypeScript da
 * lista de arquivos (decisão 11) — nada de consulta por prefixo, que neste
 * repositório é terreno da armadilha do `LIKE` (`_` e `%` num nome de arquivo
 * são literais). Aqui a comparação é exata, em memória, sobre caminhos vindos
 * da mesma tabela.
 *
 * Exata inclusive na caixa, e é uma escolha: as URIs que este servidor publica
 * carregam a grafia gravada, e os 409 de árvore do `createFile` impedem duas
 * entradas que só diferem na caixa — então comparar exato não esconde irmão
 * nenhum. A leitura de arquivo, que compara com `lower()`, é mais tolerante
 * que isto; o preço é um `-32602` para quem digita o diretório com outra caixa.
 *
 * `null` = o diretório não existe (nenhum arquivo sob o prefixo). A raiz de uma
 * skill válida sempre existe, mesmo vazia — é o diretório da skill.
 */
function filhosDiretos(
  slug: string,
  dir: string,
  arquivos: SkillFileMeta[],
): FilhoDeDiretorio[] | null {
  const prefixo = dir === '' ? '' : `${dir}/`;
  const porNome = new Map<string, FilhoDeDiretorio>();

  for (const arquivo of arquivos) {
    if (!arquivo.relativePath.startsWith(prefixo)) continue;
    const resto = arquivo.relativePath.slice(prefixo.length);
    if (resto === '') continue;

    const corte = resto.indexOf('/');
    const nome = corte < 0 ? resto : resto.slice(0, corte);
    if (porNome.has(nome)) continue;

    porNome.set(
      nome,
      corte < 0
        ? { uri: skillUri(slug, arquivo.relativePath), name: nome, mimeType: arquivo.mimeType }
        : { uri: skillUri(slug, `${prefixo}${nome}`), name: nome, mimeType: MIME_DIRETORIO },
    );
  }

  if (prefixo !== '' && porNome.size === 0) return null;

  // Ordem por nome, comparando unidade de código — e não `localeCompare`, que
  // depende do locale do processo: o mesmo diretório tem de listar igual em
  // qualquer instalação. Arquivo e subdiretório entram na mesma ordenação; um
  // critério só é mais fácil de prever que dois.
  return [...porNome.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * As superfícies em que uma skill é oferecida além das ferramentas: *prompt*
 * (pelo slug), *resource* (`skill://<slug>/SKILL.md` e os arquivos de apoio) e
 * a extensão de skills do MCP — `skills/list`, `skills/get` e
 * `resources/directory/read` (SEP-2640, `docs/17-skills-extension.md`).
 *
 * Quem decide o que cada uma enxerga é o vínculo, e são portas diferentes:
 * `as_prompt` e `as_resource` valem para as duas primeiras, e `as_skill` — a
 * mesma porta das ferramentas — governa a extensão, a leitura de arquivo de
 * apoio e a leitura de diretório (§4.2 do `17`). O `SKILL.md` é a exceção
 * deliberada: legível pelas **duas** portas, senão `skills/list` anunciaria uma
 * URI que o `resources/read` recusa.
 *
 * As listas saem do banco a **cada requisição**. Não há `listChanged` para
 * avisar o cliente, então uma skill vinculada agora precisa aparecer na
 * listagem seguinte, mesmo numa sessão aberta antes dela existir.
 */
export function createSurfaces(scope: VirtualScope) {
  const mcpUuid = scope.mcp.uuid;
  const urls = urlsFor(scope);

  /** A skill oferecida na superfície, ou nada — a consulta já filtra pelo vínculo. */
  const skillPublicada = (
    slug: string,
    surface: 'prompt' | 'resource' | 'skill',
  ): Promise<SkillDetail | null> =>
    getSkillDetail(slug, { virtualMcp: { uuid: mcpUuid, surface } });

  /**
   * Os campos de cache da revisão **2026-07-28** do protocolo (decisões 17 a
   * 19). O SDK 1.30.0 fala `2025-11-25` e não os tem, então eles vão escritos à
   * mão no resultado; são aditivos e inofensivos para cliente antigo.
   *
   * `ttlMs` é **zero**, e o valor não é detalhe: a `§5.2` do `docs/06` recusou
   * declarar `listChanged` justamente para não autorizar um cliente a cachear
   * pela sessão inteira uma lista que muda sem aviso. `ttlMs` é a mesma promessa
   * com número — zero é conformante e é verdade, porque a lista é recomputada a
   * cada requisição, e é por isso que um vínculo criado há um segundo aparece na
   * chamada seguinte.
   *
   * `cacheScope` sai de `is_open`: num vMCP aberto a listagem já é pública por
   * construção; num fechado, um intermediário compartilhado não pode servi-la a
   * quem não tem chave.
   */
  const camposDeCache = () =>
    ({
      resultType: 'complete',
      ttlMs: 0,
      cacheScope: scope.mcp.isOpen ? 'public' : 'private',
    }) as const;

  /**
   * A recusa do SKILL.md que não cabe na resposta (`MAX_TEXTO_INLINE_BYTES`).
   *
   * Aqui o link não pode ir **no lugar** do texto, como em `get_skill`: o
   * conteúdo de um prompt é lido pelo modelo como instrução, e o de um resource,
   * como o próprio SKILL.md. Vai como erro de protocolo, que o `guardSurface`
   * deixa passar inteiro. E o link só entra quando a skill também está nas
   * ferramentas deste servidor: a rota de download só atende o vínculo
   * `as_skill` (`downloads.ts`), e uma skill pode viver só como prompt ou
   * resource — mandar o cliente para um 404 seria pior que dizer que não há URL.
   * A consulta a mais só roda nesta recusa.
   */
  const grandeDemais = async (detail: SkillDetail, bytes: number): Promise<McpError> => {
    const nasFerramentas = await getSkillSummary(detail.slug, recorteDasFerramentas(scope));
    return new McpError(
      ErrorCode.InvalidParams,
      `O SKILL.md de "${detail.slug}" é grande demais para vir na resposta ` +
        `(${bytes} bytes; o teto é ${MAX_TEXTO_INLINE_BYTES}). ` +
        (nasFerramentas
          ? `Baixe pela URL: ${urls.file(detail.slug, SKILL_MD)}`
          : 'Esta skill não está nas ferramentas deste servidor, então não há URL de download aqui.'),
    );
  };

  /**
   * A recusa do arquivo de apoio que não cabe na resposta.
   *
   * Mesma disciplina do `SKILL.md`, com uma simplificação: aqui a skill já foi
   * resolvida pelo vínculo `as_skill`, que é o mesmo que a rota de download
   * atende — então a URL sempre responde, e não há o caso de mandar o cliente
   * para um 404.
   */
  const arquivoGrandeDemais = (slug: string, path: string, bytes: number): McpError =>
    new McpError(
      ErrorCode.InvalidParams,
      `O arquivo "${path}" de "${slug}" é grande demais para vir na resposta ` +
        `(${bytes} bytes; o teto é ${MAX_TEXTO_INLINE_BYTES}). ` +
        `Baixe pela URL: ${urls.file(slug, path)}`,
    );

  /**
   * O `SKILL.md` canônico — o mesmo byte a byte que o `.zip` e o
   * `/files/SKILL.md` entregam, com o frontmatter gerado dos metadados. Conta
   * um acesso, `view`/`resource`, como sempre contou.
   *
   * Lido pelas duas portas (§4.2): a de skill primeiro, que é por onde o
   * `skills/list` anuncia esta URI, e a de resource depois. A segunda consulta
   * só acontece quando a skill não está na primeira porta.
   */
  const lerSkillMd = async (slug: string, uri: string) => {
    const detail = (await skillPublicada(slug, 'skill')) ?? (await skillPublicada(slug, 'resource'));
    if (!detail) throw naoEncontrado(`Resource não encontrado: "${uri}"`);

    // Antes do acesso e do `composeSkillMd`, que é mais uma cópia do texto.
    const excedeu = excedeTetoInline(detail.skillMd);
    if (excedeu !== null) throw await grandeDemais(detail, excedeu);

    registrarAcesso(scope, detail.uuid, 'view', 'resource');

    return {
      ...camposDeCache(),
      contents: [{ uri, mimeType: 'text/markdown', text: composeSkillMd(detail, detail.skillMd) }],
    };
  };

  /**
   * Um arquivo de apoio. Só `as_skill` (§4.2): pendurar isto em `as_resource`
   * ampliaria em silêncio a exposição de toda base que já tem aquela flag
   * ligada — hoje ela entrega o `SKILL.md`, e só ele.
   *
   * **Não conta acesso** (decisão 13), espelhando o par que já existe nas
   * ferramentas: `get_skill` conta, `get_skill_file` não. Contar aqui
   * transformaria um único carregamento de skill em N linhas na ficha.
   */
  const lerArquivoDeApoio = async (slug: string, path: string, uri: string) => {
    const skill = await getSkillSummary(slug, recorteDasFerramentas(scope));
    if (!skill) throw naoEncontrado(`Resource não encontrado: "${uri}"`);

    const file = await readFile(skill.uuid, path);
    if (!file) throw naoEncontrado(`Resource não encontrado: "${uri}"`);

    // Nos bytes **lidos**, não no `sizeBytes` gravado — a lição do `004`. Vale
    // para texto e para binário, e no binário são os bytes crus: medir o base64
    // recusaria, por um terço a mais, arquivo que cabe.
    if (file.buffer.byteLength > MAX_TEXTO_INLINE_BYTES) {
      throw arquivoGrandeDemais(skill.slug, path, file.buffer.byteLength);
    }

    return {
      ...camposDeCache(),
      contents: [
        file.isText
          ? { uri, mimeType: file.mimeType, text: file.buffer.toString('utf8') }
          : // Binário sai em `blob` base64 (decisão 9). A URL de download que as
            // ferramentas devolvem não serve aqui: sob a SEP o arquivo está no
            // manifesto, o host vai lê-lo, e uma recusa é falha de verificação —
            // a skill chega quebrada.
            { uri, mimeType: file.mimeType, blob: file.buffer.toString('base64') },
      ],
    };
  };

  return {
    async listPrompts() {
      const skills = await listPublishedSkills('prompt', mcpUuid);

      return {
        ...camposDeCache(),
        prompts: skills.map((skill) => ({
          // O slug já é o nome oficial da skill e já é validado como `a-z0-9-`,
          // que é a forma de que um nome de prompt precisa. Prefixar seria
          // redundante: os clientes qualificam os prompts pelo nome do servidor.
          name: skill.slug,
          title: skill.name,
          // A coluna é `NOT NULL DEFAULT ''`: skill sem descrição vira campo
          // ausente, não uma descrição vazia.
          description: skill.description || undefined,
        })),
      };
    },

    /**
     * O corpo do SKILL.md como uma única mensagem do usuário. Conta um acesso.
     *
     * Sem frontmatter: nome e descrição já viajam nos metadados do
     * `prompts/list`, e repeti-los no texto é ruído que o modelo lê como
     * instrução. Sem argumentos: uma skill é instrução estática.
     */
    async getPrompt(name: string) {
      const detail = await skillPublicada(name, 'prompt');
      if (!detail) throw naoEncontrado(`Prompt não encontrado: "${name}"`);

      // Antes do acesso: leitura recusada não é visualização.
      const excedeu = excedeTetoInline(detail.skillMd);
      if (excedeu !== null) throw await grandeDemais(detail, excedeu);

      registrarAcesso(scope, detail.uuid, 'view', 'prompt');

      return {
        // Sem `ttlMs`/`cacheScope`: os campos de cache da revisão 2026-07-28
        // valem para as listagens e as leituras que ela enumera, e `prompts/get`
        // não é uma delas. O `resultType`, sim — ele é exigido em todo resultado.
        resultType: 'complete' as const,
        description: detail.description || undefined,
        messages: [
          {
            role: 'user' as const,
            content: { type: 'text' as const, text: stripFrontmatter(detail.skillMd) },
          },
        ],
      };
    },

    /**
     * Uma entrada por skill `as_resource`: o `SKILL.md` dela. Os arquivos de
     * apoio **não** entram, e a SEP autoriza — resource é endereçável esteja ou
     * não listado, e o manifesto de `skills/list` já é o inventário completo.
     * Listar N skills vezes M arquivos numa resposta sem paginação é o pior caso
     * que isto evita (§4.3 do `17`).
     */
    async listResources() {
      const skills = await listPublishedSkills('resource', mcpUuid);

      return {
        ...camposDeCache(),
        resources: skills.map((skill) => ({
          uri: skillUri(skill.slug, SKILL_MD),
          name: skill.slug,
          title: skill.name,
          description: skill.description || undefined,
          mimeType: 'text/markdown',
        })),
      };
    },

    /**
     * A leitura por **arquivo**: o `SKILL.md` de uma skill ou um arquivo de
     * apoio dela.
     *
     * O diretório é recusado aqui de propósito — a SEP não define leitura de
     * diretório pelo método comum, e é o `resources/directory/read` que a faz.
     * É também o que acontece com a URI antiga `skill://<slug>`, que virou o
     * diretório-raiz (decisão 5).
     */
    async readResource(uri: string) {
      const alvo = parseSkillUri(uri);
      if (!alvo || alvo.path === '') throw naoEncontrado(`Resource não encontrado: "${uri}"`);

      return isSkillMd(alvo.path)
        ? await lerSkillMd(alvo.slug, uri)
        : await lerArquivoDeApoio(alvo.slug, alvo.path, uri);
    },

    /**
     * Vazia de propósito. Responde ao método — nada de *method not found* para o
     * cliente que sonda na inicialização — sem anunciar que `skill://` qualquer
     * é legível: só arquivo de skill vinculada é, e o motivo ficou mais forte
     * com a extensão, não mais fraco.
     */
    listResourceTemplates() {
      return { ...camposDeCache(), resourceTemplates: [] };
    },

    /**
     * `skills/list` — o registro autoritativo das skills que este servidor
     * publica (SEP-2640).
     *
     * Sem cursor e sem teto, como as outras duas listagens e pelo mesmo
     * argumento (decisão 7): truncar em silêncio esconde skill de quem a
     * vinculou. Um `cursor` que o cliente mande é ignorado — não há segunda
     * página para apontar.
     */
    async listSkills() {
      const manifesto = await listSkillsManifest(mcpUuid);

      return { ...camposDeCache(), skills: await entradasDoManifesto(manifesto) };
    },

    /**
     * `skills/get` — a **mesma** entrada de `skills/list`, por URI. Como a
     * listagem é completa, ele responde exatamente pelo mesmo conjunto.
     *
     * A URI tem de ser a de um `SKILL.md`. Todo o resto — o diretório, um
     * arquivo de apoio, skill de outro vMCP, skill sem `as_skill`, skill
     * inativa, slug inexistente — é o mesmo `-32602` com a mesma mensagem, pela
     * `§5.5` do `docs/06`: distinguir os casos entregaria slugs a quem sonda um
     * servidor que pode estar aberto.
     */
    async getSkill(uri: string) {
      const alvo = parseSkillUri(uri);
      if (!alvo || !isSkillMd(alvo.path)) throw naoEncontrado(`Skill não encontrada: "${uri}"`);

      const manifesto = await listSkillsManifest(mcpUuid, { slug: alvo.slug });
      const [entrada] = await entradasDoManifesto(manifesto);
      if (!entrada) throw naoEncontrado(`Skill não encontrada: "${uri}"`);

      return { ...camposDeCache(), skill: entrada };
    },

    /**
     * `resources/directory/read` — os filhos diretos de um diretório da skill,
     * não recursivo, com subdiretório marcado `inode/directory`.
     *
     * Sem cursor na resposta: o teto de arquivos por skill da SEP são 512, e o
     * que volta é metadado. Só skill `as_skill` (decisão 12) — sem isso uma
     * skill só-`as_resource` teria a árvore revelada enquanto os arquivos dela
     * seguem irrecuperáveis, que é vazamento de estrutura sem contrapartida.
     */
    async readDirectory(uri: string) {
      const alvo = parseSkillUri(uri);
      if (!alvo) throw naoEncontrado(`Diretório não encontrado: "${uri}"`);

      const skill = await getSkillSummary(alvo.slug, recorteDasFerramentas(scope));
      if (!skill) throw naoEncontrado(`Diretório não encontrado: "${uri}"`);

      const filhos = filhosDiretos(skill.slug, alvo.path, await listFiles(skill.uuid));
      if (!filhos) throw naoEncontrado(`Diretório não encontrado: "${uri}"`);

      return { ...camposDeCache(), resources: filhos };
    },
  };
}

/**
 * O driver `google`, sobre a Gemini API (`docs/14-rag.md` §6.2).
 *
 * Três coisas a não esquecer ao mexer aqui:
 *
 * 1. **Um item de `requests[]` por texto, sempre.** Mandar vários textos nas
 *    `parts` de um mesmo `content` é aceito pela API e devolve **um vetor
 *    agregado** dos textos somados — silenciosamente errado, e só perceptível
 *    quando a busca começa a trazer coisa sem sentido.
 * 2. **A tarefa vai escrita no texto.** O `gemini-embedding-2` não tem
 *    parâmetro de tipo de tarefa: o que diz se é documento ou consulta é o
 *    prefixo. Por isso o prefixo entra na identidade do espaço, e só é
 *    aplicado aqui — o texto guardado no banco nunca o tem.
 * 3. **A chave só no header `x-goog-api-key`.** Como parâmetro de URL ela
 *    vazaria em log de proxy e de servidor.
 *
 * `fetch` nativo do Node, sem SDK.
 */
import {
  assertVector,
  RagAuthError,
  RagConfigError,
  RagInputTooLongError,
  RagRateLimitError,
  RagUnavailableError,
  type EmbeddingDriver,
  type EmbeddingModel,
  type UsoDeTokens,
} from './driver.js';
import { BASE_URL_GOOGLE, GEMINI_EMBEDDING_2 } from './models.js';
import {
  embutirEmLotes,
  ocultarChave,
  retryAfterMs,
  ClienteHttp,
  type OpcoesHttp,
} from './http.js';

// O modelo mora em `models.ts`, com os dos outros drivers: é de lá que o
// registro por driver o lê, sem fazer ciclo de importação com este arquivo.
export { BASE_URL_GOOGLE, GEMINI_EMBEDDING_2 };


export type GoogleDriverOptions = OpcoesHttp & {
  apiKey: string;
  /** Já sem barra final; a versão faz parte dela. */
  baseUrl?: string;
};

type GoogleErrorBody = {
  error?: { code?: number; message?: string; status?: string; details?: unknown };
};

export class GoogleDriver implements EmbeddingDriver {
  readonly id = 'google' as const;
  readonly models = [GEMINI_EMBEDDING_2] as const;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly http: ClienteHttp;
  private readonly onUsage: ((uso: UsoDeTokens) => void) | undefined;

  constructor(options: GoogleDriverOptions) {
    if (!options.apiKey || options.apiKey.trim() === '') {
      throw new RagAuthError('RAG_GOOGLE_API_KEY ausente: o driver google precisa de uma chave');
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? BASE_URL_GOOGLE).replace(/\/+$/, '');
    this.http = new ClienteHttp('o Google', options);
    this.onUsage = options.onUsage;
  }

  /**
   * Embute a consulta. Vale a política de tentativas de `http.ts`, mas **dentro
   * do prazo de quem chamou**: o `signal` corta o `fetch` e também a espera
   * entre tentativas, então nada aqui passa de `RAG_QUERY_TIMEOUT_MS`. Qualquer
   * erro vira busca textual (§8.1).
   */
  async embedQuery(
    model: EmbeddingModel,
    text: string,
    signal?: AbortSignal,
  ): Promise<number[]> {
    const corpo = {
      content: { parts: [{ text: `${model.queryPrefix}${text}` }] },
    };

    const resposta = await this.pedir(`${model.id}:embedContent`, corpo, signal);
    const valores = (resposta as { embedding?: { values?: unknown } }).embedding?.values;
    return assertVector(valores, model, 'embedContent');
  }

  /**
   * Embute documentos, em lotes que respeitam `maxBatch` e `maxBatchChars`.
   *
   * A resposta volta na ordem do pedido, e é assim que os vetores são casados
   * com os textos — por isso o lote nunca é reordenado.
   */
  async embedDocuments(
    model: EmbeddingModel,
    texts: readonly string[],
    signal?: AbortSignal,
  ): Promise<number[][]> {
    return embutirEmLotes(model, texts, (lote) => this.embutirLote(model, lote, signal));
  }

  /** Um lote: um item de `requests[]` por texto, sempre. */
  private async embutirLote(
    model: EmbeddingModel,
    lote: string[],
    signal?: AbortSignal,
  ): Promise<number[][]> {
    const corpo = {
      requests: lote.map((texto) => ({
        model: `models/${model.id}`,
        content: { parts: [{ text: `${model.documentPrefix}${texto}` }] },
      })),
    };

    const resposta = await this.pedir(`${model.id}:batchEmbedContents`, corpo, signal);
    const embeddings = (resposta as { embeddings?: { values?: unknown }[] }).embeddings;

    // Só o lote informa `usageMetadata`; `embedContent` não traz contagem
    // nenhuma, e a consulta fica sem token informado — o que é honesto.
    //
    // O campo é `promptTokenCount`, conferido contra a API real em 16/09/2026.
    // A especificação dizia `totalTokenCount`, que é o nome que a API de
    // geração usa; os dois são lidos para não quebrar se ela mudar de ideia.
    const uso = (resposta as {
      usageMetadata?: { totalTokenCount?: number; promptTokenCount?: number };
    }).usageMetadata;
    const tokens = uso?.totalTokenCount ?? uso?.promptTokenCount;
    if (typeof tokens === 'number') {
      this.onUsage?.({ model: model.id, tokens, textos: lote.length, metodo: 'documents' });
    }

    if (!Array.isArray(embeddings) || embeddings.length !== lote.length) {
      throw new RagConfigError(
        `batchEmbedContents: esperados ${lote.length} vetores, recebidos ${
          Array.isArray(embeddings) ? embeddings.length : 0
        }`,
      );
    }
    return embeddings.map((e, i) => assertVector(e?.values, model, `batchEmbedContents[${i}]`));
  }

  /** Uma requisição. A política de tentativas é a de `http.ts`. */
  private async pedir(caminho: string, corpo: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.http.pedir(
      {
        url: `${this.baseUrl}/models/${caminho}`,
        // Nunca como parâmetro de URL: vazaria em log de proxy.
        headers: { 'x-goog-api-key': this.apiKey },
        corpo,
        signal,
      },
      (resposta, body) => this.lancarPeloStatus(resposta, body as GoogleErrorBody),
    );
  }

  /** Traduz o status HTTP no erro que diz o que fazer. */
  private lancarPeloStatus(resposta: Response, corpo: GoogleErrorBody): never {
    const status = corpo.error?.status ?? '';
    // A mensagem vai para o log e para o "Último erro" do painel: a chave, se o
    // provedor a ecoar, fica pelo caminho (`ocultarChave`).
    const mensagem = ocultarChave(corpo.error?.message ?? resposta.statusText, this.apiKey);
    const detalhe = `${resposta.status}${status ? ` ${status}` : ''}: ${mensagem}`;

    // A página de erros documenta 401 para chave inválida, e a sessão Google
    // registrou 400 INVALID_ARGUMENT com API_KEY_INVALID. Os dois acontecem.
    const chaveInvalida =
      resposta.status === 401 ||
      resposta.status === 403 ||
      (resposta.status === 400 && /API_KEY_INVALID/i.test(JSON.stringify(corpo)));
    if (chaveInvalida) {
      throw new RagAuthError(`o Google recusou a chave (${detalhe})`);
    }

    // Pré-condição pode ser o nível gratuito indisponível na região; 404 é
    // modelo inexistente. Nos dois casos, insistir não muda nada.
    if (resposta.status === 404 || (resposta.status === 400 && status === 'FAILED_PRECONDITION')) {
      throw new RagConfigError(`configuração recusada pelo Google (${detalhe})`);
    }

    if (resposta.status === 429) {
      throw new RagRateLimitError(`limite de taxa do Google (${detalhe})`, retryAfterMs(resposta));
    }

    // Outro 400: quase sempre texto longo demais. Quem chamou divide o lote. O
    // "quase" é de propósito: este balde também recebe o 400 que é da instalação
    // (intermediário na URL base, contrato da API), e é por isso que o indexador
    // confere com o texto-sonda antes de gravar uma recusa permanente.
    if (resposta.status === 400) {
      throw new RagInputTooLongError(`o Google recusou o conteúdo enviado (${detalhe})`);
    }

    if (resposta.status === 408 || resposta.status >= 500) {
      throw new RagUnavailableError(`o Google está indisponível (${detalhe})`);
    }

    throw new RagUnavailableError(`resposta inesperada do Google (${detalhe})`);
  }
}

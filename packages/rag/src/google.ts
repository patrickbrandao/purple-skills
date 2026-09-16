/**
 * O driver `google`, sobre a Gemini API (`tmp/RAG-GOOGLE.md` §6.2).
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
  RagTimeoutError,
  RagUnavailableError,
  type EmbeddingDriver,
  type EmbeddingModel,
} from './driver.js';
import { BASE_URL_PADRAO, MODELO_PADRAO } from './settings.js';

/**
 * O `gemini-embedding-2`.
 *
 * As dimensões, o limite por texto e os prefixos são fatos da API, conferidos
 * em 15/09/2026. O tamanho do lote **não** é documentado pelo Google: 100
 * textos e 60.000 caracteres são um teto nosso, conservador.
 *
 * `maxPartChars` é 6.000 porque, somado ao prefixo de até 200 caracteres,
 * fica com folga abaixo dos 8.192 tokens por texto.
 */
export const GEMINI_EMBEDDING_2: EmbeddingModel = {
  id: MODELO_PADRAO,
  dimensions: 3072,
  documentPrefix: 'title: none | text: ',
  queryPrefix: 'task: search result | query: ',
  maxInputTokens: 8192,
  maxBatch: 100,
  maxBatchChars: 60_000,
  maxPartChars: 6000,
};

export type GoogleDriverOptions = {
  apiKey: string;
  /** Já sem barra final; a versão faz parte dela. */
  baseUrl?: string;
  /** Injetável para teste. Padrão: o `fetch` global. */
  fetchImpl?: typeof fetch;
  /** Tentativas em erro temporário. Padrão: 5. */
  maxRetries?: number;
  /** Espera entre tentativas, em ms. Injetável para teste não dormir. */
  sleep?: (ms: number) => Promise<void>;
};

type GoogleErrorBody = {
  error?: { code?: number; message?: string; status?: string; details?: unknown };
};

const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class GoogleDriver implements EmbeddingDriver {
  readonly id = 'google' as const;
  readonly models = [GEMINI_EMBEDDING_2] as const;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: GoogleDriverOptions) {
    if (!options.apiKey || options.apiKey.trim() === '') {
      throw new RagAuthError('RAG_GOOGLE_API_KEY ausente: o driver google precisa de uma chave');
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? BASE_URL_PADRAO).replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxRetries = options.maxRetries ?? 5;
    this.sleep = options.sleep ?? dormir;
  }

  /**
   * Embute a consulta. **Sem nova tentativa**: quem chama tem um prazo curto
   * (`RAG_QUERY_TIMEOUT_MS`) e qualquer erro vira busca textual (§8.1).
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
    if (texts.length === 0) return [];

    const vetores: number[][] = [];
    for (const lote of this.lotes(model, texts)) {
      vetores.push(...(await this.embutirLote(model, lote, signal)));
    }
    return vetores;
  }

  /** Divide a lista em lotes que cabem nos dois limites. */
  private *lotes(model: EmbeddingModel, texts: readonly string[]): Generator<string[]> {
    let atual: string[] = [];
    let caracteres = 0;

    for (const texto of texts) {
      const tamanho = texto.length + model.documentPrefix.length;
      const estouraria = atual.length >= model.maxBatch || caracteres + tamanho > model.maxBatchChars;
      if (atual.length > 0 && estouraria) {
        yield atual;
        atual = [];
        caracteres = 0;
      }
      atual.push(texto);
      caracteres += tamanho;
    }

    if (atual.length > 0) yield atual;
  }

  /**
   * Um lote. Um 400 genérico divide o lote ao meio e tenta de novo: quase
   * sempre é um texto só que passou do limite de tokens, e dividir acha qual
   * sem perder o resto do lote. Texto sozinho que falha é pulado, com o vetor
   * nulo trocado por erro para quem chamou decidir.
   */
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

    try {
      const resposta = await this.pedir(`${model.id}:batchEmbedContents`, corpo, signal);
      const embeddings = (resposta as { embeddings?: { values?: unknown }[] }).embeddings;
      if (!Array.isArray(embeddings) || embeddings.length !== lote.length) {
        throw new RagConfigError(
          `batchEmbedContents: esperados ${lote.length} vetores, recebidos ${
            Array.isArray(embeddings) ? embeddings.length : 0
          }`,
        );
      }
      return embeddings.map((e, i) => assertVector(e?.values, model, `batchEmbedContents[${i}]`));
    } catch (erro) {
      if (!(erro instanceof RagInputTooLongError) || lote.length === 1) throw erro;

      const meio = Math.floor(lote.length / 2);
      return [
        ...(await this.embutirLote(model, lote.slice(0, meio), signal)),
        ...(await this.embutirLote(model, lote.slice(meio), signal)),
      ];
    }
  }

  /** Uma requisição, com as tentativas que o tipo de erro permite. */
  private async pedir(caminho: string, corpo: unknown, signal?: AbortSignal): Promise<unknown> {
    const url = `${this.baseUrl}/models/${caminho}`;
    let ultimo: unknown;

    for (let tentativa = 0; tentativa <= this.maxRetries; tentativa += 1) {
      try {
        const resposta = await this.fetchImpl(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            // Nunca como parâmetro de URL: vazaria em log de proxy.
            'x-goog-api-key': this.apiKey,
          },
          body: JSON.stringify(corpo),
          signal,
        });

        if (resposta.ok) return await resposta.json();
        await this.lancarPeloStatus(resposta);
      } catch (erro) {
        ultimo = erro;

        // Não adianta insistir: falta chave, permissão, pré-condição, ou o
        // texto não cabe. Quem chama resolve.
        if (
          erro instanceof RagAuthError ||
          erro instanceof RagConfigError ||
          erro instanceof RagInputTooLongError
        ) {
          throw erro;
        }

        // O prazo de quem chamou estourou: não é nosso para tentar de novo.
        if (signal?.aborted) {
          throw new RagTimeoutError('o prazo da requisição ao Google estourou');
        }
        if (erro instanceof Error && erro.name === 'AbortError') {
          throw new RagTimeoutError('o prazo da requisição ao Google estourou');
        }

        if (tentativa === this.maxRetries) break;

        const espera =
          erro instanceof RagRateLimitError
            ? (erro.retryAfterMs ?? this.recuoDoLimite(tentativa))
            : this.recuoExponencial(tentativa);
        await this.sleep(espera);
      }
    }

    if (ultimo instanceof Error) throw ultimo;
    throw new RagUnavailableError('o Google não respondeu');
  }

  /** Traduz o status HTTP no erro que diz o que fazer. */
  private async lancarPeloStatus(resposta: Response): Promise<never> {
    const corpo = await this.corpoDoErro(resposta);
    const status = corpo.error?.status ?? '';
    const mensagem = corpo.error?.message ?? resposta.statusText;
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
      throw new RagRateLimitError(`limite de taxa do Google (${detalhe})`, this.retryAfter(resposta));
    }

    // Outro 400: quase sempre texto longo demais. Quem chamou divide o lote.
    if (resposta.status === 400) {
      throw new RagInputTooLongError(`o Google recusou o conteúdo enviado (${detalhe})`);
    }

    if (resposta.status === 408 || resposta.status >= 500) {
      throw new RagUnavailableError(`o Google está indisponível (${detalhe})`);
    }

    throw new RagUnavailableError(`resposta inesperada do Google (${detalhe})`);
  }

  private async corpoDoErro(resposta: Response): Promise<GoogleErrorBody> {
    try {
      return (await resposta.json()) as GoogleErrorBody;
    } catch {
      return {};
    }
  }

  /** O Google não documenta `Retry-After`, mas se ele vier, respeitamos. */
  private retryAfter(resposta: Response): number | null {
    const bruto = resposta.headers.get('retry-after');
    if (!bruto) return null;
    const segundos = Number(bruto);
    return Number.isFinite(segundos) && segundos >= 0 ? segundos * 1000 : null;
  }

  /** Sem `Retry-After`: recua de 1 a 60 segundos. */
  private recuoDoLimite(tentativa: number): number {
    return Math.min(60_000, 1000 * 2 ** tentativa);
  }

  private recuoExponencial(tentativa: number): number {
    return Math.min(30_000, 500 * 2 ** tentativa);
  }
}

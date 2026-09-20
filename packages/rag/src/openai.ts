/**
 * O driver `openai`, sobre a API de embeddings da OpenAI
 * (`docs/14-rag.md` §6.4).
 *
 * Três coisas a não esquecer ao mexer aqui:
 *
 * 1. **Documento e consulta são a mesma chamada.** Não há parâmetro nem texto
 *    que os distinga, então os dois prefixos do modelo são vazios — e é assim
 *    que eles entram na identidade do espaço. O que separa este espaço do
 *    espaço do Google não é o prefixo: é o par driver+modelo.
 * 2. **A resposta é casada pelo `index`, não pela ordem de chegada.** A API
 *    manda um `index` em cada item justamente porque a ordem não é promessa;
 *    confiar nela gravaria o vetor de um texto sob o hash de outro, e o erro
 *    só apareceria como busca ruim, meses depois.
 * 3. **Dimensão nativa, sem `dimensions` no corpo.** Encurtar o vetor é uma
 *    decisão de qualidade tomada para economizar espaço — e o espaço é a parte
 *    barata.
 *
 * `fetch` nativo do Node, sem SDK.
 */
import {
  assertVector,
  RagAuthError,
  RagConfigError,
  RagInputTooLongError,
  RagOriginError,
  RagQuotaError,
  RagRateLimitError,
  RagUnavailableError,
  type EmbeddingDriver,
  type EmbeddingModel,
  type UsoDeTokens,
} from './driver.js';
import { BASE_URL_OPENAI, MODELOS_OPENAI } from './models.js';
import {
  embutirEmLotes,
  ocultarChave,
  retryAfterMs,
  ClienteHttp,
  type OpcoesHttp,
} from './http.js';

export { BASE_URL_OPENAI };

export type OpenAIDriverOptions = OpcoesHttp & {
  apiKey: string;
  /** Já sem barra final; a versão faz parte dela. */
  baseUrl?: string;
};

/** O formato de erro da OpenAI: sempre um objeto `error` com `type` e `code`. */
type OpenAIErrorBody = {
  error?: { message?: string; type?: string; param?: string | null; code?: string | null };
};

type OpenAIResposta = {
  data?: { embedding?: unknown; index?: number }[];
  usage?: { prompt_tokens?: number; total_tokens?: number };
};

export class OpenAIDriver implements EmbeddingDriver {
  readonly id = 'openai' as const;
  readonly models = MODELOS_OPENAI;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly http: ClienteHttp;
  private readonly onUsage: ((uso: UsoDeTokens) => void) | undefined;

  constructor(options: OpenAIDriverOptions) {
    if (!options.apiKey || options.apiKey.trim() === '') {
      throw new RagAuthError('RAG_OPENAI_API_KEY ausente: o driver openai precisa de uma chave');
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? BASE_URL_OPENAI).replace(/\/+$/, '');
    this.http = new ClienteHttp('a OpenAI', options);
    this.onUsage = options.onUsage;
  }

  /**
   * Embute a consulta. Vale a política de tentativas de `http.ts`, mas **dentro
   * do prazo de quem chamou**: o `signal` corta o `fetch` e também a espera
   * entre tentativas, então nada aqui passa de `RAG_QUERY_TIMEOUT_MS`. Qualquer
   * erro vira busca textual (§8.1).
   */
  async embedQuery(model: EmbeddingModel, text: string, signal?: AbortSignal): Promise<number[]> {
    const vetores = await this.enviar(model, [`${model.queryPrefix}${text}`], 'query', signal);
    const [vetor] = vetores;
    if (vetor === undefined) {
      throw new RagConfigError('embeddings: a OpenAI não devolveu vetor nenhum para a consulta');
    }
    return vetor;
  }

  /** Embute documentos, em lotes que respeitam `maxBatch` e `maxBatchChars`. */
  async embedDocuments(
    model: EmbeddingModel,
    texts: readonly string[],
    signal?: AbortSignal,
  ): Promise<number[][]> {
    return embutirEmLotes(model, texts, (lote) =>
      this.enviar(
        model,
        lote.map((t) => `${model.documentPrefix}${t}`),
        'documents',
        signal,
      ),
    );
  }

  /** Uma requisição a `/embeddings`. A política de tentativas é a de `http.ts`. */
  private async enviar(
    model: EmbeddingModel,
    entradas: string[],
    metodo: 'documents' | 'query',
    signal?: AbortSignal,
  ): Promise<number[][]> {
    const resposta = (await this.http.pedir(
      {
        url: `${this.baseUrl}/embeddings`,
        headers: { authorization: `Bearer ${this.apiKey}` },
        // Sem `dimensions`: a dimensão nativa é a que o espaço declara.
        corpo: { model: model.id, input: entradas, encoding_format: 'float' },
        signal,
      },
      (r, corpo) => this.lancarPeloStatus(r, corpo as OpenAIErrorBody),
    )) as OpenAIResposta;

    const itens = resposta.data;
    if (!Array.isArray(itens) || itens.length !== entradas.length) {
      throw new RagConfigError(
        `embeddings: esperados ${entradas.length} vetores, recebidos ${
          Array.isArray(itens) ? itens.length : 0
        }`,
      );
    }

    const tokens = resposta.usage?.total_tokens ?? resposta.usage?.prompt_tokens;
    if (typeof tokens === 'number') {
      this.onUsage?.({ model: model.id, tokens, textos: entradas.length, metodo });
    }

    // O `index` é que manda: a ordem de chegada não é promessa da API.
    const vetores = new Array<number[] | undefined>(entradas.length);
    for (const [i, item] of itens.entries()) {
      const posicao = typeof item?.index === 'number' ? item.index : i;
      if (posicao < 0 || posicao >= entradas.length || vetores[posicao] !== undefined) {
        throw new RagConfigError(`embeddings: índice ${posicao} fora do pedido ou repetido`);
      }
      vetores[posicao] = assertVector(item?.embedding, model, `embeddings[${posicao}]`);
    }

    return vetores.map((v, i) => {
      if (v === undefined) throw new RagConfigError(`embeddings: faltou o vetor do texto ${i}`);
      return v;
    });
  }

  /** Traduz o status HTTP no erro que diz o que fazer. */
  private lancarPeloStatus(resposta: Response, corpo: OpenAIErrorBody): never {
    const codigo = corpo.error?.code ?? '';
    const tipo = corpo.error?.type ?? '';
    // O 401 daqui ecoa a chave recebida — mascarada, ou inteira quando é curta —,
    // e esta mensagem vai para o log e para o "Último erro" do painel.
    const mensagem = ocultarChave(corpo.error?.message ?? resposta.statusText, this.apiKey);
    const detalhe = `${resposta.status}${tipo ? ` ${tipo}` : ''}: ${mensagem}`;

    // O 403 de país ou região sem suporte recusa **de onde** vem o pedido, não
    // a chave — como o 403 da Voyage. A política é a do erro de chave; o `kind`
    // é outro, para o painel não mandar trocar uma chave que está boa.
    if (resposta.status === 403 && codigo === 'unsupported_country_region_territory') {
      throw new RagOriginError(
        `a OpenAI recusou a origem da requisição (país ou região sem suporte), não a chave (${detalhe})`,
      );
    }

    if (resposta.status === 401 || resposta.status === 403) {
      throw new RagAuthError(`a OpenAI recusou a chave (${detalhe})`);
    }

    // `insufficient_quota` é 429 mas **não é limite de taxa**: é conta sem
    // crédito, e esperar não resolve. Cair no recuo aqui gastaria o ciclo
    // inteiro tentando de novo o que nunca vai passar, e o operador leria
    // "limite de taxa" quando o que falta é pagar.
    //
    // É `RagQuotaError`, subclasse de `RagConfigError`: a política de
    // tentativas fica idêntica, e o painel distingue "sem crédito" de "modelo
    // inexistente" pelo `kind`, sem ler esta mensagem.
    if (codigo === 'insufficient_quota' || tipo === 'insufficient_quota') {
      throw new RagQuotaError(
        `a conta da OpenAI está sem crédito; esperar não resolve (${detalhe})`,
      );
    }

    if (resposta.status === 429) {
      throw new RagRateLimitError(`limite de taxa da OpenAI (${detalhe})`, retryAfterMs(resposta));
    }

    // 404 é modelo inexistente; insistir não muda nada.
    if (resposta.status === 404) {
      throw new RagConfigError(`configuração recusada pela OpenAI (${detalhe})`);
    }

    // Outro 400: quase sempre texto longo demais. Quem chamou divide o lote. O
    // "quase" é de propósito: este balde também recebe o 400 que é da instalação
    // (intermediário na URL base, contrato da API), e é por isso que o indexador
    // confere com o texto-sonda antes de gravar uma recusa permanente.
    if (resposta.status === 400) {
      throw new RagInputTooLongError(`a OpenAI recusou o conteúdo enviado (${detalhe})`);
    }

    if (resposta.status === 408 || resposta.status >= 500) {
      throw new RagUnavailableError(`a OpenAI está indisponível (${detalhe})`);
    }

    throw new RagUnavailableError(`resposta inesperada da OpenAI (${detalhe})`);
  }
}

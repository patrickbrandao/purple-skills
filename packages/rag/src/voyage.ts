/**
 * O driver `voyage`, sobre a API de embeddings da Voyage AI
 * (`docs/14-rag.md` §6.4).
 *
 * Três coisas a não esquecer ao mexer aqui:
 *
 * 1. **A distinção documento/consulta é o `input_type`, não o texto.** Por
 *    isso os dois prefixos do modelo são vazios — e ficam vazios *de
 *    propósito*, entrando assim na identidade do espaço. O parâmetro é fixo no
 *    driver: `document` ao embutir o acervo, `query` ao embutir a busca.
 *    Trocá-los faria a busca comparar vetores de espaços semânticos
 *    diferentes, e o resultado seria só pior — nunca um erro.
 * 2. **`output_dimension` vai escrito.** Diferente da OpenAI, aqui 1024 não é
 *    "a dimensão nativa": é a padrão entre 256, 512, 1024 e 2048. Um padrão do
 *    provedor pode mudar; a dimensão do espaço, não — o `CHECK` da `020`
 *    recusaria os vetores novos e ninguém saberia por quê.
 * 3. **O teto de tokens por requisição é por modelo** — 1 M no `-lite`, 320
 *    mil no `voyage-4` e 120 mil no `-large` — e é isso que `maxBatchChars`
 *    guarda, pela conta conservadora de um token por caractere.
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
import { BASE_URL_VOYAGE, MODELOS_VOYAGE } from './models.js';
import { embutirEmLotes, retryAfterMs, ClienteHttp, type OpcoesHttp } from './http.js';

export { BASE_URL_VOYAGE };

export type VoyageDriverOptions = OpcoesHttp & {
  apiKey: string;
  /** Já sem barra final; a versão faz parte dela. */
  baseUrl?: string;
};

/**
 * O erro da Voyage vem em `detail`, no estilo do FastAPI. Alguns caminhos
 * respondem no formato da OpenAI, então os dois são lidos.
 */
type VoyageErrorBody = { detail?: unknown; error?: { message?: string; type?: string } };

type VoyageResposta = {
  data?: { embedding?: unknown; index?: number }[];
  usage?: { total_tokens?: number };
};

export class VoyageDriver implements EmbeddingDriver {
  readonly id = 'voyage' as const;
  readonly models = MODELOS_VOYAGE;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly http: ClienteHttp;
  private readonly onUsage: ((uso: UsoDeTokens) => void) | undefined;

  constructor(options: VoyageDriverOptions) {
    if (!options.apiKey || options.apiKey.trim() === '') {
      throw new RagAuthError('RAG_VOYAGE_API_KEY ausente: o driver voyage precisa de uma chave');
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? BASE_URL_VOYAGE).replace(/\/+$/, '');
    this.http = new ClienteHttp('a Voyage', options);
    this.onUsage = options.onUsage;
  }

  /**
   * Embute a consulta, com `input_type: 'query'`. **Sem nova tentativa**: quem
   * chama tem um prazo curto e qualquer erro vira busca textual (§8.1).
   */
  async embedQuery(model: EmbeddingModel, text: string, signal?: AbortSignal): Promise<number[]> {
    const vetores = await this.enviar(model, [`${model.queryPrefix}${text}`], 'query', signal);
    const [vetor] = vetores;
    if (vetor === undefined) {
      throw new RagConfigError('embeddings: a Voyage não devolveu vetor nenhum para a consulta');
    }
    return vetor;
  }

  /** Embute documentos, com `input_type: 'document'`, em lotes. */
  async embedDocuments(
    model: EmbeddingModel,
    texts: readonly string[],
    signal?: AbortSignal,
  ): Promise<number[][]> {
    return embutirEmLotes(model, texts, (lote) =>
      this.enviar(
        model,
        lote.map((t) => `${model.documentPrefix}${t}`),
        'document',
        signal,
      ),
    );
  }

  /** Uma requisição a `/embeddings`. A política de tentativas é a de `http.ts`. */
  private async enviar(
    model: EmbeddingModel,
    entradas: string[],
    inputType: 'document' | 'query',
    signal?: AbortSignal,
  ): Promise<number[][]> {
    const resposta = (await this.http.pedir(
      {
        url: `${this.baseUrl}/embeddings`,
        headers: { authorization: `Bearer ${this.apiKey}` },
        corpo: {
          model: model.id,
          input: entradas,
          // É isto, e não o texto, que diz se é acervo ou busca.
          input_type: inputType,
          // Escrito de propósito: 1024 é a padrão entre quatro, não a nativa.
          output_dimension: model.dimensions,
        },
        signal,
      },
      (r, corpo) => this.lancarPeloStatus(r, corpo as VoyageErrorBody),
    )) as VoyageResposta;

    const itens = resposta.data;
    if (!Array.isArray(itens) || itens.length !== entradas.length) {
      throw new RagConfigError(
        `embeddings: esperados ${entradas.length} vetores, recebidos ${
          Array.isArray(itens) ? itens.length : 0
        }`,
      );
    }

    const tokens = resposta.usage?.total_tokens;
    if (typeof tokens === 'number') {
      this.onUsage?.({
        model: model.id,
        tokens,
        textos: entradas.length,
        metodo: inputType === 'query' ? 'query' : 'documents',
      });
    }

    // Como na OpenAI, o `index` é que manda: a ordem de chegada não é promessa.
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
  private lancarPeloStatus(resposta: Response, corpo: VoyageErrorBody): never {
    const mensagem =
      (typeof corpo.detail === 'string' ? corpo.detail : undefined) ??
      corpo.error?.message ??
      resposta.statusText;
    const detalhe = `${resposta.status}: ${mensagem}`;

    if (resposta.status === 401) {
      throw new RagAuthError(`a Voyage recusou a chave (${detalhe})`);
    }
    // 403 na Voyage é o IP recusado, não a chave. Não adianta insistir, e a
    // mensagem precisa dizer isso: quem lê "chave recusada" troca a chave à toa.
    if (resposta.status === 403) {
      throw new RagAuthError(`a Voyage recusou a origem da requisição, não a chave (${detalhe})`);
    }

    if (resposta.status === 429) {
      throw new RagRateLimitError(`limite de taxa da Voyage (${detalhe})`, retryAfterMs(resposta));
    }

    // 404 é modelo inexistente; insistir não muda nada.
    if (resposta.status === 404) {
      throw new RagConfigError(`configuração recusada pela Voyage (${detalhe})`);
    }

    // 400 cobre JSON inválido, lote grande demais e texto acima do limite de
    // tokens. Tratar como "não cabe" divide o lote, e é a divisão que separa
    // o texto culpado do resto — o JSON inválido não passaria nem sozinho.
    if (resposta.status === 400) {
      throw new RagInputTooLongError(`a Voyage recusou o conteúdo enviado (${detalhe})`);
    }

    if (resposta.status === 408 || resposta.status >= 500) {
      throw new RagUnavailableError(`a Voyage está indisponível (${detalhe})`);
    }

    throw new RagUnavailableError(`resposta inesperada da Voyage (${detalhe})`);
  }
}

/**
 * O que os três drivers HTTP têm em comum: as tentativas, o recuo e o corte em
 * lotes (`tmp/RAG-GOOGLE.md` §6).
 *
 * Os provedores diferem no endereço, no header da chave, no formato do corpo e
 * na forma do erro — e é só nisso. A **política** é a mesma nos três, porque
 * ela não vem da API e sim do que o indexador precisa: erro de chave ou de
 * configuração encerra o ciclo, limite de taxa e indisponibilidade recuam e
 * tentam de novo, prazo estourado de quem chamou não vira tentativa nova.
 *
 * Deixar essa política em cada driver seria mantê-la três vezes, e a terceira
 * cópia é sempre a que fica para trás.
 */
import {
  RagAuthError,
  RagConfigError,
  RagInputTooLongError,
  RagRateLimitError,
  RagTimeoutError,
  RagUnavailableError,
  type EmbeddingModel,
  type UsoDeTokens,
} from './driver.js';

export type OpcoesHttp = {
  /**
   * Chamado com o que o provedor cobrou, quando ele informa. Só ele sabe a
   * conta; o indexador, sozinho, estima por caractere.
   */
  onUsage?: (uso: UsoDeTokens) => void;
  /** Injetável para teste. Padrão: o `fetch` global. */
  fetchImpl?: typeof fetch;
  /** Tentativas em erro temporário. Padrão: 5. */
  maxRetries?: number;
  /** Espera entre tentativas, em ms. Injetável para teste não dormir. */
  sleep?: (ms: number) => Promise<void>;
};

export type Requisicao = {
  url: string;
  headers: Record<string, string>;
  corpo: unknown;
  signal?: AbortSignal;
};

/**
 * Traduz uma resposta de erro no erro que diz o que fazer. **Sempre lança** —
 * o tipo `never` é o que garante que nenhum driver esqueça um status.
 */
export type MapearErro = (resposta: Response, corpo: unknown) => never;

const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Um cliente HTTP com a política de tentativas do projeto. */
export class ClienteHttp {
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    /** Como o provedor aparece nas mensagens de erro: "o Google", "a OpenAI". */
    private readonly provedor: string,
    opcoes: OpcoesHttp = {},
  ) {
    this.fetchImpl = opcoes.fetchImpl ?? fetch;
    this.maxRetries = opcoes.maxRetries ?? 5;
    this.sleep = opcoes.sleep ?? dormir;
  }

  /** Uma requisição, com as tentativas que o tipo de erro permite. */
  async pedir(req: Requisicao, mapear: MapearErro): Promise<unknown> {
    let ultimo: unknown;

    for (let tentativa = 0; tentativa <= this.maxRetries; tentativa += 1) {
      try {
        const resposta = await this.fetchImpl(req.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...req.headers },
          body: JSON.stringify(req.corpo),
          signal: req.signal,
        });

        if (resposta.ok) return await resposta.json();
        mapear(resposta, await corpoDoErro(resposta));
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
        if (req.signal?.aborted || (erro instanceof Error && erro.name === 'AbortError')) {
          throw new RagTimeoutError(`o prazo da requisição a ${this.provedor} estourou`);
        }

        if (tentativa === this.maxRetries) break;

        const espera =
          erro instanceof RagRateLimitError
            ? (erro.retryAfterMs ?? recuoDoLimite(tentativa))
            : recuoExponencial(tentativa);
        await this.sleep(espera);
      }
    }

    if (ultimo instanceof Error) throw ultimo;
    throw new RagUnavailableError(`${this.provedor} não respondeu`);
  }
}

/** O corpo do erro, ou `{}` quando o provedor não mandou JSON nenhum. */
async function corpoDoErro(resposta: Response): Promise<unknown> {
  try {
    return await resposta.json();
  } catch {
    return {};
  }
}

/**
 * `Retry-After` em milissegundos, ou `null` quando o provedor não o informou.
 *
 * Aceita também o `retry-after-ms` da OpenAI, que é a mesma coisa com outra
 * unidade — respeitar o que o provedor pede é sempre melhor que adivinhar.
 */
export function retryAfterMs(resposta: Response): number | null {
  const ms = Number(resposta.headers.get('retry-after-ms'));
  if (Number.isFinite(ms) && ms >= 0 && resposta.headers.get('retry-after-ms')) return ms;

  const bruto = resposta.headers.get('retry-after');
  if (!bruto) return null;
  const segundos = Number(bruto);
  return Number.isFinite(segundos) && segundos >= 0 ? segundos * 1000 : null;
}

/** Sem `Retry-After`: recua de 1 a 60 segundos. */
export function recuoDoLimite(tentativa: number): number {
  return Math.min(60_000, 1000 * 2 ** tentativa);
}

export function recuoExponencial(tentativa: number): number {
  return Math.min(30_000, 500 * 2 ** tentativa);
}

/**
 * Divide a lista em lotes que cabem nos dois limites do modelo.
 *
 * A ordem **nunca** muda: é por ela que os vetores da resposta são casados com
 * os textos do pedido.
 */
export function* lotes(model: EmbeddingModel, texts: readonly string[]): Generator<string[]> {
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
 * Embute em lotes, dividindo o lote ao meio quando o provedor recusa o
 * conteúdo.
 *
 * Quase sempre é um texto só que passou do limite de tokens; dividir acha qual
 * sem perder o resto do lote. Texto sozinho que falha sobe o erro para quem
 * chamou decidir — o indexador pula e registra.
 */
export async function embutirEmLotes(
  model: EmbeddingModel,
  texts: readonly string[],
  enviar: (lote: string[]) => Promise<number[][]>,
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const vetores: number[][] = [];
  for (const lote of lotes(model, texts)) {
    vetores.push(...(await comDivisao(lote, enviar)));
  }
  return vetores;
}

async function comDivisao(
  lote: string[],
  enviar: (lote: string[]) => Promise<number[][]>,
): Promise<number[][]> {
  try {
    return await enviar(lote);
  } catch (erro) {
    if (!(erro instanceof RagInputTooLongError) || lote.length === 1) throw erro;
    const meio = Math.floor(lote.length / 2);
    return [
      ...(await comDivisao(lote.slice(0, meio), enviar)),
      ...(await comDivisao(lote.slice(meio), enviar)),
    ];
  }
}

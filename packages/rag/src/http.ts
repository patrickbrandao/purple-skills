/**
 * O que os três drivers HTTP têm em comum: as tentativas, o recuo e o corte em
 * lotes (`docs/14-rag.md` §6).
 *
 * Os provedores diferem no endereço, no header da chave, no formato do corpo e
 * na forma do erro — e é só nisso. A **política** é a mesma nos três, porque
 * ela não vem da API e sim do que o indexador precisa: erro de chave ou de
 * configuração encerra o ciclo, limite de taxa e indisponibilidade recuam e
 * tentam de novo, prazo estourado de quem chamou não vira tentativa nova.
 *
 * O orçamento de tempo, porém, é de **quem chama**, e é o `signal` que o diz:
 * a busca do site e do MCP passa um prazo curto e a pausa entre tentativas é
 * cortada com ele; o indexador passa um prazo largo, por chamada
 * (`RAG_INDEX_TIMEOUT_MS`): ninguém está esperando, mas um provedor que aceita
 * a conexão e nunca responde não pode segurar a rodada. Hoje nenhum chamador de
 * produção fica sem `signal`; quem chama o driver direto sem ele — um teste, um
 * script — fica só com `maxRetries`, o recuo e o teto de `ESPERA_MAXIMA_MS`.
 *
 * Deixar essa política em cada driver seria mantê-la três vezes, e a terceira
 * cópia é sempre a que fica para trás.
 */
import {
  ragErrorKind,
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
  /**
   * Espera entre tentativas, em ms. Injetável para teste não dormir. Recebe o
   * `signal` da requisição porque é ele que encurta a pausa quando o prazo de
   * quem chamou estoura.
   */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
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

/**
 * Espera cancelável: o prazo de quem chamou encurta a pausa entre tentativas.
 *
 * Com `setTimeout` puro, abortar o `fetch` não abortava a espera — e a busca,
 * que promete responder em `RAG_QUERY_TIMEOUT_MS`, ficava presa pelo tempo que
 * o provedor pedisse. Quem não passa `signal` dorme a espera inteira, como
 * antes — limitada ao teto abaixo. Hoje nenhum chamador de produção está nesse
 * caso: o indexador também passa o seu (`AbortSignal.timeout` por chamada), e o
 * prazo dele corta esta espera do mesmo jeito.
 */
const dormir = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const fim = () => {
      clearTimeout(alarme);
      signal?.removeEventListener('abort', fim);
      resolve();
    };
    const alarme = setTimeout(fim, ms);
    signal?.addEventListener('abort', fim, { once: true });
  });

/**
 * Teto de uma espera, inclusive da que o provedor pede no `Retry-After`.
 *
 * Sem ele era o provedor quem decidia por quanto tempo esta instalação ficava
 * parada: um `Retry-After: 300` virava cinco minutos de pausa por tentativa.
 * O caminho **sem** `Retry-After` já respeitava este teto (`recuoDoLimite`);
 * não faz sentido o caminho explícito ser o menos protegido.
 */
const ESPERA_MAXIMA_MS = 60_000;

/** Um cliente HTTP com a política de tentativas do projeto. */
export class ClienteHttp {
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

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
        await this.sleep(Math.min(espera, ESPERA_MAXIMA_MS), req.signal);

        // A espera pode ter sido encurtada pelo abort: o prazo de quem chamou
        // acabou no meio da pausa, e gastar outra tentativa só atrasaria a
        // resposta que já vai sair em modo textual.
        if (req.signal?.aborted) {
          throw new RagTimeoutError(`o prazo da requisição a ${this.provedor} estourou`);
        }
      }
    }

    // Erro do pacote que sobrou das tentativas (limite de taxa, 5xx) sai como
    // veio: o driver já o escreveu com o detalhe do provedor.
    if (ragErrorKind(ultimo) !== null) throw ultimo;

    // O resto é a requisição que nem chegou a ter resposta — `TypeError: fetch
    // failed` do undici, conexão recusada, DNS — ou a resposta que não deu para
    // ler. `driver.ts` promete `RagUnavailableError` para "falha de rede"; cru,
    // este erro saía **sem classe**, e o indexador o publicava como erro que não
    // veio do provedor (é o que `lastErrorKind: null` quer dizer). Só a classe
    // muda: as tentativas e o recuo acima são os de sempre, e o original vai em
    // `cause`.
    throw new RagUnavailableError(`${this.provedor} não respondeu (${detalheDaFalha(ultimo)})`, {
      cause: ultimo,
    });
  }
}

/**
 * O que houve, em uma linha. No undici a mensagem é sempre "fetch failed", e
 * quem diz o motivo — `ECONNREFUSED`, `ENOTFOUND`, certificado — é a causa.
 * Nenhum dos dois traz a chave: ela vai no header, nunca na URL.
 */
function detalheDaFalha(erro: unknown): string {
  if (!(erro instanceof Error)) return String(erro);
  const causa = erro.cause;
  if (causa instanceof Error && causa.message !== '') return `${erro.message}: ${causa.message}`;
  return erro.message;
}

/** O que entra no lugar da chave, inteira ou mascarada, na mensagem do provedor. */
const CHAVE_OMITIDA = '[chave omitida]';

/**
 * Tira da mensagem **do provedor** o que for a chave, antes de ela virar mensagem
 * de erro — que vai para o log do indexador, para `rag.indexer.status` no banco
 * e, de lá, para o "Último erro" do painel, que nunca recebe a chave (§9).
 *
 * O caso real é o 401 da OpenAI, que **ecoa a chave recebida**: mascarada quando
 * tem cara de chave (o começo, uma fileira de asteriscos e os quatro últimos
 * caracteres), e como veio quando é curta ou está fora do formato — que é
 * justamente o caso de quem colou o segredo errado na variável. Pedaço de
 * segredo em log também é segredo em log, e a parte útil da mensagem ("Incorrect
 * API key provided") não depende dele.
 *
 * Os três drivers passam por aqui, e não só o da OpenAI, para o corte não
 * depender de quem ecoa hoje. O que sai:
 *
 *   * a chave **literal**, onde aparecer (menos de 4 caracteres não é segredo,
 *     e trocá-los picotaria a mensagem inteira);
 *   * qualquer palavra com uma fileira de três ou mais `*` ou `•` — a máscara.
 *     A palavra sai inteira, pontuação colada inclusive: parar no primeiro ponto
 *     deixaria passar o resto de um token com pontos no meio.
 */
export function ocultarChave(mensagem: string, chave: string): string {
  const semLiteral = chave.length >= 4 ? mensagem.split(chave).join(CHAVE_OMITIDA) : mensagem;
  return semLiteral.replace(/\S*(?:\*{3,}|•{3,})\S*/g, CHAVE_OMITIDA);
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

/** Sem `Retry-After`: recua de 1 segundo até o teto. */
export function recuoDoLimite(tentativa: number): number {
  return Math.min(ESPERA_MAXIMA_MS, 1000 * 2 ** tentativa);
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
 * A divisão salva a chamada quando o problema é o **tamanho do lote**: as
 * metades passam, e os vetores voltam na ordem. Quando é **um texto** que passou
 * do limite de tokens, ela só chega até ele — texto sozinho que falha sobe o
 * erro, e a chamada inteira é rejeitada, inclusive as metades que já tinham
 * voltado: `embedDocuments` é tudo ou nada. Quem separa o culpado do resto é o
 * indexador, que reenvia a fatia um texto por vez e marca o recusado. (**Era**
 * "dividir acha qual sem perder o resto do lote", que é o que **não** acontece
 * nesse caso. Manter a divisão assim mesmo é decisão registrada.)
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

/**
 * A interface que todo driver de embedding implementa, e os erros que ela
 * promete (`tmp/RAG-GOOGLE.md` §6.1, futuro `docs/14`).
 *
 * Documento e consulta têm métodos separados porque não são a mesma chamada:
 * num provedor a distinção é um parâmetro, e no `gemini-embedding-2` ela vai
 * escrita no próprio texto enviado. Quem chama passa sempre o **texto
 * canônico**, sem prefixo nenhum; aplicar o prefixo é trabalho do driver, na
 * hora da requisição. É o que permite guardar um texto só, sob o hash do
 * canônico, e reaproveitá-lo em espaços diferentes.
 *
 * Os erros são divididos pelo que o chamador deve fazer com eles, não pelo
 * código HTTP que os causou:
 *
 *   * `RagAuthError` e `RagConfigError` — não adianta tentar de novo neste
 *     ciclo; falta chave, permissão ou pré-condição. O indexador encerra;
 *   * `RagRateLimitError` — tentar de novo depois, com recuo;
 *   * `RagUnavailableError` e `RagTimeoutError` — tentar de novo, com recuo
 *     exponencial;
 *   * `RagInputTooLongError` — o texto não cabe; quem chama o divide ou o pula.
 *
 * Na busca (§8.1) essa distinção não importa: qualquer erro vira modo textual.
 * Ela existe para o indexador.
 */

/**
 * O que o provedor cobrou por uma chamada.
 *
 * Existe porque a conta só o provedor sabe fazer: o indexador estima tokens
 * por caractere, o que erra em texto com muito símbolo ou muito acento, e a
 * estimativa é justamente o número que alguém usaria para decidir se liga a
 * busca semântica no acervo inteiro.
 */
export type UsoDeTokens = {
  /** O modelo que cobrou. */
  model: string;
  /** Tokens da requisição, como o provedor os contou. */
  tokens: number;
  /** Textos da requisição, para a média sair sem outra conta. */
  textos: number;
  metodo: 'documents' | 'query';
};

/** Um modelo de embedding, com tudo que o projeto precisa saber dele. */
export type EmbeddingModel = {
  /** Identificador no provedor, como aparece na URL. */
  id: string;
  /** Dimensões do vetor gerado. Entra na identidade do espaço. */
  dimensions: number;
  /** Texto posto antes do canônico ao embutir um documento. Entra na identidade. */
  documentPrefix: string;
  /** Texto posto antes do canônico ao embutir uma consulta. Entra na identidade. */
  queryPrefix: string;
  /** Teto de tokens por texto no provedor. */
  maxInputTokens: number;
  /** Textos por requisição que o driver monta. */
  maxBatch: number;
  /** Caracteres somados por requisição. */
  maxBatchChars: number;
  /** Teto de caracteres por parte na divisão (§5.3). */
  maxPartChars: number;
};

export interface EmbeddingDriver {
  /** Escrito à mão, e não importado do registro, para `driver.ts` não
   * depender de `settings.ts` — é o registro que depende dos modelos. */
  readonly id: 'google' | 'openai' | 'voyage' | 'fake';
  readonly models: readonly EmbeddingModel[];
  /** Recebe textos canônicos; aplica `documentPrefix` na chamada. */
  embedDocuments(
    model: EmbeddingModel,
    texts: readonly string[],
    signal?: AbortSignal,
  ): Promise<number[][]>;
  /** Recebe a consulta canônica; aplica `queryPrefix` na chamada. */
  embedQuery(model: EmbeddingModel, text: string, signal?: AbortSignal): Promise<number[]>;
}

/** Chave ausente, inválida ou sem permissão. Encerra o ciclo do indexador. */
export class RagAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RagAuthError';
  }
}

/** Pré-condição não atendida ou modelo inexistente. Encerra o ciclo. */
export class RagConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RagConfigError';
  }
}

/** Limite de taxa. `retryAfterMs` é nulo quando o provedor não o informa. */
export class RagRateLimitError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number | null,
  ) {
    super(message);
    this.name = 'RagRateLimitError';
  }
}

/** O texto passou do limite de tokens do modelo. */
export class RagInputTooLongError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RagInputTooLongError';
  }
}

/** Indisponibilidade temporária: 408, 5xx ou falha de rede. */
export class RagUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RagUnavailableError';
  }
}

/** O prazo estourou antes da resposta. */
export class RagTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RagTimeoutError';
  }
}

/**
 * Confere que o provedor devolveu o que prometeu.
 *
 * Um vetor de dimensão errada gravado no banco seria recusado pelo CHECK da
 * `020`, mas a mensagem sairia lá longe do que a causou; e um vetor com `NaN`
 * passaria pelo CHECK e envenenaria a busca em silêncio.
 */
export function assertVector(
  values: unknown,
  model: EmbeddingModel,
  onde: string,
): number[] {
  if (!Array.isArray(values)) {
    throw new RagConfigError(`${onde}: esperado um vetor, recebido ${typeof values}`);
  }
  if (values.length !== model.dimensions) {
    throw new RagConfigError(
      `${onde}: esperado vetor de ${model.dimensions} dimensões, recebido ${values.length}`,
    );
  }
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new RagConfigError(`${onde}: o vetor tem valor não numérico`);
    }
  }
  return values as number[];
}

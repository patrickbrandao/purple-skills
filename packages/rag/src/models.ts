/**
 * Os modelos de embedding dos três provedores, num lugar só
 * (`tmp/RAG-GOOGLE.md` §6, futuro `docs/14`).
 *
 * Eles moram aqui, e não no arquivo de cada driver, por dois motivos:
 *
 * 1. **O registro precisa deles antes dos drivers.** `settings.ts` lista, por
 *    driver, a variável da chave, a URL base padrão e os modelos; se ele
 *    importasse `google.ts`, e `google.ts` importasse o registro de volta, o
 *    ciclo deixaria uma das constantes indefinida na subida. Este módulo só
 *    importa tipos de `driver.ts`, então não há ciclo nenhum.
 * 2. **Dá para comparar os três lado a lado**, que é o que mais importa ao
 *    trocar de driver: o que muda são dimensões, prefixo e limites.
 *
 * **`maxPartChars` é 6.000 nos três de propósito.** Ele decide como a skill é
 * partida em textos canônicos, e o texto canônico é *compartilhado entre
 * espaços*: é endereçado pelo próprio SHA-256 em `rag_texts` e reaproveitado
 * por qualquer espaço que o queira. Se cada driver partisse diferente, trocar
 * de driver reescreveria o acervo inteiro de textos e jogaria fora os vetores
 * do driver anterior — que hoje sobrevivem, no espaço deles, prontos para
 * quando alguém voltar atrás. O teto por texto de cada provedor continua
 * declarado em `maxInputTokens`, e todos eles são folgados para 6.000
 * caracteres.
 */
import type { EmbeddingModel } from './driver.js';

// ------------------------------------------------------------------ google ---

/** URL base padrão da Gemini API, já com a versão. */
export const BASE_URL_GOOGLE = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * O `gemini-embedding-2`.
 *
 * Dimensões, limite por texto e prefixos são fatos da API, conferidos em
 * 15/09/2026. O tamanho do lote **não** é documentado pelo Google: 100 textos
 * e 60.000 caracteres são um teto nosso, conservador.
 *
 * Aqui a tarefa vai escrita no texto: o modelo não tem parâmetro de tipo de
 * tarefa, e é por isso que os prefixos entram na identidade do espaço.
 */
export const GEMINI_EMBEDDING_2: EmbeddingModel = {
  id: 'gemini-embedding-2',
  dimensions: 3072,
  documentPrefix: 'title: none | text: ',
  queryPrefix: 'task: search result | query: ',
  maxInputTokens: 8192,
  maxBatch: 100,
  maxBatchChars: 60_000,
  maxPartChars: 6000,
};

// ------------------------------------------------------------------ openai ---

/** URL base padrão da OpenAI, já com a versão. */
export const BASE_URL_OPENAI = 'https://api.openai.com/v1';

/**
 * Os dois `text-embedding-3`, **em dimensão nativa**.
 *
 * A API aceita `dimensions` para encurtar o vetor; não usamos. Encurtar seria
 * uma decisão de qualidade tomada para economizar espaço, e o espaço já é
 * barato: o que ela custaria na busca só apareceria depois, em resultado
 * pior, sem ninguém ligar uma coisa à outra.
 *
 * Sem prefixo: documento e consulta são a mesma chamada, sem parâmetro que os
 * distinga. Os prefixos ficam vazios e entram assim na identidade do espaço.
 *
 * `maxBatchChars` é 200.000 porque a API limita a requisição a 300 mil tokens
 * somados: 200 mil caracteres não chegam a 300 mil tokens nem na pior razão
 * possível, a de um token por caractere. O teto de 8.192 tokens por texto fica
 * folgado para as partes de 6.000 caracteres.
 */
export const TEXT_EMBEDDING_3_SMALL: EmbeddingModel = {
  id: 'text-embedding-3-small',
  dimensions: 1536,
  documentPrefix: '',
  queryPrefix: '',
  maxInputTokens: 8192,
  maxBatch: 96,
  maxBatchChars: 200_000,
  maxPartChars: 6000,
};

export const TEXT_EMBEDDING_3_LARGE: EmbeddingModel = {
  ...TEXT_EMBEDDING_3_SMALL,
  id: 'text-embedding-3-large',
  dimensions: 3072,
};

// ------------------------------------------------------------------ voyage ---

/** URL base padrão da Voyage AI, já com a versão. */
export const BASE_URL_VOYAGE = 'https://api.voyageai.com/v1';

/**
 * Os três `voyage-4`, em 1024 dimensões.
 *
 * A API aceita `output_dimension` com 256, 512, 1024 e 2048; ficamos na de
 * 1024, que é a padrão dos três, pelo mesmo motivo do `text-embedding-3`.
 *
 * Sem prefixo: aqui a distinção entre documento e consulta é o parâmetro
 * `input_type`, que o driver fixa em `document` ou `query` conforme o método.
 * Os prefixos ficam vazios — e é justamente por serem parte da identidade do
 * espaço que dois espaços de drivers diferentes nunca se confundem.
 *
 * Os tetos de tokens por requisição são por modelo — 1 M, 320 mil e 120 mil —
 * e viram `maxBatchChars` pela mesma conta conservadora do `text-embedding-3`:
 * um token por caractere. O lote de 1.000 textos é o máximo da API.
 */
export const VOYAGE_4_LITE: EmbeddingModel = {
  id: 'voyage-4-lite',
  dimensions: 1024,
  documentPrefix: '',
  queryPrefix: '',
  maxInputTokens: 32_000,
  maxBatch: 1000,
  maxBatchChars: 1_000_000,
  maxPartChars: 6000,
};

export const VOYAGE_4: EmbeddingModel = {
  ...VOYAGE_4_LITE,
  id: 'voyage-4',
  maxBatchChars: 320_000,
};

export const VOYAGE_4_LARGE: EmbeddingModel = {
  ...VOYAGE_4_LITE,
  id: 'voyage-4-large',
  maxBatchChars: 120_000,
};

/** Os modelos de cada driver, na ordem; o primeiro é o padrão do driver. */
export const MODELOS_GOOGLE = [GEMINI_EMBEDDING_2] as const;
export const MODELOS_OPENAI = [TEXT_EMBEDDING_3_SMALL, TEXT_EMBEDDING_3_LARGE] as const;
export const MODELOS_VOYAGE = [VOYAGE_4_LITE, VOYAGE_4, VOYAGE_4_LARGE] as const;

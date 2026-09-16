/**
 * `@purple-skills/rag` — o que o indexador, o mcp-public, o site e o painel
 * precisam para a busca semântica, sem nenhum deles falar com o provedor
 * direto.
 *
 * O desenho está em `tmp/RAG-GOOGLE.md` (futuro `docs/14`). O pacote não
 * acessa o banco: quem grava é `@purple-skills/db`.
 */
export {
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

export { textSha256, textSha256Hex } from './hash.js';

export {
  chunkSkill,
  metaText,
  splitText,
  DEFAULT_MAX_FILE_BYTES,
  type ChunkOptions,
  type ChunkResult,
  type SkillForChunking,
  type SkillTextOccurrence,
  type SkippedFile,
} from './chunk.js';

export {
  decideSeed,
  parseBaseUrl,
  ragSetting,
  readBaseUrlEnv,
  readDriverEnv,
  readIndexIntervalEnv,
  readModelEnv,
  readQueryTimeoutEnv,
  BASE_URL_PADRAO,
  CHAVE_ESTADO_INDEXADOR,
  DRIVERS_FUTUROS,
  MODELO_PADRAO,
  RAG_SETTINGS,
  type RagDriverId,
  type RagSetting,
  type RagSettingKey,
  type SeedDecision,
} from './settings.js';

export { GoogleDriver, GEMINI_EMBEDDING_2, type GoogleDriverOptions } from './google.js';

export {
  criarBuscaSemantica,
  logDaBusca,
  type SearchPorts,
  type SemanticOption,
  type SemanticResolution,
  type SemanticSearchOptions,
  type TextReason,
} from './search.js';

export {
  FakeDriver,
  MODELO_FALSO,
  semPrefixo,
  subirServidorFalso,
  vetorFalso,
  type FalhaSimulada,
  type ServidorFalso,
  type ServidorFalsoOptions,
} from './fake.js';

import { GoogleDriver } from './google.js';
import { GEMINI_EMBEDDING_2 } from './google.js';
import type { EmbeddingDriver, EmbeddingModel } from './driver.js';
import { RagConfigError } from './driver.js';
import { MODELO_PADRAO, type RagDriverId } from './settings.js';

/**
 * Monta o driver da configuração em uso.
 *
 * Devolve `null` com o driver `off` — quem chama cai no modo textual em vez de
 * tratar exceção para o caso normal de "a busca semântica está desligada".
 */
export function criarDriver(input: {
  driver: RagDriverId;
  apiKey: string | undefined;
  baseUrl?: string;
}): EmbeddingDriver | null {
  if (input.driver === 'off') return null;
  if (!input.apiKey) return null;
  return new GoogleDriver({ apiKey: input.apiKey, baseUrl: input.baseUrl });
}

/** O modelo pelo id, para o driver em uso. */
export function modeloPeloId(driver: EmbeddingDriver, id: string): EmbeddingModel {
  const achado = driver.models.find((m) => m.id === id);
  if (!achado) {
    throw new RagConfigError(
      `o driver ${driver.id} não tem o modelo "${id}"; disponíveis: ${driver.models
        .map((m) => m.id)
        .join(', ')}`,
    );
  }
  return achado;
}

/** O modelo padrão da v1. */
export function modeloPadrao(): EmbeddingModel {
  if (GEMINI_EMBEDDING_2.id !== MODELO_PADRAO) {
    throw new RagConfigError('o modelo padrão do código não bate com o do registro');
  }
  return GEMINI_EMBEDDING_2;
}

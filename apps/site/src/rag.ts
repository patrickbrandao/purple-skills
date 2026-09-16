/**
 * A perna semântica da busca do site (`tmp/RAG-GOOGLE.md` §8.1, futuro
 * `docs/14`).
 *
 * O site busca sempre com a visibilidade `'open'`, e o recorte vale nas duas
 * pernas da fusão — uma skill que o site não mostra não aparece por ter vetor
 * parecido com a consulta.
 *
 * Nada aqui lança: sem chave, com o driver `off`, sem a migration, sem espaço
 * ou com o Google fora do ar, a resposta sai com `mode: 'text'`.
 */
import { findRagSpace, getRagSettings, ragSchemaReady } from '@purple-skills/db';
import {
  criarBuscaSemantica,
  criarDriver,
  readBaseUrlEnv,
  readQueryTimeoutEnv,
} from '@purple-skills/rag';
import { readSecret } from '@purple-skills/shared';

const apiKey = readSecret('RAG_GOOGLE_API_KEY');

const driver = criarDriver({
  // Quem liga e desliga é `rag.driver` no banco, conferido a cada busca com
  // cache curto; aqui só se resolve *como* falar com o provedor.
  driver: 'google',
  apiKey,
  baseUrl: readBaseUrlEnv(),
});

export const buscaSemantica = criarBuscaSemantica({
  ports: { ragSchemaReady, getRagSettings, findRagSpace },
  driver,
  timeoutMs: readQueryTimeoutEnv(),
  log: (mensagem) => console.log(`[site] ${mensagem}`),
});

/** Aviso de boot, uma vez, para o operador saber por que a busca é textual. */
export function avisoDeBoot(): string | null {
  return driver === null
    ? '[site] RAG_GOOGLE_API_KEY ausente: a busca responde em modo textual'
    : null;
}

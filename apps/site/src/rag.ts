/**
 * A perna semântica da busca do site (`docs/14-rag.md` §8.1).
 *
 * O site busca sempre com a visibilidade `'open'`, e o recorte vale nas duas
 * pernas da fusão — uma skill que o site não mostra não aparece por ter vetor
 * parecido com a consulta.
 *
 * Nada aqui lança: sem chave, com um `<CHAVE>_FILE` ilegível, com o driver
 * `off`, sem a migration, sem espaço ou com o Google fora do ar, a resposta sai
 * com `mode: 'text'`.
 */
import { findRagSpace, getRagSettings, ragSchemaReady } from '@purple-skills/db';
import {
  criarBuscaSemantica,
  criarDriversDoAmbiente,
  readQueryTimeoutEnv,
  RAG_DRIVERS,
} from '@purple-skills/rag';

// Quem liga e desliga, e quem escolhe entre os drivers montados, é
// `rag.driver` no banco, conferido a cada busca com cache curto; aqui só se
// resolve *como* falar com cada provedor que tem chave no ambiente.
const drivers = criarDriversDoAmbiente();

export const buscaSemantica = criarBuscaSemantica({
  ports: { ragSchemaReady, getRagSettings, findRagSpace },
  driver: drivers.resolver,
  timeoutMs: readQueryTimeoutEnv(),
  log: (mensagem) => console.log(`[site] ${mensagem}`),
});

/**
 * Avisos de boot, uma vez, para o operador saber por que a busca é textual.
 *
 * Inclui uma linha por driver que não subiu (`problemas`) — entre eles o de
 * `<CHAVE>_FILE` ilegível, que desliga só aquele driver em vez de derrubar o
 * site (relatório 015 da auditoria de 2026-11-07). Sem essa linha, o único
 * sinal seria a busca textual.
 */
export function avisosDeBoot(): string[] {
  const avisos = drivers.problemas.map(
    ({ id, motivo }) => `[site] driver de RAG ${id} não subiu: ${motivo}`,
  );
  if (drivers.comChave.length > 0) return avisos;
  const vars = RAG_DRIVERS.map((d) => d.apiKeyEnv).join(', ');
  // O placeholder conta como ausente (`readApiKeyEnv`, relatório 021 da auditoria
  // de 2026-09-19): sem dizer isso, quem copiou o `.env.example` lê "nenhuma
  // chave" com três variáveis preenchidas e procura o defeito no lugar errado.
  avisos.push(
    `[site] nenhuma chave de RAG no ambiente (${vars}; o CHANGE_ME do .env.example conta como ` +
      'chave ausente): a busca responde em modo textual',
  );
  return avisos;
}

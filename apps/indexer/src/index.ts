/**
 * O indexador do RAG (`docs/14-rag.md` §7).
 *
 * Dois modos:
 *
 *   * **contínuo** (padrão, o do container): varre no intervalo de
 *     `RAG_INDEX_INTERVAL_SECONDS` até receber SIGTERM;
 *   * **único** (`--once`): repete até não haver pendência e sai com 0, ou 1
 *     se houve erro. É o modo do smoke test e de uma reindexação manual.
 *
 * Ele **não derruba o processo** por causa do ambiente: sem a migration
 * aplicada espera, sem chave refatia e avisa, com o driver `off` só publica o
 * estado. O `run-local.sh` roda o `migrate` depois do `up`, então subir antes
 * das tabelas é o caso normal.
 */
import {
  criarDriversDoAmbiente,
  ragSetting,
  readIndexIntervalEnv,
  RAG_DRIVERS,
  type DriversDoAmbiente,
} from '@purple-skills/rag';
import {
  claimStaleSkills,
  closeDb,
  collectOrphanRagTexts,
  getDb,
  getRagSettings,
  insertRagVectors,
  listPendingRagTexts,
  markRagTextRefused,
  ragCoverage,
  ragSchemaReady,
  readSkillForRag,
  releaseStaleSkill,
  replaceSkillTexts,
  resolveRagSpace,
  setRagIndexerStatus,
  waitForDatabase,
} from '@purple-skills/db';
import { runCycle, runOnce, RecusasRag, type IndexerPorts } from './indexer.js';

const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * O prazo de uma chamada de indexação, lido do **registro** do RAG.
 *
 * A variável e o padrão vivem uma vez só, em `RAG_SETTINGS` (`AGENTS.md`,
 * "Regra da busca semântica"), e a validação é o `parse` da própria opção —
 * valor torto derruba o boot, como manda a convenção. O leitor pronto
 * (`readIndexTimeoutEnv`) já existe no pacote mas ainda não está na fachada
 * dele; quando estiver, esta função vira uma chamada só.
 */
function prazoDaIndexacao(env: NodeJS.ProcessEnv = process.env): number {
  const opcao = ragSetting('RAG_INDEX_TIMEOUT_MS');
  const bruto = env[opcao.env]?.trim();
  return bruto === undefined || bruto === ''
    ? Number(opcao.fallback)
    : Number(opcao.parse(bruto));
}

/**
 * Monta, do ambiente, **todos** os drivers para os quais há chave.
 *
 * O `rag.driver` do banco decide qual deles vale; aqui só se resolve *como*
 * falar com cada provedor. Com as três chaves no `.env`, trocar o driver no
 * painel passa a valer no ciclo seguinte, sem recriar container nenhum. Sem
 * chave nenhuma o ciclo refatia sem embutir — não é erro, é o estado de quem
 * ainda não configurou chave.
 */
export function driverDoAmbiente(env: NodeJS.ProcessEnv = process.env): DriversDoAmbiente {
  return criarDriversDoAmbiente(env);
}

function montarPortas(): IndexerPorts {
  const { resolver, comChave, problemas } = driverDoAmbiente();
  for (const { id, motivo } of problemas) {
    console.warn(`[indexer] driver ${id} tem chave mas não subiu: ${motivo}`);
  }
  return {
    driver: resolver,
    keyPresent: (id) => comChave.includes(id),
    ragSchemaReady,
    getRagSettings,
    resolveRagSpace,
    claimStaleSkills,
    releaseStaleSkill,
    readSkillForRag,
    replaceSkillTexts,
    listPendingRagTexts,
    insertRagVectors,
    ragCoverage,
    setRagIndexerStatus,
    // As duas portas do `025`: a recusa do provedor vira linha em
    // `rag_text_status` (e a fila passa a excluí-la), e o texto que perdeu a
    // última ocorrência é apagado com o vetor dele. Sem elas o ciclo roda
    // igual — é assim que o teste monta as portas —, só que a recusa morre com
    // o processo e os órfãos ficam para sempre.
    markRagTextRefused,
    collectOrphanRagTexts,
    log: (mensagem) => console.log(mensagem),
  };
}

async function main(): Promise<void> {
  const umaVez = process.argv.includes('--once');
  const intervalo = readIndexIntervalEnv();
  const timeoutMs = prazoDaIndexacao();

  const { pool } = getDb();
  await waitForDatabase(pool);
  const portas = montarPortas();

  const comChave = criarDriversDoAmbiente().comChave;
  if (comChave.length === 0) {
    const vars = RAG_DRIVERS.map((d) => d.apiKeyEnv).join(', ');
    console.log(`[indexer] nenhuma chave no ambiente (${vars}): as skills são refatiadas, nada é embutido`);
  } else {
    console.log(`[indexer] chave presente para: ${comChave.join(', ')}`);
  }

  // Quem tira o recusado da fila de vez é o banco (`markRagTextRefused`); esta
  // memória é a rede de segurança do processo, para o caso de a gravação da
  // marca falhar — aí o texto não é reenviado pelo menos enquanto ele viver.
  const recusas = new RecusasRag();

  if (umaVez) {
    const { exitCode, rodadas, result } = await runOnce(portas, { recusas, timeoutMs });
    console.log(
      `[indexer] modo único: ${rodadas} rodada(s), estado "${result.state}", ` +
        `${result.erros} erro(s)`,
    );
    await closeDb();
    process.exit(exitCode);
  }

  let parando = false;
  const shutdown = async (sinal: string) => {
    if (parando) return;
    parando = true;
    console.log(`[indexer] ${sinal} recebido, encerrando`);
    await closeDb();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  console.log(`[indexer] varrendo a cada ${intervalo}s, prazo de ${timeoutMs}ms por chamada`);
  while (!parando) {
    try {
      await runCycle(portas, { recusas, timeoutMs });
    } catch (erro) {
      // Nada aqui derruba o container: a rodada seguinte tenta de novo.
      console.error(`[indexer] rodada falhou: ${erro instanceof Error ? erro.message : erro}`);
    }
    await dormir(intervalo * 1000);
  }
}

main().catch((erro) => {
  console.error(`[indexer] falha fatal: ${erro instanceof Error ? erro.message : erro}`);
  process.exit(1);
});

/**
 * O indexador do RAG (`tmp/RAG-GOOGLE.md` §7, futuro `docs/14`).
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
  readIndexIntervalEnv,
  RAG_DRIVERS,
  type DriversDoAmbiente,
} from '@purple-skills/rag';
import {
  claimStaleSkills,
  closeDb,
  getDb,
  getRagSettings,
  insertRagVectors,
  listPendingRagTexts,
  ragCoverage,
  ragSchemaReady,
  readSkillForRag,
  releaseStaleSkill,
  replaceSkillTexts,
  resolveRagSpace,
  setRagIndexerStatus,
  waitForDatabase,
} from '@purple-skills/db';
import { runCycle, runOnce, type IndexerPorts } from './indexer.js';

const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
    log: (mensagem) => console.log(mensagem),
  };
}

async function main(): Promise<void> {
  const umaVez = process.argv.includes('--once');
  const intervalo = readIndexIntervalEnv();

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

  if (umaVez) {
    const { exitCode, rodadas, result } = await runOnce(portas);
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

  console.log(`[indexer] varrendo a cada ${intervalo}s`);
  while (!parando) {
    try {
      await runCycle(portas);
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

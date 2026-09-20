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
 *
 * SIGTERM e SIGINT são uma **parada educada**, nos dois modos: o ciclo em curso
 * devolve à fila o que reservou e não começou, e só então o pool fecha — com
 * teto (`PRAZO_DE_PARADA_MS`), porque o Docker não espera para sempre. O modo
 * contínuo sai com 0; o único sai com 128 + o número do sinal, que é como o
 * shell diz "interrompido": ele não terminou, e 0 ali quer dizer "não há mais
 * pendência".
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
  releaseRagTextReservations,
  releaseStaleSkill,
  replaceSkillTexts,
  resolveRagSpace,
  setRagIndexerStatus,
  waitForDatabase,
} from '@purple-skills/db';
import { runCycle, runOnce, RecusasRag, type IndexerPorts } from './indexer.js';

const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Quanto o encerramento espera o ciclo devolver o que reservou, antes de fechar
 * o pool mesmo assim.
 *
 * Tem de caber no que o Docker dá entre o SIGTERM e o SIGKILL — 10 segundos por
 * padrão, e o compose não define `stop_grace_period`. Um lote no provedor pode
 * levar `RAG_INDEX_TIMEOUT_MS` (120 s): esperar sem teto trocaria "saiu cedo" por
 * "SIGKILL no meio". Estourado o teto, nada se perde: a reserva de textos e a de
 * skills vencem sozinhas.
 */
const PRAZO_DE_PARADA_MS = 8_000;

/** O código de saída de quem foi interrompido por sinal, como o shell o escreve. */
const SAIDA_POR_SINAL: Record<'SIGTERM' | 'SIGINT', number> = { SIGTERM: 143, SIGINT: 130 };

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
    // Sem ela, o lote que falha some da fila por dez minutos, e com a fila toda
    // reservada o ciclo seguinte publica "sem erro" com o acervo sem vetor. A
    // porta não tem o `retryAfterMs` da função do banco: a devolução do ciclo é
    // sempre "já" (ver `devolverReservas`).
    releaseRagTextReservations,
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

  // A parada educada, nos dois modos. O ciclo vê `parando` entre uma skill e
  // outra e entre um lote de textos e outro, e devolve à fila o que reservou e
  // não começou; fechar o pool antes disso faria a própria devolução falhar.
  // **Era** `closeDb()` direto, com o ciclo em curso — e só no modo contínuo: o
  // `--once` não tinha tratador, e o SIGTERM o matava na hora.
  let parando = false;
  let emCurso: Promise<unknown> = Promise.resolve();
  const deveParar = () => parando;
  const shutdown = async (sinal: 'SIGTERM' | 'SIGINT') => {
    if (parando) return;
    parando = true;
    console.log(`[indexer] ${sinal} recebido: esperando o ciclo devolver o que reservou`);
    const noPrazo = await Promise.race([
      emCurso.then(
        () => true,
        () => true,
      ),
      dormir(PRAZO_DE_PARADA_MS).then(() => false),
    ]);
    if (!noPrazo) {
      console.log(
        `[indexer] o ciclo não parou em ${PRAZO_DE_PARADA_MS}ms; encerrando assim mesmo — ` +
          'o que ficou reservado volta sozinho quando a reserva vencer',
      );
    }
    await closeDb();
    process.exit(umaVez ? SAIDA_POR_SINAL[sinal] : 0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  if (umaVez) {
    const execucao = runOnce(portas, { recusas, timeoutMs, deveParar });
    emCurso = execucao;
    const { exitCode, rodadas, result } = await execucao;
    console.log(
      `[indexer] modo único: ${rodadas} rodada(s), estado "${result.state}", ` +
        `${result.erros} erro(s)${parando ? ', interrompido por sinal' : ''}`,
    );
    // Interrompido: quem fecha o pool e escolhe o código de saída é o tratador
    // do sinal, que está esperando exatamente esta promessa.
    if (parando) return;
    await closeDb();
    process.exit(exitCode);
  }

  console.log(`[indexer] varrendo a cada ${intervalo}s, prazo de ${timeoutMs}ms por chamada`);
  while (!parando) {
    try {
      emCurso = runCycle(portas, { recusas, timeoutMs, deveParar });
      await emCurso;
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

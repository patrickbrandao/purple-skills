/**
 * O critério de aceite do PR 3 (`docs/14-rag.md` §12): o **modo único**
 * indexa a base de smoke contra o **servidor falso** e sai com código 0; sem a
 * migration, espera sem cair.
 *
 * O que roda aqui é o caminho de verdade, ponta a ponta: o `GoogleDriver` real
 * falando o protocolo da Gemini API com o servidor falso, as queries reais do
 * `@purple-skills/db` num PostgreSQL real com pgvector. Nenhuma chave é usada
 * e nada sai da máquina — é o item 1 da §13.3.
 *
 * Fica desligado por padrão: sem `TEST_DATABASE_URL` a suíte inteira é pulada.
 *
 *   TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55433/purple_skills_test \
 *     npx vitest run apps/indexer/src/indexer.integration.test.ts
 *
 * O banco apontado é **recriado do zero** a cada execução: aponte para um
 * banco descartável, nunca para o de desenvolvimento.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  claimStaleSkills,
  clearRagRefusals,
  closeDb,
  createSkill,
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
  runMigrations,
  setRagIndexerStatus,
  setFile,
  setRagSetting,
} from '@purple-skills/db';
import {
  GEMINI_EMBEDDING_2,
  GoogleDriver,
  RagInputTooLongError,
  subirServidorFalso,
  type EmbeddingDriver,
  type ServidorFalso,
} from '@purple-skills/rag';
import { runCycle, runOnce, RecusasRag, TEXTO_SONDA, type IndexerPorts } from './indexer.js';

const url = process.env.TEST_DATABASE_URL;
const descreve = url ? describe : describe.skip;

/** O mesmo número das suítes de `database/`: elas recriam o mesmo banco. */
const SCHEMA_LOCK = 8_200_004;

const SOURCE = 'web-admin' as const;
const ACTOR = { userUuid: null, label: 'teste' };

let raw: pg.Client;
let servidor: ServidorFalso;

/** Uma base de smoke pequena: três skills, com o SKILL.md de cada uma. */
const BASE = [
  {
    slug: 'commit-conventional',
    name: 'Conventional Commits',
    description: 'Padroniza mensagens de commit',
    tags: ['git'],
    skillMd: '# Conventional Commits\n\nUse `feat:`, `fix:` e `chore:` nas mensagens de commit.',
  },
  {
    slug: 'code-review',
    name: 'Code Review',
    description: 'Revisa mudanças antes do merge',
    tags: ['qualidade'],
    skillMd: '# Code Review\n\nLeia o diff inteiro antes de comentar.',
  },
  {
    slug: 'bolo-de-fuba',
    name: 'Bolo de fubá',
    description: 'Uma receita, para provar que nem tudo casa',
    tags: ['cozinha'],
    skillMd: '# Bolo de fubá\n\nFubá, ovos, leite e erva-doce.',
  },
];

descreve('o indexador ponta a ponta', () => {
  beforeAll(async () => {
    raw = new pg.Client({ connectionString: url });
    await raw.connect();
    await raw.query('SELECT pg_advisory_lock($1)', [SCHEMA_LOCK]);
    await raw.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');

    process.env.DATABASE_URL = url;
    await runMigrations();

    for (const s of BASE) {
      await createSkill(
        {
          slug: s.slug,
          name: s.name,
          description: s.description,
          tags: s.tags,
          skillMd: s.skillMd,
        },
        SOURCE,
        ACTOR,
      );
    }

    await setRagSetting('rag.driver', 'google', SOURCE, ACTOR);
    await setRagSetting('rag.model', GEMINI_EMBEDDING_2.id, SOURCE, ACTOR);

    servidor = await subirServidorFalso();
  }, 120_000);

  afterAll(async () => {
    await servidor?.fechar();
    await closeDb();
    await raw?.query('SELECT pg_advisory_unlock($1)', [SCHEMA_LOCK]);
    await raw?.end();
  });

  /** As portas reais, com o driver apontando para o servidor falso. */
  function portasReais(over: Partial<IndexerPorts> = {}): IndexerPorts {
    const logs: string[] = [];
    return {
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
      driver: new GoogleDriver({
        // Chave qualquer: o servidor falso não a confere, e nenhuma real é usada.
        apiKey: 'sem-custo',
        baseUrl: servidor.baseUrl,
      }),
      keyPresent: true,
      log: (m) => logs.push(m),
      ...over,
    };
  }

  it('o modo único indexa a base de smoke e sai com código 0', async () => {
    const { exitCode, result } = await runOnce(portasReais());

    expect(exitCode).toBe(0);
    expect(result.erros).toBe(0);

    // Toda skill foi refatiada e todo texto ganhou vetor.
    const cobertura = await ragCoverage(result.space?.uuid ?? null);
    expect(cobertura.staleSkills).toBe(0);
    expect(cobertura.texts).toBeGreaterThanOrEqual(BASE.length * 2);
    expect(cobertura.pendingTexts).toBe(0);
    expect(cobertura.withVector).toBe(cobertura.texts);
  }, 120_000);

  it('o espaço criado é o do gemini-embedding-2, com os dois prefixos', async () => {
    const { rows } = await raw.query(
      'SELECT driver, model, dimensions, document_prefix, query_prefix FROM rag_spaces',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      driver: 'google',
      model: GEMINI_EMBEDDING_2.id,
      dimensions: GEMINI_EMBEDDING_2.dimensions,
      document_prefix: GEMINI_EMBEDDING_2.documentPrefix,
      query_prefix: GEMINI_EMBEDDING_2.queryPrefix,
    });
  });

  it('o prefixo foi aplicado na chamada, e nunca gravado no banco', async () => {
    // O que saiu para o "provedor" leva o prefixo de documento...
    const enviados = servidor.requisicoes.flatMap((r) => {
      const corpo = r.corpo as { requests?: { content: { parts: { text: string }[] } }[] };
      return (corpo.requests ?? []).map((p) => p.content.parts[0]!.text);
    });
    expect(enviados.length).toBeGreaterThan(0);
    for (const texto of enviados) {
      expect(texto.startsWith(GEMINI_EMBEDDING_2.documentPrefix)).toBe(true);
    }

    // ...e o que ficou guardado, não.
    const { rows } = await raw.query('SELECT content FROM rag_texts');
    for (const row of rows) {
      expect(String(row.content).startsWith(GEMINI_EMBEDDING_2.documentPrefix)).toBe(false);
    }
  });

  it('cada texto virou um item de requests[] — nada de vetor agregado', async () => {
    for (const requisicao of servidor.requisicoes) {
      const corpo = requisicao.corpo as {
        requests?: { content: { parts: unknown[] } }[];
      };
      for (const pedido of corpo.requests ?? []) {
        expect(pedido.content.parts).toHaveLength(1);
      }
    }
  });

  it('a segunda passada não embute nada: o vetor é endereçado pelo hash', async () => {
    const antes = servidor.requisicoes.length;
    const { exitCode, result } = await runOnce(portasReais());

    expect(exitCode).toBe(0);
    expect(result.textosEmbutidos).toBe(0);
    // Nenhuma requisição nova ao provedor: é o item 4 da §13.3, reindexar sem custo.
    expect(servidor.requisicoes.length).toBe(antes);
  }, 120_000);

  it('reindexar refatia tudo e continua sem embutir nada', async () => {
    await raw.query('UPDATE skills SET rag_stale = true');
    const antes = servidor.requisicoes.length;

    const { exitCode, result } = await runOnce(portasReais());
    expect(exitCode).toBe(0);
    expect(result.erros).toBe(0);

    // As skills foram refatiadas de novo...
    const { rows } = await raw.query('SELECT count(*)::int AS n FROM skills WHERE rag_stale');
    expect(rows[0].n).toBe(0);
    // ...e nenhum texto precisou de embedding, porque nenhum mudou.
    expect(servidor.requisicoes.length).toBe(antes);
  }, 120_000);

  it('mudar o conteúdo de uma skill embute só o texto novo', async () => {
    const antes = servidor.requisicoes.length;
    await setFile(
      'commit-conventional',
      'SKILL.md',
      '# Conventional Commits\n\nTexto novo, que ainda não tem vetor nenhum.',
      SOURCE,
      ACTOR,
    );

    const { exitCode, result } = await runOnce(portasReais());
    expect(exitCode).toBe(0);
    expect(result.erros).toBe(0);
    // Houve chamada nova...
    expect(servidor.requisicoes.length).toBeGreaterThan(antes);

    const cobertura = await ragCoverage(result.space?.uuid ?? null);
    expect(cobertura.pendingTexts).toBe(0);
  }, 120_000);

  it('publica o estado do indexador no banco, sem auditar', async () => {
    const settings = await getRagSettings();
    const estado = settings['rag.indexer.status'];
    expect(estado?.value).toBeTruthy();

    const json = JSON.parse(estado!.value!) as Record<string, unknown>;
    expect(json).toMatchObject({ driver: 'google', keyPresent: true, pendingTexts: 0 });

    // O estado é regravado a cada ciclo: auditá-lo inundaria a trilha.
    const { rows } = await raw.query(
      "SELECT count(*)::int AS n FROM audit_log WHERE action = 'rag.settings'",
    );
    // Só as duas gravações do beforeAll, nenhuma do indexador.
    expect(rows[0].n).toBe(2);
  });

  // ------------------------------------------------------------------------
  // A fila quando algo dá errado (relatórios 024, 025 e 027 da auditoria de
  // 2026-09-19), com as funções de verdade do banco: é aqui que se vê que a
  // porta do indexador e a query do `@purple-skills/db` falam da mesma coisa.

  /** As portas que o container liga: as de sempre, a recusa e a devolução. */
  const portasDoContainer = (over: Partial<IndexerPorts> = {}): IndexerPorts =>
    portasReais({ markRagTextRefused, releaseRagTextReservations, ...over });

  /** O driver de verdade sem tentativa nova: o teste não fica esperando o recuo. */
  const driverSemRecuo = () =>
    new GoogleDriver({ apiKey: 'sem-custo', baseUrl: servidor.baseUrl, maxRetries: 0 });

  const contarEstado = async (estado: 'reservado' | 'recusado') =>
    Number(
      (
        await raw.query('SELECT count(*)::int AS n FROM rag_text_status WHERE state = $1', [
          estado,
        ])
      ).rows[0].n,
    );

  it('lote que falha volta à fila na hora: o --once seguinte embute sem esperar a reserva', async () => {
    await setFile(
      'code-review',
      'SKILL.md',
      '# Code Review\n\nTexto novo, para haver o que embutir quando o provedor cair.',
      SOURCE,
      ACTOR,
    );

    servidor.simular('indisponivel');
    try {
      const falhou = await runOnce(portasDoContainer({ driver: driverSemRecuo() }));
      expect(falhou.exitCode).toBe(1);
      expect(falhou.result.lastErrorKind).toBe('unavailable');
      // A reserva não fica com quem já desistiu do lote.
      expect(await contarEstado('reservado')).toBe(0);
    } finally {
      servidor.simular(undefined);
    }

    // Antes: a fila vinha vazia por dez minutos, e esta execução saía com 0 e
    // "0 erro(s)" deixando o texto sem vetor.
    const retomou = await runOnce(portasDoContainer());
    expect(retomou.exitCode).toBe(0);
    expect((await ragCoverage(retomou.result.space?.uuid ?? null)).pendingTexts).toBe(0);
  }, 120_000);

  it('400 a tudo, inclusive ao texto-sonda: nenhuma recusa é gravada, e o estado diz por quê', async () => {
    await setFile(
      'bolo-de-fuba',
      'SKILL.md',
      '# Bolo de fubá\n\nOutra receita, para haver o que embutir quando tudo for 400.',
      SOURCE,
      ACTOR,
    );

    const antes = servidor.requisicoes.length;
    servidor.simular('conteudo-recusado');
    try {
      const { exitCode, result } = await runOnce(portasDoContainer());
      // Antes: o texto era marcado como recusado para sempre, e o modo único saía
      // com 0 e a chave "aceita pelo provedor".
      expect(exitCode).toBe(1);
      expect(result.lastErrorKind).toBe('config');
      expect(result.textosRecusados).toBe(0);
    } finally {
      servidor.simular(undefined);
    }

    expect(await contarEstado('recusado')).toBe(0);
    expect(await contarEstado('reservado')).toBe(0);

    // A sonda saiu pelo driver, com o prefixo de documento, como qualquer texto.
    const enviados = servidor.requisicoes.slice(antes).flatMap((r) => {
      const corpo = r.corpo as { requests?: { content: { parts: { text: string }[] } }[] };
      return (corpo.requests ?? []).map((p) => p.content.parts[0]!.text);
    });
    expect(enviados).toContain(`${GEMINI_EMBEDDING_2.documentPrefix}${TEXTO_SONDA}`);

    const estado = JSON.parse((await getRagSettings())['rag.indexer.status']!.value!) as Record<
      string,
      unknown
    >;
    expect(estado).toMatchObject({ lastErrorKind: 'config' });
    expect(String(estado.lastError)).toContain('texto-sonda');

    // Corrigida a causa, nada precisa de reparo: a indexação retoma sozinha.
    const retomou = await runOnce(portasDoContainer());
    expect(retomou.exitCode).toBe(0);
    expect((await ragCoverage(retomou.result.space?.uuid ?? null)).pendingTexts).toBe(0);
  }, 120_000);

  it('recusa limpa pelo painel volta a ser tentada pelo mesmo processo do indexador', async () => {
    const VENENO = '# Code Review\n\nEste é o texto que o provedor recusa pelo conteúdo.';
    await setFile('code-review', 'SKILL.md', VENENO, SOURCE, ACTOR);

    // O servidor falso recusa tudo ou nada; quem recusa **um** texto é este
    // driver, por cima do de verdade — a sonda e os outros textos passam.
    const real = new GoogleDriver({ apiKey: 'sem-custo', baseUrl: servidor.baseUrl });
    let enviosDoVeneno = 0;
    const seletivo: EmbeddingDriver = {
      id: real.id,
      models: real.models,
      embedQuery: (modelo, texto, sinal) => real.embedQuery(modelo, texto, sinal),
      embedDocuments: async (modelo, textos, sinal) => {
        if (textos.includes(VENENO)) {
          enviosDoVeneno += 1;
          throw new RagInputTooLongError('o Google recusou o conteúdo enviado (400)');
        }
        return real.embedDocuments(modelo, textos, sinal);
      },
    };
    // Um processo só: as mesmas portas e a mesma memória de recusas, do começo ao fim.
    const portas = portasDoContainer({ driver: seletivo });
    const recusas = new RecusasRag();

    const marcou = await runOnce(portas, { recusas });
    expect(marcou.exitCode).toBe(0);
    const espaco = marcou.result.space!.uuid;
    expect((await ragCoverage(espaco)).refusedTexts).toBe(1);

    // A fila do banco deixou de devolvê-lo: o ciclo seguinte nem o vê.
    const depoisDaRecusa = enviosDoVeneno;
    await runCycle(portas, { recusas });
    expect(enviosDoVeneno).toBe(depoisDaRecusa);

    // O "tentar de novo" do painel. `clearRagRefusals` não alcança a memória deste
    // processo — e não precisa: ela só guarda a recusa que o banco não guardou.
    expect(await clearRagRefusals(espaco, SOURCE, ACTOR)).toBe(1);
    const tentou = await runCycle(portas, { recusas });

    // Antes: o texto liberado era reservado, descartado em memória e segurado por
    // dez minutos a cada ciclo, até alguém reiniciar o container.
    expect(enviosDoVeneno).toBeGreaterThan(depoisDaRecusa);
    // A recusa era genuína: recusado uma vez mais e remarcado, como o reparo promete.
    expect(tentou.textosRecusados).toBe(1);
    expect((await ragCoverage(espaco)).refusedTexts).toBe(1);
    expect(await contarEstado('reservado')).toBe(0);
  }, 120_000);

  it('parada pedida entre skills: o resto do lote volta à fila, sem reserva pendurada', async () => {
    await raw.query('UPDATE skills SET rag_stale = true');
    let refatiadas = 0;
    const portas = portasDoContainer({
      replaceSkillTexts: async (uuid, textos) => {
        refatiadas += 1;
        return replaceSkillTexts(uuid, textos);
      },
    });

    // O SIGTERM chega enquanto a primeira skill do lote está sendo gravada.
    const r = await runCycle(portas, { deveParar: () => refatiadas >= 1 });

    expect(r.skillsRefatiadas).toBe(1);
    expect(r.continuar).toBe(false);
    // As que nem começaram voltaram a pendentes e **sem** reserva: entram no
    // ciclo seguinte, e não quando a reserva delas vencer.
    const pendentes = await raw.query('SELECT count(*)::int AS n FROM skills WHERE rag_stale');
    expect(pendentes.rows[0].n).toBe(BASE.length - 1);
    const reservas = await raw.query('SELECT count(*)::int AS n FROM rag_skill_claims');
    expect(reservas.rows[0].n).toBe(0);
    expect((await ragCoverage(null)).staleSkills).toBe(BASE.length - 1);

    const retomou = await runOnce(portasDoContainer());
    expect(retomou.exitCode).toBe(0);
    expect((await ragCoverage(retomou.result.space?.uuid ?? null)).staleSkills).toBe(0);
  }, 120_000);

  it('sem a migration, o modo único espera sem cair', async () => {
    await raw.query('DROP TABLE IF EXISTS rag_vectors, rag_skill_texts, rag_texts, rag_spaces CASCADE');

    const { exitCode, rodadas, result } = await runOnce(portasReais());
    expect(result.state).toBe('esperando-migration');
    expect(rodadas).toBe(1);
    expect(exitCode).toBe(0);
    expect(await ragSchemaReady()).toBe(false);
  }, 120_000);
});

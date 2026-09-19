/**
 * O ciclo do indexador, com as portas falsas — sem banco e sem rede.
 *
 * O que estes testes protegem é o comportamento que a §7 exige do ambiente
 * incompleto: sem a migration ele **espera** em vez de cair, sem chave ele
 * refatia mas não embute, e com o driver `off` ele não faz nada além de
 * publicar o estado. São justamente os casos em que um `throw` deixaria o
 * container em restart loop.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  FakeDriver,
  MODELO_FALSO,
  RagInputTooLongError,
  RagUnavailableError,
  chunkSkill,
  textSha256,
} from '@purple-skills/rag';
import { runCycle, runOnce, RecusasRag, RESERVA_MS, type IndexerPorts } from './indexer.js';

/**
 * O critério de tipo (`.svg` e binário fora da divisão) mora no
 * `@purple-skills/rag`, e este app resolve o pacote pelo `dist/`. Enquanto o
 * pacote não for recompilado, o teste do anexo que não é texto não tem o que
 * exercer — e falhar ali apontaria para o build, não para o indexador.
 */
const CRITERIO_DE_TIPO_NO_BUILD = chunkSkill(
  {
    name: 'x',
    description: null,
    tags: [],
    files: [{ id: 'f', relativePath: 'logo.svg', textContent: '<svg/>' }],
  },
  MODELO_FALSO,
).skipped.some((s) => (s.reason as string) === 'nao-e-texto');

const ESPACO = {
  uuid: '00000000-0000-7000-8000-00000000fa11',
  driver: 'fake',
  model: MODELO_FALSO.id,
  dimensions: MODELO_FALSO.dimensions,
  documentPrefix: MODELO_FALSO.documentPrefix,
  queryPrefix: MODELO_FALSO.queryPrefix,
  createdAt: new Date().toISOString(),
};

const SKILL = {
  uuid: '00000000-0000-7000-8000-000000000001',
  slug: 'commit-conventional',
  name: 'Conventional Commits',
  description: 'Padroniza mensagens de commit',
  tags: ['git'],
  files: [
    {
      id: '00000000-0000-7000-8000-0000000000f1',
      relativePath: 'SKILL.md',
      content: '# Conventional Commits\n\nUse `feat:` e `fix:`.',
      sha256: textSha256('# Conventional Commits\n\nUse `feat:` e `fix:`.'),
      sizeBytes: 44,
    },
  ],
};

/** Portas falsas, com um estado mínimo em memória. */
function portas(over: Partial<IndexerPorts> = {}) {
  const logs: string[] = [];
  const status: Record<string, unknown>[] = [];
  const ocorrencias = new Map<string, unknown[]>();
  const vetores = new Map<string, number[]>();
  let pendentes = [{ sha256: textSha256('texto pendente'), content: 'texto pendente' }];
  let reservaveis = [SKILL.uuid];
  const liberadas: string[] = [];

  const base: IndexerPorts = {
    ragSchemaReady: async () => true,
    getRagSettings: async () => ({
      'rag.driver': { value: 'google' },
      'rag.model': { value: MODELO_FALSO.id },
    }),
    resolveRagSpace: async () => ESPACO,
    claimStaleSkills: async (limit) => {
      const lote = reservaveis.slice(0, limit);
      reservaveis = reservaveis.slice(limit);
      return lote;
    },
    releaseStaleSkill: async (uuid) => {
      liberadas.push(uuid);
    },
    readSkillForRag: async (uuid) => (uuid === SKILL.uuid ? SKILL : null),
    replaceSkillTexts: async (skillUuid, texts) => {
      ocorrencias.set(skillUuid, [...texts]);
      return texts.length;
    },
    listPendingRagTexts: async (_space, limit) => {
      const lote = pendentes.slice(0, limit);
      pendentes = pendentes.slice(limit);
      return lote;
    },
    insertRagVectors: async (_space, entradas) => {
      for (const e of entradas) vetores.set(e.sha256.toString('hex'), [...e.embedding]);
      return entradas.length;
    },
    ragCoverage: async () => ({
      texts: 2,
      withVector: 1,
      pendingTexts: 1,
      refusedTexts: 0,
      staleSkills: 0,
    }),
    setRagIndexerStatus: async (s) => {
      status.push(s);
    },
    driver: new FakeDriver(),
    keyPresent: true,
    log: (m) => logs.push(m),
    now: () => new Date('2026-09-15T22:00:00Z'),
    ...over,
  };

  return { ports: base, logs, status, ocorrencias, vetores, liberadas };
}

/**
 * Um banco de mentira com o contrato do `025`: a fila exclui o que foi recusado
 * e o que está reservado no prazo, a leitura com `reserveMs` reserva o que
 * devolve, o vetor baixa a reserva e a recusa a substitui (os dois estados são
 * exclusivos).
 *
 * As portas de `portas()` guardam tudo em memória **do teste**, que é o que o
 * `RecusasRag` também faz: com elas não dá para ver a diferença entre lembrar no
 * processo e lembrar no banco. É essa diferença que estas portas exercem —
 * trocar as portas e a memória, e manter só o "banco", é o reinício do container.
 */
function banco(textos: readonly string[], agora: () => number = () => Date.now()) {
  const acervo = textos.map((content) => ({ sha256: textSha256(content), content }));
  const comVetor = new Set<string>();
  const recusados = new Set<string>();
  /** hash → quando a reserva vence. Vencida, o texto volta à fila sozinho. */
  const reservas = new Map<string, number>();
  const hex = (t: { sha256: Buffer }) => t.sha256.toString('hex');
  const livre = (h: string) =>
    !comVetor.has(h) && !recusados.has(h) && (reservas.get(h) ?? 0) <= agora();

  const portas: Pick<
    IndexerPorts,
    'listPendingRagTexts' | 'insertRagVectors' | 'markRagTextRefused'
  > = {
    listPendingRagTexts: async (_espaco, limite, options) => {
      const lote = acervo.filter((t) => livre(hex(t))).slice(0, limite);
      if (options?.reserveMs !== undefined) {
        for (const t of lote) reservas.set(hex(t), agora() + options.reserveMs);
      }
      return lote;
    },
    insertRagVectors: async (_espaco, entradas) => {
      for (const e of entradas) {
        comVetor.add(e.sha256.toString('hex'));
        // Quem encerra a reserva é o vetor: daí em diante é ele que exclui o
        // texto da fila, e a tabela de estado não cresce até o tamanho do acervo.
        reservas.delete(e.sha256.toString('hex'));
      }
      return entradas.length;
    },
    markRagTextRefused: async (_espaco, sha256) => {
      recusados.add(sha256.toString('hex'));
      reservas.delete(sha256.toString('hex'));
    },
  };

  return { acervo, comVetor, recusados, reservas, portas };
}

describe('o ambiente incompleto', () => {
  it('sem a migration, espera sem cair e diz isso no log', async () => {
    const { ports, logs, status } = portas({ ragSchemaReady: async () => false });
    const r = await runCycle(ports);

    expect(r.state).toBe('esperando-migration');
    expect(logs[0]).toContain('esperando a migration');
    // Não publica estado nem toca no acervo: as tabelas não existem.
    expect(status).toHaveLength(0);
  });

  it('com o driver off, publica o estado e não refatia nada', async () => {
    const claim = vi.fn(async () => []);
    const { ports, logs, status } = portas({
      getRagSettings: async () => ({ 'rag.driver': { value: 'off' } }),
      claimStaleSkills: claim,
    });
    const r = await runCycle(ports);

    expect(r.state).toBe('desligado');
    expect(claim).not.toHaveBeenCalled();
    expect(status[0]).toMatchObject({ driver: 'off', keyPresent: true });
    expect(logs.join('\n')).toContain('driver desligado');
  });

  it('sem chave, refatia mas não embute — e o estado diz keyPresent false', async () => {
    const embutir = vi.fn();
    const { ports, status, ocorrencias, logs } = portas({
      driver: null,
      keyPresent: false,
      insertRagVectors: embutir,
    });
    const r = await runCycle(ports);

    expect(r.state).toBe('sem-chave');
    expect(r.skillsRefatiadas).toBe(1);
    expect(embutir).not.toHaveBeenCalled();
    expect(ocorrencias.get(SKILL.uuid)).toBeDefined();
    expect(status[0]).toMatchObject({ keyPresent: false });
    expect(logs.join('\n')).toContain('nenhum texto embutido');
  });

  it('sem chave, o log cita a variável do driver configurado, não a do Google', async () => {
    const { ports, logs } = portas({
      getRagSettings: async () => ({ 'rag.driver': { value: 'openai' } }),
      driver: null,
      keyPresent: false,
    });
    const r = await runCycle(ports);

    expect(r.state).toBe('sem-chave');
    // O nome sai do registro: escrito à mão, ele mandava toda instalação
    // conferir a chave do Google, qualquer que fosse o driver em uso.
    expect(logs.join('\n')).toContain('sem RAG_OPENAI_API_KEY');
    expect(logs.join('\n')).not.toContain('RAG_GOOGLE_API_KEY');
  });
});

describe('o ciclo normal', () => {
  it('refatia a skill em metadados mais arquivo, sem prefixo no texto', async () => {
    const { ports, ocorrencias } = portas();
    await runCycle(ports);

    const textos = ocorrencias.get(SKILL.uuid) as { source: string; content: string }[];
    expect(textos.map((t) => t.source)).toEqual(['meta', 'file']);
    // O texto guardado é o canônico: o prefixo é do driver, na hora da chamada.
    for (const t of textos) {
      expect(t.content.startsWith(MODELO_FALSO.documentPrefix)).toBe(false);
    }
    expect(textos[0]!.content).toBe('Conventional Commits\nPadroniza mensagens de commit\ngit');
  });

  it.skipIf(!CRITERIO_DE_TIPO_NO_BUILD)(
    'anexo que não é texto de skill não vira texto — e o log diz que ele não saiu',
    async () => {
      const svg = '<svg><path d="M0 0 L9 9"/></svg>';
      const comSvg = {
        ...SKILL,
        files: [
          ...SKILL.files,
          {
            id: '00000000-0000-7000-8000-0000000000f2',
            relativePath: 'assets/logo.svg',
            content: svg,
            sha256: textSha256(svg),
            sizeBytes: svg.length,
          },
        ],
      };
      const { ports, ocorrencias, logs } = portas({ readSkillForRag: async () => comSvg });
      await runCycle(ports);

      const textos = ocorrencias.get(SKILL.uuid) as { source: string; relativePath: string }[];
      expect(textos.map((t) => t.relativePath)).toEqual(['', 'SKILL.md']);
      expect(logs.join('\n')).toContain(
        'assets/logo.svg pulado, image/svg+xml não é texto de skill',
      );
    },
  );

  it('embute os textos pendentes e grava os vetores', async () => {
    const { ports, vetores } = portas();
    const r = await runCycle(ports);

    expect(r.textosEmbutidos).toBe(1);
    const hash = textSha256('texto pendente').toString('hex');
    expect(vetores.get(hash)).toHaveLength(MODELO_FALSO.dimensions);
  });

  it('o resumo do ciclo vai para o log com skills, textos e tokens', async () => {
    const { ports, logs } = portas();
    await runCycle(ports);

    const resumo = logs.find((l) => l.includes('espaço'));
    expect(resumo).toContain('1 skills refatiadas');
    expect(resumo).toContain('1 textos embutidos');
    expect(resumo).toContain('0 erros');
  });

  it('o espaço resolvido leva os prefixos do modelo', async () => {
    const resolver = vi.fn(async () => ESPACO);
    const { ports } = portas({ resolveRagSpace: resolver });
    await runCycle(ports);

    expect(resolver).toHaveBeenCalledWith({
      driver: 'fake',
      model: MODELO_FALSO.id,
      dimensions: MODELO_FALSO.dimensions,
      documentPrefix: MODELO_FALSO.documentPrefix,
      queryPrefix: MODELO_FALSO.queryPrefix,
    });
  });

  it('cada chamada ao provedor leva prazo próprio', async () => {
    const driver = new FakeDriver();
    const sinais: (AbortSignal | undefined)[] = [];
    const original = driver.embedDocuments.bind(driver);
    vi.spyOn(driver, 'embedDocuments').mockImplementation(async (model, texts, signal) => {
      sinais.push(signal);
      return original(model, texts);
    });
    const { ports } = portas({ driver });

    await runCycle(ports, { timeoutMs: 5000 });

    // Sem prazo, um provedor que aceita a conexão e não responde segurava a
    // rodada pelos prazos internos do undici vezes as tentativas.
    expect(sinais).toHaveLength(1);
    expect(sinais[0]).toBeInstanceOf(AbortSignal);
    // O prazo é do lote: ele começa a correr agora, não no lote anterior.
    expect(sinais[0]!.aborted).toBe(false);
  });

  it('texto pago cujo vetor já existia conta como processado, não como embutido', async () => {
    // A gravação ignora conflito: a réplica que perde a corrida recebe zero e
    // pagou igual. Confundir os dois números é achar que a fila não andou.
    const { ports, logs } = portas({ insertRagVectors: async () => 0 });
    const r = await runCycle(ports);

    expect(r.textosProcessados).toBe(1);
    expect(r.textosEmbutidos).toBe(0);
    expect(r.erros).toBe(0);
    expect(logs.find((l) => l.includes('espaço'))).toContain('1 já tinham vetor');
  });

  it('publica o estado com a cobertura e o espaço', async () => {
    const { ports, status } = portas();
    await runCycle(ports);

    expect(status[0]).toMatchObject({
      at: '2026-09-15T22:00:00.000Z',
      driver: 'google',
      model: MODELO_FALSO.id,
      spaceUuid: ESPACO.uuid,
      keyPresent: true,
      texts: 2,
      withVector: 1,
      pendingTexts: 1,
      lastError: null,
    });
  });
});

describe('as falhas', () => {
  it('skill que sumiu entre a reserva e a leitura não é erro', async () => {
    const { ports, liberadas } = portas({ readSkillForRag: async () => null });
    const r = await runCycle(ports);

    expect(r.erros).toBe(0);
    expect(r.skillsRefatiadas).toBe(0);
    expect(liberadas).toHaveLength(0);
  });

  it('falha ao refatiar devolve a skill para pendente', async () => {
    const { ports, liberadas, logs } = portas({
      replaceSkillTexts: async () => {
        throw new Error('constraint violada');
      },
    });
    const r = await runCycle(ports);

    expect(r.erros).toBe(1);
    expect(liberadas).toEqual([SKILL.uuid]);
    expect(logs.join('\n')).toContain('falha ao refatiar');
  });

  it('chave recusada encerra o ciclo em vez de queimar requisição', async () => {
    const driver = new FakeDriver();
    const { RagAuthError } = await import('@purple-skills/rag');
    vi.spyOn(driver, 'embedDocuments').mockRejectedValue(new RagAuthError('chave recusada'));
    const { ports } = portas({ driver });

    const r = await runCycle(ports);
    expect(r.erros).toBe(1);
    expect(r.continuar).toBe(false);
    expect(r.lastError).toContain('chave recusada');
  });

  it('erro temporário não encerra o ciclo: a rodada seguinte tenta de novo', async () => {
    const driver = new FakeDriver();
    const { RagUnavailableError } = await import('@purple-skills/rag');
    vi.spyOn(driver, 'embedDocuments').mockRejectedValue(new RagUnavailableError('503'));
    const { ports } = portas({ driver });

    const r = await runCycle(ports);
    expect(r.erros).toBe(1);
    expect(r.continuar).toBe(true);
  });

  it('o erro aparece no estado publicado, com a hora', async () => {
    const { ports, status } = portas({
      replaceSkillTexts: async () => {
        throw new Error('deu ruim');
      },
    });
    await runCycle(ports);

    expect(status[0]).toMatchObject({
      lastError: 'deu ruim',
      lastErrorAt: '2026-09-15T22:00:00.000Z',
    });
  });
});

describe('o modo único', () => {
  it('repete até não haver pendência e sai com 0', async () => {
    const { ports } = portas();
    const { exitCode, rodadas, result } = await runOnce(ports);

    expect(exitCode).toBe(0);
    // Uma rodada que trabalha, mais a que não acha nada e encerra.
    expect(rodadas).toBeGreaterThanOrEqual(2);
    expect(result.skillsRefatiadas).toBe(0);
    expect(result.textosEmbutidos).toBe(0);
  });

  it('sai com 1 quando houve erro', async () => {
    const { ports } = portas({
      replaceSkillTexts: async () => {
        throw new Error('falhou');
      },
    });
    const { exitCode } = await runOnce(ports);
    expect(exitCode).toBe(1);
  });

  it('sem a migration, sai sem ficar em laço', async () => {
    const { ports } = portas({ ragSchemaReady: async () => false });
    const { exitCode, rodadas, result } = await runOnce(ports);

    expect(result.state).toBe('esperando-migration');
    expect(rodadas).toBe(1);
    expect(exitCode).toBe(0);
  });

  it('não encerra com a fila cheia quando a gravação foi ignorada por conflito', async () => {
    // Duas réplicas na mesma fila sem reserva: esta pagou pelo lote e a outra
    // já tinha gravado. Pelo número de **gravados**, a rodada concluiria "não há
    // mais nada a fazer" logo depois de ter pago — com a fila ainda andando.
    const comVetor = new Set<string>();
    const acervo = ['um', 'dois', 'tres'].map((c) => ({ sha256: textSha256(c), content: c }));
    const { ports } = portas({
      listPendingRagTexts: async (_espaco, limite) =>
        acervo.filter((t) => !comVetor.has(t.sha256.toString('hex'))).slice(0, limite),
      insertRagVectors: async (_espaco, entradas) => {
        for (const e of entradas) comVetor.add(e.sha256.toString('hex'));
        return 0;
      },
    });

    // Um texto por rodada, para a fila precisar de mais de uma.
    const { exitCode, rodadas, result } = await runOnce(ports, { textBatch: 1 });

    expect(exitCode).toBe(0);
    expect(comVetor.size).toBe(3);
    expect(rodadas).toBeGreaterThanOrEqual(4);
    // A última rodada é a que não achou mais nada — é ela que encerra.
    expect(result.textosProcessados).toBe(0);
  });
});

/**
 * Textos e vetores que nenhuma consulta lê: a skill foi editada ou apagada, as
 * ocorrências saíram e o texto canônico ficou. A FK de `rag_skill_texts` é sem
 * cascata de propósito (texto em uso não pode ser apagado), então quem apaga é
 * a coleta — e ela precisa rodar **depois** de o refatiamento ter commitado.
 */
describe('os textos órfãos', () => {
  it('coleta depois de refatiar e embutir, e diz no log quantos saíram', async () => {
    const ordem: string[] = [];
    const { ports, logs } = portas({
      replaceSkillTexts: async (_uuid, texts) => {
        ordem.push('refatiar');
        return texts.length;
      },
      insertRagVectors: async (_espaco, entradas) => {
        ordem.push('embutir');
        return entradas.length;
      },
      collectOrphanRagTexts: async (limite) => {
        ordem.push(`coletar ${limite}`);
        return 3;
      },
    });

    await runCycle(ports, { orphanBatch: 100 });

    expect(ordem).toEqual(['refatiar', 'embutir', 'coletar 100']);
    expect(logs.join('\n')).toContain('3 textos órfãos coletados');
  });

  it('sem a porta do banco, o ciclo roda igual', async () => {
    const { ports, logs } = portas();
    const r = await runCycle(ports);

    expect(r.state).toBe('ok');
    expect(r.erros).toBe(0);
    expect(logs.join('\n')).not.toContain('órfãos');
  });

  it('falha na coleta não conta como erro do ciclo', async () => {
    const { ports, logs } = portas({
      collectOrphanRagTexts: async () => {
        throw new Error('deadlock detectado');
      },
    });
    const r = await runCycle(ports);

    // O acervo continua correto, só maior do que precisa: contar isso como erro
    // faria o `--once` sair com 1 por causa de uma faxina.
    expect(r.erros).toBe(0);
    expect(r.lastError).toBeNull();
    expect(logs.join('\n')).toContain('não deu para coletar os textos órfãos');
  });
});

/**
 * O bloqueio de cabeça de fila: a fila é por `created_at` e sem reserva, então
 * um texto que o provedor recusa **para sempre** volta em todo ciclo, é pago de
 * novo a cada intervalo e nada atrás dele chega a ser tentado.
 */
describe('o texto que o provedor recusa de vez', () => {
  const VENENO = 'texto que o provedor nunca aceita';
  const BOM = 'texto pendente';

  /** Fila como a do banco: os mais antigos **sem vetor**, sempre na mesma ordem. */
  function fila() {
    const comVetor = new Set<string>();
    // O venenoso é o mais antigo: é ele que tranca os outros.
    const acervo = [
      { sha256: textSha256(VENENO), content: VENENO },
      { sha256: textSha256(BOM), content: BOM },
    ];

    const pedacos: Pick<IndexerPorts, 'listPendingRagTexts' | 'insertRagVectors'> = {
      listPendingRagTexts: async (_espaco, limite) =>
        acervo.filter((t) => !comVetor.has(t.sha256.toString('hex'))).slice(0, limite),
      insertRagVectors: async (_espaco, entradas) => {
        for (const e of entradas) comVetor.add(e.sha256.toString('hex'));
        return entradas.length;
      },
    };
    return { comVetor, pedacos };
  }

  /** Driver que recusa **sempre** o texto venenoso, como um 400 estável. */
  function driverQueRecusa() {
    const driver = new FakeDriver();
    const chamadas: string[][] = [];
    const original = driver.embedDocuments.bind(driver);
    vi.spyOn(driver, 'embedDocuments').mockImplementation(async (model, texts) => {
      chamadas.push([...texts]);
      if (texts.includes(VENENO)) {
        throw new RagInputTooLongError('o provedor recusou o conteúdo enviado (400)');
      }
      return original(model, texts);
    });
    return { driver, chamadas };
  }

  it('não conta como erro, sai da fila e não impede os textos de trás', async () => {
    const { comVetor, pedacos } = fila();
    const { driver } = driverQueRecusa();
    const { ports, logs, status } = portas({
      ...pedacos,
      driver,
      // Como o banco responde depois da marca: o recusado continua pendente, e
      // `refusedTexts` é a explicação de uma cobertura que não vai fechar.
      ragCoverage: async () => ({
        texts: 2,
        withVector: 1,
        pendingTexts: 1,
        refusedTexts: 1,
        staleSkills: 0,
      }),
    });

    const r = await runCycle(ports, { recusas: new RecusasRag() });

    expect(r.textosRecusados).toBe(1);
    // Recusa tratada não é falha do ciclo: o `--once` não pode sair com 1 por
    // causa de um texto que nunca vai passar.
    expect(r.erros).toBe(0);
    // O texto de trás foi embutido no mesmo ciclo, apesar do lote ter falhado.
    expect(r.textosEmbutidos).toBe(1);
    expect(comVetor.has(textSha256(BOM).toString('hex'))).toBe(true);
    expect(logs.join('\n')).toContain('recusado pelo provedor');
    // O número publicado é o do **banco** (`ragCoverage`), não o tamanho da
    // lista em memória: ele sobrevive ao reinício e enxerga a recusa que outra
    // réplica gravou.
    expect(status[0]).toMatchObject({ refusedTexts: 1 });
  });

  it('a recusa vai para o banco, e o texto não volta depois de recriar o indexador', async () => {
    const bd = banco([VENENO, BOM]);
    const { driver, chamadas } = driverQueRecusa();
    const veneno = textSha256(VENENO).toString('hex');

    // Primeiro processo: acha o culpado, marca a recusa e embute o resto.
    const primeiro = portas({ ...bd.portas, driver });
    const r1 = await runCycle(primeiro.ports, { recusas: new RecusasRag() });

    expect(r1.textosRecusados).toBe(1);
    expect(r1.textosEmbutidos).toBe(1);
    expect([...bd.recusados]).toEqual([veneno]);
    // Recusa e reserva são estados exclusivos: marcar não pode deixar para trás
    // uma reserva que devolveria o texto à fila no vencimento.
    expect(bd.reservas.has(veneno)).toBe(false);

    const enviosDoVeneno = chamadas.filter((c) => c.includes(VENENO)).length;

    // O reinício do container: portas novas, `RecusasRag` novo. Só o banco
    // lembra — e é o que a marca em memória sozinha não dava.
    const segundo = portas({ ...bd.portas, driver, claimStaleSkills: async () => [] });
    const r2 = await runCycle(segundo.ports, { recusas: new RecusasRag() });

    expect(chamadas.filter((c) => c.includes(VENENO)).length).toBe(enviosDoVeneno);
    expect(r2.textosProcessados).toBe(0);
    expect(r2.textosRecusados).toBe(0);
    expect(r2.erros).toBe(0);
  });

  it('a recusa que não chega ao banco ainda vale para este processo', async () => {
    // Relógio do teste: depois do primeiro ciclo ele passa do prazo da reserva,
    // e o venenoso volta à fila — é exatamente o caso que a rede de segurança
    // em memória cobre, já que a marca no banco não foi gravada.
    let agora = 0;
    const bd = banco([VENENO, BOM], () => agora);
    const { driver, chamadas } = driverQueRecusa();
    const { ports, logs } = portas({
      ...bd.portas,
      driver,
      markRagTextRefused: async () => {
        throw new Error('sem conexão com o banco');
      },
    });
    const recusas = new RecusasRag();

    const r1 = await runCycle(ports, { recusas });
    const enviosDoVeneno = chamadas.filter((c) => c.includes(VENENO)).length;
    agora += RESERVA_MS + 1;
    const r2 = await runCycle(ports, { recusas });

    // A gravação falhou (e o log diz isso), mas a rede de segurança do processo
    // segurou: nem erro no ciclo, nem uma segunda chamada paga pelo mesmo texto.
    expect(logs.join('\n')).toContain('não deu para marcar o texto');
    expect(r1.erros).toBe(0);
    expect(r2.erros).toBe(0);
    expect(chamadas.filter((c) => c.includes(VENENO)).length).toBe(enviosDoVeneno);
  });

  it('no ciclo seguinte ele não é reenviado: a fila anda', async () => {
    const { pedacos } = fila();
    const { driver, chamadas } = driverQueRecusa();
    const { ports } = portas({ ...pedacos, driver });
    const recusas = new RecusasRag();

    await runCycle(ports, { recusas });
    const enviosDoVeneno = chamadas.filter((c) => c.includes(VENENO)).length;
    const r = await runCycle(ports, { recusas });

    // Nenhuma requisição nova com o texto recusado — nem nenhuma requisição.
    expect(chamadas.filter((c) => c.includes(VENENO)).length).toBe(enviosDoVeneno);
    expect(r.textosRecusados).toBe(0);
    expect(r.textosEmbutidos).toBe(0);
    expect(r.erros).toBe(0);
  });

  it('o lote que já passou fica gravado quando o seguinte falha', async () => {
    // Três lotes de um texto cada: 30 mil caracteres e `maxBatchChars` é 60 mil.
    const primeiro = 'a'.repeat(30_000);
    const segundo = 'b'.repeat(30_000);
    const terceiro = 'c'.repeat(30_000);
    const acervo = [primeiro, segundo, terceiro].map((content) => ({
      sha256: textSha256(content),
      content,
    }));

    const gravados: string[] = [];
    const enviados: string[] = [];
    const driver = new FakeDriver();
    const original = driver.embedDocuments.bind(driver);
    vi.spyOn(driver, 'embedDocuments').mockImplementation(async (model, texts) => {
      enviados.push(...texts);
      if (texts.some((t) => t.startsWith('b'))) throw new RagUnavailableError('503');
      return original(model, texts);
    });

    const { ports } = portas({
      driver,
      listPendingRagTexts: async () => acervo,
      insertRagVectors: async (_espaco, entradas) => {
        for (const e of entradas) gravados.push(e.sha256.toString('hex'));
        return entradas.length;
      },
    });

    const r = await runCycle(ports, { recusas: new RecusasRag() });

    // O primeiro lote estava pago: ele fica gravado, mesmo com o erro adiante.
    expect(gravados).toEqual([textSha256(primeiro).toString('hex')]);
    expect(r.textosEmbutidos).toBe(1);
    expect(r.erros).toBe(1);
    // Erro que não é de conteúdo encerra a etapa: o `ClienteHttp` já recuou e
    // tentou de novo antes de chegar aqui.
    expect(r.continuar).toBe(true);
    expect(enviados.some((t) => t.startsWith('c'))).toBe(false);
  });
});

/**
 * A reserva da fila (`025`): duas réplicas do indexador leem a mesma lista, e
 * sem reserva as duas pagam ao provedor pelo mesmo texto — o banco fica certo e
 * a fatura dobra. A reserva é gravada pela própria leitura, vence sozinha e é
 * baixada pelo vetor.
 */
describe('a reserva da fila de textos', () => {
  const UM = 'primeiro texto da fila';
  const DOIS = 'segundo texto da fila';

  it('a leitura pede a reserva, com o prazo que cobre o caminho todo do texto', async () => {
    const fila = vi.fn(async () => []);
    const { ports } = portas({ listPendingRagTexts: fila });

    await runCycle(ports, { textBatch: 7 });

    // Sem o terceiro argumento a leitura é pura e as duas réplicas levam o mesmo
    // lote. O limite é o do lote: pedir a mais passaria a reservar a mais.
    expect(fila).toHaveBeenCalledWith(ESPACO.uuid, 7, { reserveMs: RESERVA_MS });
  });

  it('o texto reservado não sai para a segunda réplica', async () => {
    const bd = banco([UM, DOIS]);

    // A réplica A fica pendurada no provedor: é aí, com o texto já reservado e
    // ainda sem vetor, que a B lê a fila. É a janela em que o `SKIP LOCKED` da
    // leitura não serviria — o bloqueio morre no fim da transação e a chamada ao
    // provedor é fora dela.
    let soltar = (): void => {};
    let chegou = (): void => {};
    const presa = new Promise<void>((r) => {
      soltar = r;
    });
    const noProvedor = new Promise<void>((r) => {
      chegou = r;
    });
    const driverA = new FakeDriver();
    const originalA = driverA.embedDocuments.bind(driverA);
    vi.spyOn(driverA, 'embedDocuments').mockImplementation(async (model, texts) => {
      chegou();
      await presa;
      return originalA(model, texts);
    });

    const replicaA = portas({ ...bd.portas, driver: driverA, claimStaleSkills: async () => [] });
    const driverB = new FakeDriver();
    const enviadosB: string[] = [];
    const originalB = driverB.embedDocuments.bind(driverB);
    vi.spyOn(driverB, 'embedDocuments').mockImplementation(async (model, texts) => {
      enviadosB.push(...texts);
      return originalB(model, texts);
    });
    const replicaB = portas({ ...bd.portas, driver: driverB, claimStaleSkills: async () => [] });

    const cicloA = runCycle(replicaA.ports, { textBatch: 2 });
    await noProvedor;
    const rB = await runCycle(replicaB.ports, { textBatch: 2 });
    soltar();
    const rA = await cicloA;

    expect(rA.textosProcessados).toBe(2);
    // Nenhum texto sai para as duas: a B não pagou por nada, em vez de pagar de
    // novo pelos mesmos dois (era A=4 B=4, repetidos=4, na medição do dba).
    expect(rB.textosProcessados).toBe(0);
    expect(enviadosB).toEqual([]);
    expect(bd.comVetor.size).toBe(2);
    // O vetor encerra a reserva: a tabela de estado não cresce com o acervo.
    expect(bd.reservas.size).toBe(0);
  });

  it('reserva vencida devolve o texto à fila: indexador morto não a estaciona', async () => {
    let agora = 0;
    const bd = banco([UM], () => agora);
    // Uma réplica que reservou e morreu antes de gravar o vetor.
    await bd.portas.listPendingRagTexts(ESPACO.uuid, 2, { reserveMs: RESERVA_MS });

    const { ports } = portas({ ...bd.portas, claimStaleSkills: async () => [] });
    const presa = await runCycle(ports, { textBatch: 2 });
    agora += RESERVA_MS + 1;
    const solta = await runCycle(ports, { textBatch: 2 });

    expect(presa.textosProcessados).toBe(0);
    expect(solta.textosProcessados).toBe(1);
    expect(bd.comVetor.size).toBe(1);
  });
});

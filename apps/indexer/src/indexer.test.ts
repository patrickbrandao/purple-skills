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
import { FakeDriver, MODELO_FALSO, textSha256 } from '@purple-skills/rag';
import { runCycle, runOnce, type IndexerPorts } from './indexer.js';

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
    ragCoverage: async () => ({ texts: 2, withVector: 1, pendingTexts: 1, staleSkills: 0 }),
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
});

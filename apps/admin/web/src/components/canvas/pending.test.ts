import { describe, expect, it } from 'vitest';
import type { LinkFlags } from '../../api.js';
import { createWriteQueue, effectivePorts, hasPending, nextPorts, unlinkMarks, type Pending } from './pending.js';
import { flagsToPorts, portsToFlags, type Port, type Target } from './types.js';

const SKILL: Target = { kind: 'skill', slug: 'deploy' };
const flags = (...ports: Port[]): LinkFlags => portsToFlags(ports);

/** O que um gesto manda gravar, como `togglePort` e `onConnect` calculam. */
const gesto = (gravado: LinkFlags, pending: Pending[], port: Port, on: boolean) =>
  nextPorts(effectivePorts(gravado, pending, SKILL), port, on);

describe('portas que valem agora = gravadas + em andamento', () => {
  it('sem nada em andamento, são as gravadas, na ordem das portas', () => {
    expect(effectivePorts(flags('prompts', 'tools'), [], SKILL)).toEqual(['tools', 'prompts']);
  });

  it('dois ✕ seguidos no mesmo item chegam à última porta (tasks/053)', () => {
    const gravado = flags('tools', 'resources');
    // 1º ✕, em Tools: grava {resources}. O detalhe ainda não voltou.
    expect(gesto(gravado, [], 'tools', false)).toEqual(['resources']);
    const pending: Pending[] = [{ target: SKILL, port: 'tools', kind: 'remove' }];

    // 2º ✕, em Resources, com o MESMO `gravado`: o conjunto tem de sair vazio
    // — é o que dispara a confirmação de "última porta" e o DELETE do vínculo.
    expect(gesto(gravado, pending, 'resources', false)).toEqual([]);

    // A conta antiga partia só do gravado e mandava {tools}: o `PUT` substitui
    // as três flags, então religava a porta que o 1º gesto tinha desligado.
    expect(nextPorts(flagsToPorts(gravado), 'resources', false)).toEqual(['tools']);
  });

  it('marcar uma porta e desmarcar outra na gaveta não pergunta "era a última?" (tasks/053)', () => {
    const gravado = flags('tools');
    const pending: Pending[] = [{ target: SKILL, port: 'resources', kind: 'add' }];
    // Desmarcar Tools com Resources em andamento deixa {resources}, não vazio.
    expect(gesto(gravado, pending, 'tools', false)).toEqual(['resources']);
    // A conta antiga dava vazio: pergunta falsa e, confirmada, DELETE do vínculo.
    expect(nextPorts(flagsToPorts(gravado), 'tools', false)).toEqual([]);
  });

  it('as marcas valem na ordem dos gestos', () => {
    const pending: Pending[] = [
      { target: SKILL, port: 'tools', kind: 'remove' },
      { target: SKILL, port: 'tools', kind: 'add' },
    ];
    expect(effectivePorts(flags('tools'), pending, SKILL)).toEqual(['tools']);
    expect(effectivePorts(flags('tools'), [...pending].reverse(), SKILL)).toEqual([]);
  });

  it('a marca de um alvo não mexe em outro — nem no catálogo de mesmo slug', () => {
    const pending: Pending[] = [
      { target: { kind: 'catalog', slug: 'deploy' }, port: 'tools', kind: 'remove' },
      { target: { kind: 'skill', slug: 'outra' }, port: 'tools', kind: 'remove' },
    ];
    expect(effectivePorts(flags('tools'), pending, SKILL)).toEqual(['tools']);
    expect(hasPending(pending, SKILL)).toBe(false);
    expect(hasPending(pending, { kind: 'catalog', slug: 'deploy' })).toBe(true);
  });

  it('o gesto que não muda nada não grava', () => {
    expect(gesto(flags('tools'), [], 'tools', true)).toBeNull();
    expect(gesto(flags('tools'), [], 'prompts', false)).toBeNull();
    // Ligar de novo a porta que já está entrando também não.
    expect(gesto(flags('tools'), [{ target: SKILL, port: 'prompts', kind: 'add' }], 'prompts', true)).toBeNull();
  });

  it('quem está saindo do servidor não tem porta nenhuma, e está ocupado', () => {
    const pending = unlinkMarks(SKILL);
    expect(effectivePorts(flags('tools', 'resources', 'prompts'), pending, SKILL)).toEqual([]);
    expect(hasPending(pending, SKILL)).toBe(true);
  });
});

/*
 * As duas peças juntas, contra um servidor de mentira que aplica cada escrita
 * com a latência pedida. A 1ª requisição é a LENTA: fora de fila as duas chegam
 * invertidas, que é o pior caso de duas conexões do navegador. O "canvas" aqui
 * é o de `ServerCanvas.tsx` reduzido ao que importa — flags, marcas e gestos.
 */
describe('dois gestos rápidos no mesmo item (tasks/053)', () => {
  type Modo = 'antigo' | 'so-fusao' | 'fusao+fila';
  const espera = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  function cenario(inicial: Port[], modo: Modo, latencias: number[]) {
    let noServidor: Port[] | null = [...inicial]; // null = vínculo apagado
    const chegada: string[] = [];
    let gravado = flags(...inicial);
    let pending: Pending[] = [];
    const enqueue = createWriteQueue();

    async function escrever(ports: Port[], marks: Pending[]) {
      pending = [...pending, ...marks];
      const latencia = latencias.shift() ?? 1;
      const trabalho = async () => {
        await espera(latencia);
        // O `PUT` é um upsert: recria o vínculo se ele já tinha saído.
        noServidor = ports.length === 0 ? null : [...ports];
        chegada.push(ports.length === 0 ? 'DELETE' : `PUT {${ports.join(',')}}`);
        gravado = flags(...(noServidor ?? [])); // a recarga do detalhe
      };
      try {
        await (modo === 'fusao+fila' ? enqueue(trabalho) : trabalho());
      } finally {
        pending = pending.filter((entry) => !marks.includes(entry));
      }
    }

    /** Um gesto, já confirmando a "última porta" quando a conta dá vazio. */
    function gestoEm(port: Port, on: boolean): Promise<void> {
      const atual = modo === 'antigo' ? flagsToPorts(gravado) : effectivePorts(gravado, pending, SKILL);
      const ports = nextPorts(atual, port, on);
      if (!ports) return Promise.resolve();
      return escrever(ports, ports.length === 0 ? unlinkMarks(SKILL) : [{ target: SKILL, port, kind: on ? 'add' : 'remove' }]);
    }

    return { gestoEm, final: () => noServidor, chegada };
  }

  /** ✕ em Tools e, sem esperar, ✕ em Resources: o pedido é a skill sair do servidor. */
  async function doisX(modo: Modo, latencias: number[]) {
    const c = cenario(['tools', 'resources'], modo, latencias);
    await Promise.all([c.gestoEm('tools', false), c.gestoEm('resources', false)]);
    return c;
  }

  it('a conta antiga deixava uma porta ligada, chegassem as escritas na ordem que fosse', async () => {
    expect((await doisX('antigo', [20, 1])).final()).toEqual(['resources']);
    expect((await doisX('antigo', [1, 20])).final()).toEqual(['tools']);
  });

  it('só a fusão não basta: o PUT lento chega depois do DELETE e recria o vínculo', async () => {
    const c = await doisX('so-fusao', [20, 1]);
    expect(c.chegada).toEqual(['DELETE', 'PUT {resources}']);
    expect(c.final()).toEqual(['resources']);
  });

  it('fusão + fila: a skill sai do servidor, com a latência que for', async () => {
    for (const latencias of [[20, 1], [1, 20], [1, 1]]) {
      const c = await doisX('fusao+fila', [...latencias]);
      expect(c.chegada).toEqual(['PUT {resources}', 'DELETE']);
      expect(c.final()).toBeNull();
    }
  });

  it('gaveta: marcar Resources e desmarcar Tools termina só em Resources (a conta antiga apagava o vínculo)', async () => {
    const antigo = cenario(['tools'], 'antigo', [1, 20]);
    await Promise.all([antigo.gestoEm('resources', true), antigo.gestoEm('tools', false)]);
    expect(antigo.final()).toBeNull();

    const novo = cenario(['tools'], 'fusao+fila', [20, 1]);
    await Promise.all([novo.gestoEm('resources', true), novo.gestoEm('tools', false)]);
    expect(novo.chegada).toEqual(['PUT {tools,resources}', 'PUT {resources}']);
    expect(novo.final()).toEqual(['resources']);
  });
});

describe('fila de escritas do palco', () => {
  /** Uma promessa que o teste resolve quando quiser. */
  function adiada<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('a segunda escrita só sai depois de a primeira terminar', async () => {
    const enqueue = createWriteQueue();
    const ordem: string[] = [];
    const primeira = adiada<void>();

    const a = enqueue(async () => {
      ordem.push('PUT começou');
      await primeira.promise;
      ordem.push('PUT + recarga terminaram');
    });
    const b = enqueue(async () => {
      ordem.push('DELETE começou');
    });

    await tick();
    // Solto, o DELETE já teria saído — e o PUT, chegando depois, recriaria o vínculo.
    expect(ordem).toEqual(['PUT começou']);

    primeira.resolve();
    await Promise.all([a, b]);
    expect(ordem).toEqual(['PUT começou', 'PUT + recarga terminaram', 'DELETE começou']);
  });

  it('devolve a cada um o resultado do seu trabalho', async () => {
    const enqueue = createWriteQueue();
    const [um, dois] = await Promise.all([enqueue(async () => 1), enqueue(async () => 'dois')]);
    expect(um).toBe(1);
    expect(dois).toBe('dois');
  });

  it('a falha de um trabalho é de quem o pediu: a fila segue', async () => {
    const enqueue = createWriteQueue();
    const falhou = enqueue(async () => {
      throw new Error('rede caiu');
    });
    const seguinte = enqueue(async () => 'gravou');

    await expect(falhou).rejects.toThrow('rede caiu');
    await expect(seguinte).resolves.toBe('gravou');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
// `?raw` é do Vite (e o Vitest o entende): o **texto** do arquivo, sem avaliar
// nada. Este tsconfig é de navegador e confere os testes também — `node:fs`
// não tem tipo aqui, e `vite/client` tipa o `?raw` como string.
import fonteDoShared from '../../../../packages/shared/src/types.ts?raw';
import fonteDoPainel from './api.ts?raw';
import fonteDosRotulos from './audit.ts?raw';
import { AUDIT_ACTIONS } from './api.js';
import { ACTION_LABEL, ACTION_TONE, auditRange } from './audit.js';

/**
 * O `AuditAction` do painel é cópia manual do de `@purple-skills/shared` (ver
 * o cabeçalho de `api.ts`): este bundle é de navegador e não importa o pacote.
 * O teste compara as duas listas lendo a **fonte** do shared (não o `dist/`,
 * que engana: `docs/03-implementation-notes.md`, "Armadilhas medidas…"). Foi
 * sem essa conferência que `rag.settings` e `rag.reindex` ficaram sem rótulo:
 * o selo da trilha saía vazio e a frase do sino, sem verbo (`tasks/043`).
 */
const SHARED = 'packages/shared/src/types.ts';
const PAINEL = 'apps/admin/web/src/api.ts';

/**
 * Os membros de `export type AuditAction = | 'a' | 'b' …;`, na ordem do
 * arquivo. Dentro do bloco só valem membro, comentário e linha em branco:
 * qualquer outra coisa é formato que este leitor não conhece, e ele prefere
 * falhar a comparar com uma lista pela metade.
 */
function unionAuditAction(fonte: string, arquivo: string): string[] {
  const linhas = fonte.split('\n');
  const inicio = linhas.findIndex((linha) => /^export type AuditAction =\s*$/.test(linha));
  if (inicio === -1) throw new Error(`"export type AuditAction =" não encontrado em ${arquivo} — o formato do arquivo mudou`);

  const acoes: string[] = [];
  for (const linha of linhas.slice(inicio + 1)) {
    const membro = /^\s*\|\s*'([^']+)'\s*(;?)\s*$/.exec(linha);
    if (membro) {
      acoes.push(membro[1]!);
      if (membro[2] === ';') return acoes;
      continue;
    }
    if (/^\s*(\/\/.*)?$/.test(linha)) continue;
    throw new Error(`linha inesperada no union AuditAction de ${arquivo}: ${JSON.stringify(linha)}`);
  }
  throw new Error(`o union AuditAction de ${arquivo} não termina em ";"`);
}

const ordenado = (lista: readonly string[]) => [...lista].sort();

describe('espelho de AuditAction no painel', () => {
  const doShared = unionAuditAction(fonteDoShared, SHARED);
  const doPainel = unionAuditAction(fonteDoPainel, PAINEL);

  it('encontra o union do shared', () => {
    // Guarda da guarda: um leitor que parasse de casar faria os testes abaixo
    // compararem com lista vazia e passarem sem verificar nada.
    expect(doShared.length).toBeGreaterThan(20);
    expect(new Set(doShared).size, 'ação repetida no shared').toBe(doShared.length);
    expect(doShared).toContain('rag.settings');
  });

  it('o union do painel tem exatamente as ações do shared', () => {
    // Em texto, e não em lista: a mensagem de falha mostra todos os nomes.
    expect(
      doShared.filter((acao) => !doPainel.includes(acao)).join(', '),
      'ações do shared sem espelho em apps/admin/web/src/api.ts',
    ).toBe('');
    expect(
      doPainel.filter((acao) => !doShared.includes(acao)).join(', '),
      'ações que só existem no painel',
    ).toBe('');
  });

  it('na mesma ordem do shared — é a ordem do filtro "Todas as ações"', () => {
    expect(doPainel).toEqual(doShared);
  });

  it('AUDIT_ACTIONS repete o union, item a item', () => {
    // O TypeScript garante que cada item do array é do union, não que o array
    // está completo: a ação que falta aqui some do filtro da trilha.
    expect([...AUDIT_ACTIONS]).toEqual(doPainel);
  });

  it('toda ação tem rótulo e tom, e nenhum mapa tem chave a mais', () => {
    for (const acao of doShared) {
      const rotulo = (ACTION_LABEL as Record<string, string | undefined>)[acao];
      const tom = (ACTION_TONE as Record<string, string | undefined>)[acao];
      expect(rotulo?.trim(), `rótulo de ${acao} em audit.ts`).toBeTruthy();
      expect(['ok', 'accent', 'danger'], `tom de ${acao} em audit.ts`).toContain(tom);
    }
    expect(ordenado(Object.keys(ACTION_LABEL))).toEqual(ordenado(doShared));
    expect(ordenado(Object.keys(ACTION_TONE))).toEqual(ordenado(doShared));
  });

  it('não repete rótulo: o filtro mostra um por ação', () => {
    const rotulos = Object.values(ACTION_LABEL);
    expect(rotulos.filter((rotulo, indice) => rotulos.indexOf(rotulo) !== indice)).toEqual([]);
  });
});

describe('leitor do union (unionAuditAction)', () => {
  it('lê o próprio api.ts com comentários no meio do union', () => {
    const acoes = unionAuditAction(fonteDoPainel, PAINEL);
    expect(acoes[0]).toBe('create');
    expect(acoes.at(-1)).toBe('public.key.revoke');
  });

  it('recusa arquivo sem o union em vez de devolver lista vazia', () => {
    expect(() => unionAuditAction(fonteDosRotulos, 'apps/admin/web/src/audit.ts')).toThrow(/não encontrado/);
  });

  it('recusa linha que não é membro, comentário nem branco, e union sem fim', () => {
    expect(() => unionAuditAction("export type AuditAction =\n  | 'create'\n  | Outro\n  | 'update';\n", 'x.ts')).toThrow(/linha inesperada/);
    expect(() => unionAuditAction("export type AuditAction =\n  | 'create'\n", 'x.ts')).toThrow(/não termina/);
  });
});

/**
 * O período da trilha (`tasks/044`). "Desde" e "Até" são dias do calendário de
 * quem olha; o servidor só compara instantes. `vi.stubEnv('TZ', …)` troca o
 * fuso do `Date` dentro do teste — sem isso o teste só provaria o fuso da
 * máquina que o roda.
 */
describe('auditRange', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('sem data não manda borda; valor que não é um dia também não', () => {
    expect(auditRange('', '')).toEqual({ since: undefined, until: undefined });
    expect(auditRange('2026-09', '19/09/2026')).toEqual({ since: undefined, until: undefined });
    expect(auditRange('2026-09-19', '').until).toBeUndefined();
    expect(auditRange('', '2026-09-19').since).toBeUndefined();
  });

  it('a oeste de Greenwich (BRT) o dia 19 começa às 03:00Z, não às 00:00Z', () => {
    vi.stubEnv('TZ', 'America/Sao_Paulo');
    // Antes: since = 2026-09-19T00:00:00Z, ou seja 18/09 às 21:00 de quem olha.
    expect(auditRange('2026-09-19', '2026-09-19')).toEqual({
      since: '2026-09-19T03:00:00.000Z',
      until: '2026-09-20T02:59:59.999Z',
    });
  });

  it('a causa do defeito: no ES, só a data é UTC e data com hora é local', () => {
    vi.stubEnv('TZ', 'America/Sao_Paulo');
    // As duas expressões que a tela usava, uma em cada fuso: 27 horas de janela.
    const desde = new Date('2026-09-19');
    const ate = new Date('2026-09-19T23:59:59');
    expect(desde.toISOString()).toBe('2026-09-19T00:00:00.000Z');
    expect([desde.getDate(), desde.getHours()]).toEqual([18, 21]);
    expect((ate.getTime() - desde.getTime()) / 3_600_000).toBeCloseTo(27, 2);
    expect(auditRange('2026-09-19', '2026-09-19').since).not.toBe(desde.toISOString());
  });

  it('a leste (Tóquio) as primeiras horas do dia pedido entram — antes sumiam, em silêncio', () => {
    vi.stubEnv('TZ', 'Asia/Tokyo');
    // Antes: since = 2026-09-19T00:00:00Z, 09:00 de quem olha — nove horas de fora.
    expect(auditRange('2026-09-19', '2026-09-19')).toEqual({
      since: '2026-09-18T15:00:00.000Z',
      until: '2026-09-19T14:59:59.999Z',
    });
  });

  it('em UTC e no fuso mais adiantado (+14) a janela é o mesmo dia de calendário', () => {
    vi.stubEnv('TZ', 'UTC');
    expect(auditRange('2026-09-19', '2026-09-19')).toEqual({
      since: '2026-09-19T00:00:00.000Z',
      until: '2026-09-19T23:59:59.999Z',
    });
    vi.stubEnv('TZ', 'Pacific/Kiritimati');
    expect(auditRange('2026-09-19', '2026-09-19')).toEqual({
      since: '2026-09-18T10:00:00.000Z',
      until: '2026-09-19T09:59:59.999Z',
    });
  });

  it('vários dias, e a virada de mês e de ano', () => {
    vi.stubEnv('TZ', 'America/Sao_Paulo');
    expect(auditRange('2026-12-30', '2026-12-31')).toEqual({
      since: '2026-12-30T03:00:00.000Z',
      until: '2027-01-01T02:59:59.999Z',
    });
    expect(auditRange('2028-02-28', '2028-02-29').until).toBe('2028-03-01T02:59:59.999Z');
  });

  it('dia de 23 e de 25 horas: a borda é o calendário, não uma soma de 24 h', () => {
    vi.stubEnv('TZ', 'America/Sao_Paulo');
    // 04/11/2018: o horário de verão começou à meia-noite — 00:00 não existiu,
    // o dia começou à 01:00 (-02:00) e teve 23 horas.
    expect(auditRange('2018-11-04', '2018-11-04')).toEqual({
      since: '2018-11-04T03:00:00.000Z',
      until: '2018-11-05T01:59:59.999Z',
    });
    // 16/02/2019: o horário de verão acabou à meia-noite — o dia teve 25 horas,
    // e 23:00–23:59 aconteceu duas vezes. Lendo o texto `…T23:59:59.999`, o ES
    // fica com a primeira ocorrência e a última hora do dia ficaria de fora.
    expect(auditRange('2019-02-16', '2019-02-16')).toEqual({
      since: '2019-02-16T02:00:00.000Z',
      until: '2019-02-17T02:59:59.999Z',
    });
    expect(new Date('2019-02-16T23:59:59.999').toISOString()).toBe('2019-02-17T01:59:59.999Z');
  });

  it.each(['America/Sao_Paulo', 'Europe/Lisbon', 'Asia/Tokyo', 'Asia/Kolkata', 'Pacific/Kiritimati', 'Pacific/Pago_Pago'])(
    'em %s, um evento entra na janela se e só se a coluna "Quando" o mostra no dia pedido',
    (fuso) => {
      vi.stubEnv('TZ', fuso);
      const { since, until } = auditRange('2026-09-19', '2026-09-19');
      const dentro = (instante: Date) => instante >= new Date(since!) && instante <= new Date(until!);
      // O dia que `formatDateTime` mostraria: o do calendário local.
      const dia = (instante: Date) => `${instante.getFullYear()}-${instante.getMonth() + 1}-${instante.getDate()}`;

      // De hora em hora, do dia 17 ao dia 21 (em UTC): cobre os dois vizinhos em qualquer fuso.
      for (let hora = 0; hora < 24 * 5; hora += 1) {
        const instante = new Date(Date.UTC(2026, 8, 17, hora, 30));
        expect(dentro(instante), `${instante.toISOString()} em ${fuso}`).toBe(dia(instante) === '2026-9-19');
      }
      // As bordas, ao milissegundo — o último do dia entra (antes, `23:59:59` cortava o segundo final).
      expect(dentro(new Date(2026, 8, 19, 0, 0, 0, 0))).toBe(true);
      expect(dentro(new Date(2026, 8, 19, 23, 59, 59, 999))).toBe(true);
      expect(dentro(new Date(2026, 8, 18, 23, 59, 59, 999))).toBe(false);
      // A meia-noite seguinte já é do outro dia: o `<=` do servidor é inclusivo.
      expect(dentro(new Date(2026, 8, 20, 0, 0, 0, 0))).toBe(false);
    },
  );
});

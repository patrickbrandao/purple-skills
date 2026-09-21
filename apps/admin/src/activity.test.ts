/**
 * A camada da tela de Atividade (`docs/18-atividade.md`), sem servidor e sem
 * banco: o que ela recusa antes de consultar, o que ela repassa e como o dia
 * do caminho vira faixa de instantes.
 *
 * O que mais custaria caro se mudasse sem querer:
 *
 * 1. **o dia derivado tem de ser o dia que a grade pintou** — a faixa é o dia
 *    do calendário no fuso pedido, inclusive onde ele tem 23 horas;
 * 2. **fuso e dia de terceiro não chegam ao banco nem ao `Intl` sem conferência**:
 *    os dois viram 400, nunca o 500 de um `RangeError` ou de um
 *    `invalid_parameter_value` no meio do SQL;
 * 3. **a faixa que o corpo anuncia é a que foi lida**: o banco satura em 400
 *    dias em silêncio, e a série repete a conta para não prometer dia nenhum
 *    que ficou de fora.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ActivityDay, ActivityReport } from '@purple-skills/shared';
import type { AuthUser } from './auth.js';

/** As duas leituras da tela, pelo nome. O resto do pacote entra de verdade (`badRequest`, `AppError`). */
const banco = vi.hoisted(() => ({
  listActivityDays: vi.fn(),
  activityOfDay: vi.fn(),
}));

vi.mock('@purple-skills/db', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...banco,
}));

const { FUSOS_MAX, report, series } = await import('./activity.js');

const ADMIN: AuthUser = {
  uuid: 'uuid-admin',
  email: 'admin@exemplo.dev',
  name: 'Admin',
  role: 'admin',
  mustChangePassword: false,
  legacy: false,
};

const DIAS: ActivityDay[] = [{ day: '2026-09-20', sessions: 2, calls: 9, reads: 3, events: 1, total: 15 }];

/** O que `activityOfDay` devolve: o relatório menos `day` e `timezone`, que são de quem perguntou. */
const CORPO: Omit<ActivityReport, 'day' | 'timezone'> = {
  clients: { sessions: 2, distinct: 2, agents: 1, ended: 1, byTransport: [], byAuth: [], byEndReason: [], topAgents: [] },
  calls: { total: 9, byFamily: [], topMethods: [], byTransport: [], byServer: [] },
  reads: { total: 3, downloads: 1, skills: 2, bySurface: [], byOrigin: [], byAuth: [], topSkills: [] },
  catalog: { total: 1, actors: 1, byAction: [], bySource: [] },
};

function preparar() {
  banco.listActivityDays.mockReset().mockResolvedValue(DIAS);
  banco.activityOfDay.mockReset().mockResolvedValue(CORPO);
}

/** Os argumentos da última consulta, como o banco os recebeu. */
const pedidoDaSerie = () => banco.listActivityDays.mock.calls.at(-1)![0] as { since: Date; until: Date; timezone: string };
const pedidoDoDia = () => banco.activityOfDay.mock.calls.at(-1)![0] as { since: Date; until: Date; top?: number };

const DIA_MS = 86_400_000;

describe('GET /api/activity: a série do mapa de dias', () => {
  it('manda os instantes ao banco e devolve a faixa em dias do fuso pedido', async () => {
    preparar();

    const corpo = await series(ADMIN, {
      since: '2026-09-01T03:00:00.000Z',
      until: '2026-09-21T02:59:59.999Z',
      tz: 'America/Sao_Paulo',
    });

    expect(pedidoDaSerie()).toEqual({
      since: new Date('2026-09-01T03:00:00.000Z'),
      until: new Date('2026-09-21T02:59:59.999Z'),
      timezone: 'America/Sao_Paulo',
    });
    // Meia-noite de 1º de setembro e o último milissegundo do dia 20, em -03.
    expect(corpo).toEqual({ days: DIAS, since: '2026-09-01', until: '2026-09-20', timezone: 'America/Sao_Paulo' });
  });

  it('sem `tz`, o recorte é em UTC', async () => {
    preparar();

    const corpo = await series(ADMIN, { since: '2026-09-20T00:00:00.000Z', until: '2026-09-20T23:59:59.999Z' });

    expect(pedidoDaSerie().timezone).toBe('UTC');
    expect(corpo).toMatchObject({ since: '2026-09-20', until: '2026-09-20', timezone: 'UTC' });
  });

  it.each([[{}], [{ since: '2026-09-01T00:00:00Z' }], [{ until: '2026-09-21T00:00:00Z' }], [{ since: '', until: '' }]])(
    'sem os dois instantes (%j) é 400, sem consultar',
    async (query) => {
      preparar();

      await expect(series(ADMIN, query)).rejects.toMatchObject({ status: 400, code: 'bad_request' });
      expect(banco.listActivityDays).not.toHaveBeenCalled();
    },
  );

  it('instante que não é data é 400 com o nome do campo, sem consultar', async () => {
    preparar();

    await expect(series(ADMIN, { since: 'ontem', until: '2026-09-21T00:00:00Z' })).rejects.toMatchObject({
      status: 400,
      message: '"since" precisa ser uma data válida',
    });
    expect(banco.listActivityDays).not.toHaveBeenCalled();
  });

  it('a faixa satura em 400 dias, e o corpo anuncia a que foi lida', async () => {
    preparar();
    const until = new Date('2026-09-21T23:59:59.999Z');
    const pedido = new Date(until.getTime() - 3650 * DIA_MS);

    const corpo = await series(ADMIN, { since: pedido.toISOString(), until: until.toISOString() });

    expect(pedidoDaSerie().since).toEqual(new Date(until.getTime() - 400 * DIA_MS));
    expect(corpo.since).toBe('2025-08-17');
    expect(corpo.until).toBe('2026-09-21');
  });
});

describe('GET /api/activity/:day: o relatório de um dia', () => {
  it('preenche `day` e `timezone` e repassa o corpo do banco', async () => {
    preparar();

    const corpo = await report(ADMIN, '2026-09-20', { tz: 'UTC' });

    expect(corpo).toEqual({ day: '2026-09-20', timezone: 'UTC', ...CORPO });
  });

  it('sem `since`/`until`, deriva a faixa do dia no fuso pedido', async () => {
    preparar();

    await report(ADMIN, '2026-09-20', { tz: 'America/Sao_Paulo' });

    expect(pedidoDoDia()).toMatchObject({
      since: new Date('2026-09-20T03:00:00.000Z'),
      until: new Date('2026-09-21T02:59:59.999Z'),
    });
  });

  it.each([
    // O dia em que o relógio de São Paulo pulou de 23:59 para 01:00: começa no
    // salto e tem 23 horas. Mandar a meia-noite que não existiu traria a última
    // hora do dia anterior.
    ['America/Sao_Paulo', '2018-11-04', '2018-11-04T03:00:00.000Z', '2018-11-05T01:59:59.999Z'],
    // O mesmo do outro lado do meridiano: em Beirute o dia começa na véspera, em UTC.
    ['Asia/Beirut', '2022-03-27', '2022-03-26T22:00:00.000Z', '2022-03-27T20:59:59.999Z'],
    // Deslocamento que não é hora cheia — o caso extremo que dá o tamanho do balde.
    ['Asia/Katmandu', '2026-05-20', '2026-05-19T18:15:00.000Z', '2026-05-20T18:14:59.999Z'],
  ])('em %s, o dia %s vai de %s a %s', async (tz, dia, since, until) => {
    preparar();

    await report(ADMIN, dia, { tz });

    expect(pedidoDoDia()).toMatchObject({ since: new Date(since), until: new Date(until) });
  });

  it('com `since`/`until` na query, não deriva nada: o painel é quem converte', async () => {
    preparar();

    await report(ADMIN, '2026-09-20', {
      tz: 'America/Sao_Paulo',
      since: '2026-09-20T03:00:00.000Z',
      until: '2026-09-21T02:59:59.999Z',
    });

    expect(pedidoDoDia()).toMatchObject({
      since: new Date('2026-09-20T03:00:00.000Z'),
      until: new Date('2026-09-21T02:59:59.999Z'),
    });
  });

  it.each([['2026-9-20'], ['20/09/2026'], ['hoje'], [''], ['2026-02-31'], ['2026-13-01']])(
    'o dia %j é 400, sem consultar',
    async (dia) => {
      preparar();

      await expect(report(ADMIN, dia, {})).rejects.toMatchObject({ status: 400, code: 'bad_request' });
      expect(banco.activityOfDay).not.toHaveBeenCalled();
    },
  );

  it('`top` inteiro viaja; lixo e ausência ficam com o padrão do banco', async () => {
    preparar();

    await report(ADMIN, '2026-09-20', { top: '10' });
    expect(pedidoDoDia().top).toBe(10);

    // `?top=abc` com `Number(...)` cru viraria `NaN`, que o `clamp` do banco lê
    // como o mínimo: uma linha em cada lista do relatório (relatório 086).
    await report(ADMIN, '2026-09-20', { top: 'abc' });
    expect(pedidoDoDia()).not.toHaveProperty('top');

    await report(ADMIN, '2026-09-20', {});
    expect(pedidoDoDia()).not.toHaveProperty('top');
  });
});

describe('o fuso é texto de terceiro: recusado aqui, antes do Intl e do SQL', () => {
  it.each([['Marte/Olympus'], ['America/Sao Paulo'], ['../etc/passwd'], ["UTC'; DROP TABLE"], ['+05:45']])(
    '%j é 400 nas duas rotas, sem consultar',
    async (tz) => {
      preparar();

      await expect(series(ADMIN, { since: '2026-09-20T00:00:00Z', until: '2026-09-20T23:59:59Z', tz })).rejects.toMatchObject({
        status: 400,
        code: 'bad_request',
      });
      await expect(report(ADMIN, '2026-09-20', { tz })).rejects.toMatchObject({ status: 400, code: 'bad_request' });

      expect(banco.listActivityDays).not.toHaveBeenCalled();
      expect(banco.activityOfDay).not.toHaveBeenCalled();
    },
  );

  it('a mensagem não ecoa um fuso gigante de volta', async () => {
    preparar();
    const enorme = 'A'.repeat(5000);

    await expect(report(ADMIN, '2026-09-20', { tz: enorme })).rejects.toMatchObject({
      message: `Fuso horário inválido: ${'A'.repeat(64)}`,
    });
  });

  it('apelido antigo da base IANA passa: quem canoniza é a tzdata, não uma lista nossa', async () => {
    preparar();

    await report(ADMIN, '2026-09-20', { tz: 'Asia/Calcutta' });

    expect(pedidoDoDia()).toMatchObject({ since: new Date('2026-09-19T18:30:00.000Z') });
  });
});

describe('o cache de formatadores é do processo: a caixa não multiplica entrada, e ele tem teto', () => {
  /**
   * Conta os `Intl.DateTimeFormat` montados daqui em diante, pelo fuso de cada
   * um. Uma construção é uma **entrada nova** no cache de `activity.ts` — o mapa
   * é privado do módulo, e é assim que o tamanho dele se mede de fora.
   *
   * Embrulho à mão, e não `vi.spyOn`: o módulo monta o formatador com `new`, e o
   * que entra no mapa tem de continuar sendo um `Intl.DateTimeFormat` de
   * verdade — uma função comum que devolve objeto é o que `new` entrega de
   * volta, então o original faz o trabalho e o embrulho só conta.
   */
  function espiarFormatadores(): { montados: string[]; parar: () => void } {
    const original = Intl.DateTimeFormat;
    const montados: string[] = [];
    function Espiao(...args: ConstructorParameters<typeof Intl.DateTimeFormat>) {
      montados.push(String(args[1]?.timeZone ?? ''));
      return new original(...args);
    }
    Intl.DateTimeFormat = Espiao as unknown as typeof Intl.DateTimeFormat;
    return {
      montados,
      parar: () => {
        Intl.DateTimeFormat = original;
      },
    };
  }

  /**
   * Só as construções do fuso pedido. O `UTC` sai da conta porque não vem de
   * quem chamou: `inicioDoDia` ancora o palpite nele, e se o cache já o tiver
   * (os casos acima usam `UTC`) não há construção — rodando só este caso, com
   * `-t`, haveria. O que se mede aqui é quanto o `?tz=` custa.
   */
  const doPedido = (montados: string[]): string[] => montados.filter((tz) => tz !== 'UTC');

  // Fuso que não aparece em nenhum outro teste deste arquivo: o cache é do
  // processo e sobrevive entre casos, então medir "quantas entradas custou"
  // exige um nome que ainda não esteja lá.
  const CHATHAM = 'Pacific/Chatham';

  it('as quatro grafias do mesmo fuso são uma entrada só, e o corpo ecoa a que veio', async () => {
    preparar();
    const grafias = [CHATHAM, 'pacific/chatham', 'PACIFIC/CHATHAM', 'pAcIfIc/cHaThAm'];
    const espia = espiarFormatadores();

    try {
      const faixas: string[] = [];
      for (const tz of grafias) {
        const corpo = await report(ADMIN, '2026-09-20', { tz });
        // A decisão documentada em `fusoDe`: o `timezone` do corpo (e o que vai
        // ao SQL) é a grafia que o cliente mandou, não a canônica do `Intl`.
        expect(corpo.timezone).toBe(tz);
        faixas.push(`${pedidoDoDia().since.toISOString()}..${pedidoDoDia().until.toISOString()}`);
      }

      // Guardado pela grafia crua, o mapa ganharia quatro entradas para um fuso
      // só — e quem varia a caixa a cada requisição o faria crescer sem teto.
      expect(doPedido(espia.montados)).toEqual([CHATHAM]);
      // Baixar a caixa da chave não pode mudar o recorte: +12:45 nas quatro.
      expect(new Set(faixas)).toEqual(new Set(['2026-09-19T11:15:00.000Z..2026-09-20T11:14:59.999Z']));
    } finally {
      espia.parar();
    }
  });

  it(`o teto segura em ${FUSOS_MAX}: visto o fuso ${FUSOS_MAX + 1}, o mais antigo sai`, async () => {
    preparar();
    // Nomes reais da tzdata deste Node (~400), e nenhum deles usado acima.
    const zonas = Intl.supportedValuesOf('timeZone').slice(0, FUSOS_MAX + 6);
    // `since`/`until` na query para o relatório não derivar nada: `inicioDoDia`
    // ancora o palpite em `UTC`, e o `UTC` também disputa lugar no cache — sendo
    // descartado, é remontado, e as construções dele entrariam nesta conta sem
    // dizer nada sobre o fuso de quem chamou, que é o que se mede aqui.
    const faixa = { since: '2026-09-20T00:00:00.000Z', until: '2026-09-20T23:59:59.999Z' };
    const espia = espiarFormatadores();

    try {
      for (const tz of zonas) await report(ADMIN, '2026-09-20', { ...faixa, tz });
      expect(espia.montados).toEqual(zonas);

      // Vistos `FUSOS_MAX + 6` fusos, o mapa guarda os `FUSOS_MAX` últimos: o
      // cache segue sendo cache, e nada aqui é remontado.
      espia.montados.length = 0;
      for (const tz of zonas.slice(-FUSOS_MAX)) await report(ADMIN, '2026-09-20', { ...faixa, tz });
      expect(espia.montados).toEqual([]);

      // E os seis primeiros saíram. É esta remontagem que prova o teto: com o
      // mapa crescendo para sempre, os 70 estariam lá e nada seria remontado.
      for (const tz of zonas.slice(0, 6)) await report(ADMIN, '2026-09-20', { ...faixa, tz });
      expect(espia.montados).toEqual(zonas.slice(0, 6));
    } finally {
      espia.parar();
    }
  });
});

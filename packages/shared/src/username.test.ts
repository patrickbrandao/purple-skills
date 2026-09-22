import { describe, expect, it } from 'vitest';
import { normalizeEmail } from './email.js';
import {
  RESERVED_USERNAMES,
  isEmailLogin,
  isReservedUsername,
  normalizeUsername,
  usernameFromName,
  usernameFromUuid,
  usernameWithSuffix,
} from './username.js';

describe('normalização de username', () => {
  it('apara e baixa a caixa', () => {
    expect(normalizeUsername('  Patrick.Brandao ')).toBe('patrick.brandao');
  });

  it('aceita as três pontuações, uma de cada vez', () => {
    expect(normalizeUsername('ana-silva')).toBe('ana-silva');
    expect(normalizeUsername('ana_silva')).toBe('ana_silva');
    expect(normalizeUsername('ana.silva')).toBe('ana.silva');
    expect(normalizeUsername('a1b2c3')).toBe('a1b2c3');
  });

  it('recusa pontuação nas pontas e pontuação repetida', () => {
    // A regra que impede o par confundível: sem ela `ana.silva`, `ana..silva` e
    // `ana._silva` seriam três contas que ninguém distingue na tela.
    expect(normalizeUsername('-ana')).toBeNull();
    expect(normalizeUsername('ana-')).toBeNull();
    expect(normalizeUsername('ana..silva')).toBeNull();
    expect(normalizeUsername('ana._silva')).toBeNull();
    expect(normalizeUsername('ana--silva')).toBeNull();
  });

  it('recusa comprimento fora da faixa e caractere de fora do alfabeto', () => {
    expect(normalizeUsername('ab')).toBeNull();
    expect(normalizeUsername('a'.repeat(33))).toBeNull();
    expect(normalizeUsername('a'.repeat(32))).toBe('a'.repeat(32));
    expect(normalizeUsername('joão')).toBeNull();
    expect(normalizeUsername('ana silva')).toBeNull();
    expect(normalizeUsername('ana+silva')).toBeNull();
    expect(normalizeUsername(42)).toBeNull();
    expect(normalizeUsername(null)).toBeNull();
  });

  it('recusa qualquer coisa com @ — é o que torna o login decidível', () => {
    // `docs/19` decisão 3: um campo só. Tem `@`, é e-mail; não tem, é username.
    // A regra só fecha porque nenhum username válido pode ter `@`.
    expect(normalizeUsername('ana@exemplo.com')).toBeNull();
    expect(normalizeUsername('ana@')).toBeNull();
    expect(isEmailLogin('ana@exemplo.com')).toBe(true);
    expect(isEmailLogin('ana.silva')).toBe(false);

    const endereco = 'maria@exemplo.com';
    expect(normalizeEmail(endereco)).toBe(endereco);
    expect(normalizeUsername(endereco)).toBeNull();
  });

  it('recusa username com forma de uuid', () => {
    // `ownerUserUuid` do PATCH aceita username **ou** uuid; um username com a
    // cara de um uuid tornaria a entrada ambígua.
    expect(normalizeUsername('0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b')).toBeNull();
    // Um hex de 8 não é uuid e continua valendo — é o fallback do backfill.
    expect(normalizeUsername('user-0199a1b2')).toBe('user-0199a1b2');
  });

  it('recusa os reservados', () => {
    for (const reservado of RESERVED_USERNAMES) {
      expect(normalizeUsername(reservado)).toBeNull();
      expect(normalizeUsername(reservado.toUpperCase())).toBeNull();
      expect(isReservedUsername(` ${reservado} `)).toBe(true);
    }
    expect(isReservedUsername('ana')).toBe(false);
  });
});

/**
 * A forma anterior do `USERNAME_SHAPE` tinha o separador **opcional**
 * (`(?:[._-]?[a-z0-9]+)*`), o que dá 2^(n-1) partições para uma cadeia de
 * alfanuméricos e backtracking catastrófico quando a entrada falha no fim:
 * 6,3 s numa string de 32 caracteres, por requisição anônima.
 *
 * Os dois casos abaixo guardam as duas metades da correção — que ela é rápida,
 * e que ela aceita exatamente a mesma linguagem.
 */
describe('a forma do username não faz backtracking catastrófico', () => {
  it('a pior entrada possível resolve em microssegundos', () => {
    // 31 letras iguais e um caractere que falha: o pior caso da forma antiga,
    // no teto de tamanho que o validador impõe.
    const pior = `${'a'.repeat(31)}!`;
    const inicio = performance.now();
    expect(normalizeUsername(pior)).toBeNull();
    const gasto = performance.now() - inicio;

    // Folga enorme de propósito: o que se quer flagrar é a diferença de cinco
    // ordens de grandeza, não milissegundos de máquina lenta ou de coletor.
    expect(gasto).toBeLessThan(50);
  });

  it('aceita a mesma linguagem da forma anterior', () => {
    const ANTIGA = /^[a-z0-9](?:[._-]?[a-z0-9]+)*$/;
    const NOVA = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

    // Alfabeto pequeno de propósito: ele cobre alfanumérico, as três
    // pontuações, o `@` e o espaço, que são as classes que separam os casos.
    const alfabeto = 'ab1._-@ ';
    const casos: string[] = ['', 'a', 'a.b', 'a..b', '.a', 'a-', 'a_b-c'];
    for (let i = 0; i < 4096; i += 1) {
      let s = '';
      let n = i;
      // Até quatro caracteres: o suficiente para todas as combinações de
      // fronteira, e curto o bastante para a forma antiga não travar.
      for (let k = 0; k < 4; k += 1) {
        s += alfabeto[n % alfabeto.length];
        n = Math.floor(n / alfabeto.length);
      }
      casos.push(s);
    }

    for (const caso of casos) {
      expect(NOVA.test(caso), `divergiu em ${JSON.stringify(caso)}`).toBe(ANTIGA.test(caso));
    }
  });
});

describe('username derivado do nome', () => {
  it('tira acento, baixa a caixa e junta com hífen', () => {
    expect(usernameFromName('Patrick Brandão')).toBe('patrick-brandao');
    expect(usernameFromName('José da Silva Júnior')).toBe('jose-da-silva-junior');
    expect(usernameFromName('Ana   Maria')).toBe('ana-maria');
    expect(usernameFromName("O'Brien, Seán")).toBe('o-brien-sean');
  });

  it('nunca sai do que `normalizeUsername` aceita', () => {
    const nomes = [
      'Patrick Brandão',
      '  Ana  ',
      'Zoë Çelik',
      'María-José',
      'a'.repeat(60),
      'Ünal Öztürk',
    ];
    for (const nome of nomes) {
      const derivado = usernameFromName(nome);
      if (derivado === null) continue;
      expect(normalizeUsername(derivado)).toBe(derivado);
      expect(derivado.length).toBeLessThanOrEqual(32);
    }
  });

  it('corta em 32 sem deixar pontuação na ponta', () => {
    const derivado = usernameFromName('Maria Fernanda Albuquerque Santos Silva');
    expect(derivado).toBe('maria-fernanda-albuquerque-santo');
    expect(derivado).toHaveLength(32);
  });

  it('devolve null quando o nome não dá username', () => {
    expect(usernameFromName('')).toBeNull();
    expect(usernameFromName('   ')).toBeNull();
    expect(usernameFromName('...')).toBeNull();
    expect(usernameFromName('Ho')).toBeNull();
    expect(usernameFromName('管理者')).toBeNull();
    // Reservado também cai fora — quem chama usa o fallback do uuid.
    expect(usernameFromName('Admin')).toBeNull();
    expect(usernameFromName(null)).toBeNull();
  });

  it('o fallback do uuid é determinístico e válido', () => {
    const derivado = usernameFromUuid('0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b');
    expect(derivado).toBe('user-0199a1b2');
    expect(normalizeUsername(derivado)).toBe(derivado);
  });
});

describe('sufixo de colisão', () => {
  it('numera a partir do segundo', () => {
    expect(usernameWithSuffix('joao', 1)).toBe('joao');
    expect(usernameWithSuffix('joao', 2)).toBe('joao-2');
    expect(usernameWithSuffix('joao', 10)).toBe('joao-10');
  });

  it('trunca o radical para o sufixo caber em 32', () => {
    const longo = 'maria-fernanda-albuquerque-santo'; // exatamente 32
    expect(usernameWithSuffix(longo, 2)).toBe('maria-fernanda-albuquerque-san-2');
    expect(usernameWithSuffix(longo, 10)).toBe('maria-fernanda-albuquerque-sa-10');
    for (const n of [2, 3, 9, 10, 99]) {
      const candidato = usernameWithSuffix(longo, n);
      expect(candidato).not.toBeNull();
      expect(candidato!.length).toBeLessThanOrEqual(32);
      expect(normalizeUsername(candidato!)).toBe(candidato);
    }
  });

  it('não deixa pontuação dupla ao truncar', () => {
    // O corte pode cair logo depois de um hífen: `ana-maria-` + `-2` seria
    // `ana-maria--2`, que `normalizeUsername` recusa.
    const base = 'ana-maria-fernanda-albuquerque-x';
    const candidato = usernameWithSuffix(base, 2);
    expect(candidato).toBe('ana-maria-fernanda-albuquerque-2');
    expect(normalizeUsername(candidato!)).toBe(candidato);
  });
});

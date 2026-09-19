/**
 * Teste de integração do `schema.ts` — exige um PostgreSQL 18 real.
 *
 * O `schema.ts` é **tipagem**: a fonte de verdade é `database/schema/*.sql`.
 * Como nada em tempo de execução reclama quando os dois discordam, a
 * divergência só aparece no dia em que alguém roda `drizzle-kit` e vê um diff
 * propondo **remover** uma chave estrangeira ou um índice que existe de
 * verdade. Esta suíte fecha esse buraco: migra um banco do zero e compara o
 * que o Drizzle declara com o que o Postgres tem, objeto a objeto.
 *
 * Fica desligada por padrão: sem `TEST_DATABASE_URL` a suíte inteira é pulada,
 * então `npm test` continua rodando sem banco. Para rodar:
 *
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/purple_skills_test \
 *     npx vitest run database/src/schema.integration.test.ts
 *
 * O banco apontado é **recriado do zero** (DROP SCHEMA public CASCADE) a cada
 * execução: aponte para um banco descartável, nunca para o de desenvolvimento.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { is } from 'drizzle-orm';
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import type { IndexedColumn, PgColumn } from 'drizzle-orm/pg-core';
import { runMigrations } from './migrate.js';
import * as schema from './schema.js';

const url = process.env.TEST_DATABASE_URL;

/**
 * O Vitest roda arquivos de teste em paralelo e as suítes de integração
 * recriam o **mesmo** banco. Um advisory lock segurado por toda a duração do
 * arquivo faz uma esperar a outra terminar, em vez de derrubar o schema no
 * meio da execução dela. O número precisa ser o mesmo das outras suítes.
 */
const SCHEMA_LOCK = 8_200_004;

/**
 * O que existe no banco e **não** cabe no DSL do Drizzle, com o motivo. É a
 * única porta de saída da comparação de índices: acrescentar índice parcial ou
 * por expressão numa migration exige uma linha aqui; qualquer outro índice tem
 * de estar declarado no `schema.ts`.
 */
const SOMENTE_SQL: Record<string, string> = {
  files_skill_path_lower_uniq: 'por expressão: UNIQUE (skill_uuid, lower(path)) — `003`',
  users_email_lower_uniq: 'por expressão: UNIQUE (lower(email)) — `004`',
  users_oidc_uniq: 'parcial: UNIQUE (oidc_issuer, oidc_subject) com os dois não nulos — `004`',
  mcp_sessions_open_last_seen_idx: 'parcial: (last_seen_at) WHERE ended_at IS NULL — `015`',
  mcp_sessions_open_session_id_idx: 'parcial: (session_id) WHERE ended_at IS NULL — `015`',
  skills_score_idx: 'por expressão: ((view_count + download_count) DESC) — `012`',
  skills_rag_stale_idx: 'parcial: (updated_at, uuid) WHERE rag_stale — `020`',
};

/** Tabelas que existem no banco e de propósito não têm tipagem. */
const TABELAS_SEM_TIPAGEM: Record<string, string> = {
  schema_migrations: 'é do runner (`migrate.ts`), não de um `.sql`, e nenhuma query a lê',
};

// ------------------------------------------------------------ lado do Drizzle

type Declarada = {
  /** nome da coluna → tipo + NOT NULL + tem DEFAULT. */
  colunas: Map<string, string>;
  /** `nome: colunas` da chave primária. */
  pk: string;
  /** nome da constraint → colunas. */
  uniques: Map<string, string>;
  /** Colunas → tabela e colunas do alvo + ação de remoção; o nome não entra (ver o teste). */
  fks: Set<string>;
  /** nome do índice → método, colunas, classe de operadores e ordem. */
  indices: Map<string, string>;
};

/** Uma coluna de índice pode ser uma expressão (`SQL`), que não comparamos. */
function colunaDeIndice(coluna: unknown): string {
  const c = coluna as Partial<IndexedColumn>;
  if (typeof c?.name !== 'string') return '<expressão>';
  const cfg = c.indexConfig ?? {};
  return `${c.name}${cfg.opClass ? ` ${cfg.opClass}` : ''}${cfg.order === 'desc' ? ' DESC' : ''}`;
}

function descreveColuna(coluna: PgColumn): string {
  return `${coluna.getSQLType()} notNull=${coluna.notNull} default=${coluna.hasDefault}`;
}

/** Lê `schema.ts` pela própria metainformação do Drizzle. */
function declaradas(): Map<string, Declarada> {
  const out = new Map<string, Declarada>();
  for (const valor of Object.values(schema)) {
    if (!is(valor, PgTable)) continue;
    const cfg = getTableConfig(valor);

    const colunas = new Map<string, string>();
    const uniques = new Map<string, string>();
    // O Postgres nomeia `<tabela>_pkey` a PK declarada na coluna; a composta
    // leva o nome que `primaryKey({ name })` informa.
    let pk = `${cfg.name}_pkey: `;
    for (const coluna of cfg.columns) {
      colunas.set(coluna.name, descreveColuna(coluna));
      if (coluna.primary) pk += coluna.name;
      if (coluna.isUnique) uniques.set(coluna.uniqueName ?? '(sem nome)', coluna.name);
    }
    for (const chave of cfg.primaryKeys) {
      pk = `${chave.getName()}: ${chave.columns.map((c) => c.name).join(', ')}`;
    }
    for (const u of cfg.uniqueConstraints) {
      uniques.set(u.name ?? '(sem nome)', u.columns.map((c) => c.name).join(', '));
    }

    const fks = new Set<string>();
    for (const fk of cfg.foreignKeys) {
      const ref = fk.reference();
      const colunasFk = ref.columns.map((c) => c.name).join(', ');
      const alvo = ref.foreignColumns.map((c) => c.name).join(', ');
      const tabelaAlvo = getTableConfig(ref.foreignTable).name;
      const acao = (fk.onDelete ?? 'no action').toUpperCase();
      fks.add(`(${colunasFk}) -> ${tabelaAlvo}(${alvo}) ON DELETE ${acao}`);
    }

    const indices = new Map<string, string>();
    for (const idx of cfg.indexes) {
      const cols = idx.config.columns.map(colunaDeIndice).join(', ');
      const prefixo = idx.config.unique ? 'UNIQUE ' : '';
      const metodo = idx.config.method ?? 'btree';
      indices.set(idx.config.name ?? '(sem nome)', `${prefixo}${metodo} (${cols})`);
    }

    out.set(cfg.name, { colunas, pk, uniques, fks, indices });
  }
  return out;
}

// -------------------------------------------------------------- lado do banco

type ColunaBanco = { tabela: string; coluna: string; descricao: string };
type ConstraintBanco = { tabela: string; tipo: 'p' | 'u' | 'f'; nome: string; definicao: string };
type IndiceBanco = {
  tabela: string;
  nome: string;
  definicao: string;
  parcial: boolean;
  porExpressao: boolean;
  deConstraint: boolean;
};

let raw: pg.Client;
let lock: pg.Client;
let ts = new Map<string, Declarada>();
let colunas: ColunaBanco[] = [];
let constraints: ConstraintBanco[] = [];
let indices: IndiceBanco[] = [];

/** O `USING ... (colunas)` de um índice, sem o predicado e sem a ordem de NULLs. */
function corpoDoIndice(definicao: string): string {
  const m = /^CREATE (UNIQUE )?INDEX \S+ ON \S+ USING (\w+) \((.+)\)$/.exec(definicao);
  if (!m) return definicao;
  // A ordem de NULLs não é comparada: o DSL não distingue o padrão do explícito
  // (`.desc()` mantém `nulls: 'last'`), e nenhum índice nosso a usa.
  const cols = m[3]
    .split(', ')
    .map((c) => c.replace(/ NULLS (FIRST|LAST)$/, ''))
    .join(', ');
  return `${m[1] ? 'UNIQUE ' : ''}${m[2]} (${cols})`;
}

/** As colunas de uma constraint `PRIMARY KEY (...)` / `UNIQUE (...)`. */
function colunasDaConstraint(definicao: string): string {
  return /\(([^)]*)\)/.exec(definicao)?.[1] ?? definicao;
}

/** A FK no mesmo formato do lado do Drizzle — sem o nome (ver o teste). */
function descreveFk(definicao: string): string {
  const m = /^FOREIGN KEY \(([^)]+)\) REFERENCES ([^(]+)\(([^)]+)\)(.*)$/.exec(definicao);
  if (!m) return definicao;
  const acao = /ON DELETE (CASCADE|SET NULL|SET DEFAULT|RESTRICT)/.exec(m[4])?.[1] ?? 'NO ACTION';
  return `(${m[1]}) -> ${m[2].trim()}(${m[3]}) ON DELETE ${acao}`;
}

describe.skipIf(!url)('schema.ts descreve o banco que as migrations criam', () => {
  beforeAll(async () => {
    lock = new pg.Client({ connectionString: url });
    await lock.connect();
    await lock.query('SELECT pg_advisory_lock($1)', [SCHEMA_LOCK]);

    await lock.query('DROP SCHEMA IF EXISTS public CASCADE');
    await lock.query('CREATE SCHEMA public');
    await runMigrations(url!);

    raw = new pg.Client({ connectionString: url });
    await raw.connect();
    ts = declaradas();

    colunas = (
      await raw.query<ColunaBanco>(`
        SELECT c.relname AS tabela,
               a.attname AS coluna,
               format_type(a.atttypid, a.atttypmod)
                 || ' notNull=' || a.attnotnull::text
                 || ' default=' || a.atthasdef::text AS descricao
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
          AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY c.relname, a.attnum
      `)
    ).rows;

    constraints = (
      await raw.query<ConstraintBanco>(`
        SELECT rel.relname AS tabela,
               con.contype::text AS tipo,
               con.conname AS nome,
               pg_get_constraintdef(con.oid) AS definicao
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = rel.relnamespace
        WHERE n.nspname = 'public' AND con.contype IN ('p', 'u', 'f')
        ORDER BY rel.relname, con.conname
      `)
    ).rows;

    indices = (
      await raw.query<IndiceBanco>(`
        SELECT t.relname AS tabela,
               i.relname AS nome,
               pg_get_indexdef(x.indexrelid) AS definicao,
               x.indpred IS NOT NULL AS parcial,
               x.indexprs IS NOT NULL AS "porExpressao",
               EXISTS (
                 SELECT 1 FROM pg_constraint k WHERE k.conindid = x.indexrelid
               ) AS "deConstraint"
        FROM pg_index x
        JOIN pg_class i ON i.oid = x.indexrelid
        JOIN pg_class t ON t.oid = x.indrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'public'
        ORDER BY t.relname, i.relname
      `)
    ).rows;
  }, 120_000);

  afterAll(async () => {
    await raw?.end();
    await lock?.query('SELECT pg_advisory_unlock($1)', [SCHEMA_LOCK]);
    await lock?.end();
  });

  it('toda tabela tem tipagem e toda tipagem tem tabela', () => {
    const noBanco = [...new Set(colunas.map((c) => c.tabela))].sort();
    const semTipagem = noBanco.filter((t) => !ts.has(t) && !(t in TABELAS_SEM_TIPAGEM));
    expect(semTipagem).toEqual([]);

    const semTabela = [...ts.keys()].filter((t) => !noBanco.includes(t)).sort();
    expect(semTabela).toEqual([]);

    // A lista de exceções não pode envelhecer: toda entrada dela existe.
    expect(Object.keys(TABELAS_SEM_TIPAGEM).filter((t) => !noBanco.includes(t))).toEqual([]);
  });

  it('as colunas batem: nome, tipo, NOT NULL e DEFAULT', () => {
    const divergencias: string[] = [];
    for (const { tabela, coluna, descricao } of colunas) {
      const declarada = ts.get(tabela);
      if (!declarada) continue;
      const nossa = declarada.colunas.get(coluna);
      if (nossa === undefined)
        divergencias.push(`${tabela}.${coluna}: só no banco (${descricao})`);
      else if (nossa !== descricao)
        divergencias.push(`${tabela}.${coluna}: banco ${descricao} / schema.ts ${nossa}`);
    }
    for (const [tabela, declarada] of ts) {
      const noBanco = new Set(colunas.filter((c) => c.tabela === tabela).map((c) => c.coluna));
      for (const coluna of declarada.colunas.keys())
        if (!noBanco.has(coluna)) divergencias.push(`${tabela}.${coluna}: só no schema.ts`);
    }
    expect(divergencias).toEqual([]);
  });

  it('chave primária e UNIQUE batem, inclusive o nome da constraint', () => {
    const divergencias: string[] = [];
    for (const [tabela, declarada] of ts) {
      const doBanco = constraints.filter((c) => c.tabela === tabela);
      const pk = doBanco.find((c) => c.tipo === 'p');
      const noBanco = pk ? `${pk.nome}: ${colunasDaConstraint(pk.definicao)}` : '(nenhuma)';
      if (noBanco !== declarada.pk)
        divergencias.push(`${tabela} PK: banco ${noBanco} / schema.ts ${declarada.pk}`);

      const uniquesBanco = new Map(
        doBanco
          .filter((c) => c.tipo === 'u')
          .map((c) => [c.nome, colunasDaConstraint(c.definicao)]),
      );
      for (const [nome, cols] of uniquesBanco) {
        const nossa = declarada.uniques.get(nome);
        if (nossa === undefined)
          divergencias.push(`${tabela}: UNIQUE ${nome} (${cols}) só no banco`);
        else if (nossa !== cols)
          divergencias.push(`${tabela}: UNIQUE ${nome} banco (${cols}) / schema.ts (${nossa})`);
      }
      for (const [nome, cols] of declarada.uniques)
        if (!uniquesBanco.has(nome))
          divergencias.push(`${tabela}: UNIQUE ${nome} (${cols}) só no schema.ts`);
    }
    expect(divergencias).toEqual([]);
  });

  it('as chaves estrangeiras batem, com a ação de remoção', () => {
    // O nome não entra na comparação: o Postgres chama `<tabela>_<coluna>_fkey`
    // a FK que o `REFERENCES` da coluna cria e o Drizzle chamaria
    // `<tabela>_<coluna>_<alvo>_fk`, e o DSL só deixa nomear a FK declarada na
    // tabela (`foreignKey({ name })`). O que identifica a chave são as colunas.
    const divergencias: string[] = [];
    for (const [tabela, declarada] of ts) {
      const noBanco = new Set(
        constraints
          .filter((c) => c.tabela === tabela && c.tipo === 'f')
          .map((c) => descreveFk(c.definicao)),
      );
      for (const fk of noBanco)
        if (!declarada.fks.has(fk)) divergencias.push(`${tabela}: ${fk} só no banco`);
      for (const fk of declarada.fks)
        if (!noBanco.has(fk)) divergencias.push(`${tabela}: ${fk} só no schema.ts`);
    }
    expect(divergencias).toEqual([]);
  });

  it('os índices batem, e os que não cabem no DSL estão na lista', () => {
    const divergencias: string[] = [];
    for (const idx of indices) {
      // Índice de constraint é a PK ou o UNIQUE, comparados no teste acima.
      if (idx.deConstraint) continue;
      if (idx.nome in SOMENTE_SQL) {
        if (!idx.parcial && !idx.porExpressao)
          divergencias.push(
            `${idx.nome}: em SOMENTE_SQL sem ser parcial nem por expressão — declare no schema.ts`,
          );
        continue;
      }
      if (idx.parcial || idx.porExpressao) {
        divergencias.push(
          `${idx.nome}: parcial ou por expressão e fora de SOMENTE_SQL — ${idx.definicao}`,
        );
        continue;
      }
      const declarada = ts.get(idx.tabela);
      if (!declarada) continue;
      const nossa = declarada.indices.get(idx.nome);
      const corpo = corpoDoIndice(idx.definicao);
      if (nossa === undefined) divergencias.push(`${idx.nome}: só no banco — ${corpo}`);
      else if (nossa !== corpo)
        divergencias.push(`${idx.nome}: banco ${corpo} / schema.ts ${nossa}`);
    }
    const nomesNoBanco = new Set(indices.map((i) => i.nome));
    for (const [tabela, declarada] of ts)
      for (const nome of declarada.indices.keys())
        if (!nomesNoBanco.has(nome)) divergencias.push(`${tabela}.${nome}: só no schema.ts`);
    // A lista de exceções não pode envelhecer: todo índice dela existe.
    for (const nome of Object.keys(SOMENTE_SQL))
      if (!nomesNoBanco.has(nome)) divergencias.push(`${nome}: está em SOMENTE_SQL e não existe`);
    expect(divergencias).toEqual([]);
  });
});

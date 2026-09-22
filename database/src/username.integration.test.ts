/**
 * Teste de integração da migration `033-username.sql` — exige um PostgreSQL 18
 * real.
 *
 * O que as outras suítes não cobrem: o **efeito sobre dados que já estavam no
 * banco**. As demais partem de um schema completo e criam contas com username;
 * aqui a base para no `032`, recebe contas e trilha do "mundo antigo" (sem
 * username, com e-mail congelado em todo rótulo) e só então a `033` roda. É o
 * único lugar onde o backfill e a reescrita do histórico são medidos.
 *
 * Fica desligado por padrão: sem `TEST_DATABASE_URL` a suíte inteira é pulada,
 * então `npm test` continua rodando sem banco. Para rodar:
 *
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/purple_skills_test \
 *     npx vitest run database/src/username.integration.test.ts
 *
 * O banco apontado é **recriado do zero** (DROP SCHEMA public CASCADE) a cada
 * execução: aponte para um banco descartável, nunca para o de desenvolvimento.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { usernameFromName, usernameFromUuid } from '@purple-skills/shared';
import { closeDb } from './client.js';
import { runMigrations, schemaDir } from './migrate.js';
import { getUserByUuid, listSkillAccesses } from './queries.js';

const url = process.env.TEST_DATABASE_URL;

/**
 * O Vitest roda arquivos de teste em paralelo e as suítes de integração
 * recriam o **mesmo** banco. Um advisory lock segurado por toda a duração do
 * arquivo faz uma esperar a outra terminar, em vez de derrubar o schema no
 * meio da execução dela. O número precisa ser o mesmo das outras suítes.
 */
const SCHEMA_LOCK = 8_200_004;

/**
 * Os uuids das contas são escritos à mão, e os quatro primeiros compartilham
 * os **8 primeiros hex** de propósito: é o que `uuidv7()` faz com contas
 * criadas no mesmo minuto (os 8 primeiros hex são os 32 bits altos do carimbo
 * de milissegundos, que só mudam a cada ~65 s). Sem isso o caso de duas contas
 * caindo no mesmo `user-<8 hex>` não apareceria em teste nenhum.
 */
const U = (n: number): string => `01990000-0000-7000-8000-00000000000${n}`;

let raw: pg.Client;

async function applyUpTo(client: pg.Client, last: string): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  const files = readdirSync(schemaDir())
    .filter((file) => file.endsWith('.sql') && file.slice(0, 3) <= last)
    .sort();
  for (const file of files) {
    await client.query('BEGIN');
    await client.query(readFileSync(join(schemaDir(), file), 'utf8'));
    await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    await client.query('COMMIT');
  }
}

/** `<ação> | <ator> | <alvo>` de cada linha da trilha, na ordem de gravação. */
async function trilha(): Promise<string[]> {
  const { rows } = await raw.query<{ linha: string }>(
    `SELECT action || ' | ' || coalesce(actor_label, '<nulo>') || ' | ' ||
            coalesce(target_label, '<nulo>') AS linha
       FROM audit_log ORDER BY created_at, id`,
  );
  return rows.map((r) => r.linha);
}

async function usernameDe(uuid: string): Promise<string | null> {
  return (await getUserByUuid(uuid))?.username ?? null;
}

describe.skipIf(!url)('033: username, backfill e reescrita do histórico', () => {
  beforeAll(async () => {
    raw = new pg.Client({ connectionString: url });
    await raw.connect();
    await raw.query('SELECT pg_advisory_lock($1)', [SCHEMA_LOCK]);

    await raw.query('DROP SCHEMA IF EXISTS public CASCADE');
    await raw.query('CREATE SCHEMA public');

    // Uma base parada no `032`: é o mundo antes do username.
    await applyUpTo(raw, '032');

    // As contas do cenário. Os nomes cobrem, um a um, os casos da `§3.1`:
    // acento, colisão de nome, nome inutilizável, nome reservado, nome curto
    // demais, nome acima do teto de 32 — e os dois e-mails em que um é sufixo
    // do outro (`ana@x.com` dentro de `mariana@x.com`).
    await raw.query(
      `INSERT INTO users (uuid, email, name, role, created_at) VALUES
         ($1,  'ana@x.com',     'Ana Souza',      'membro', '2025-01-01'),
         ($2,  'mariana@x.com', 'Mariana Lopes',  'editor', '2025-01-02'),
         ($3,  'zz@x.com',      '!!! ???',        'membro', '2025-01-03'),
         ($4,  'adm@x.com',     'Admin',          'membro', '2025-01-04'),
         ($5,  'ana2@x.com',    'Ana Souza',      'membro', '2025-01-05'),
         ($6,  'jo@x.com',      'Jô',             'membro', '2025-01-06'),
         ($7,  'pat@x.com',     'Patrick Brandão', 'admin', '2025-01-07'),
         ($8,  'longo@x.com',   'Maria Aparecida Conceição do Nascimento Silva',
                                                  'membro', '2025-01-08')`,
      [U(1), U(2), U(3), U(4), U(5), U(6), U(7), U(8)],
    );

    await raw.query(
      `INSERT INTO skills (uuid, slug, name, description) VALUES ($1, 'minha-skill', 'Minha Skill', '')`,
      [U(9)],
    );

    // A trilha do mundo antigo, nos quatro formatos de rótulo que as
    // migrations `004`, `017`, `024`, `026` e `031` produzem.
    await raw.query(`
      INSERT INTO audit_log (action, source, actor_label, target_label, skill_slug) VALUES
        ('user.create',     'web-admin', 'pat@x.com', 'ana@x.com',                     NULL),
        ('skill.share',     'web-admin', 'pat@x.com', 'ana@x.com:edit',                'minha-skill'),
        ('catalog.share',   'web-admin', 'pat@x.com', 'meu-catalogo ana@x.com:manage', NULL),
        ('mcp.unshare',     'web-admin', 'pat@x.com', 'meu-mcp mariana@x.com',         NULL),
        ('user.link',       'web-admin', 'oidc:https://accounts.google.com',
                                                      'ana@x.com (sub 12345)',         NULL),
        ('update',          'web-admin', 'token-global', 'ana@x.com',                  'minha-skill'),
        ('user.role',       'web-admin', 'mariana@x.com', 'mariana@x.com',             NULL),
        ('user.deactivate', 'web-admin', 'pat@x.com', 'sumiu@x.com',                   NULL),
        ('skill.unshare',   'web-admin', 'sumiu@x.com', 'outro@y.com.br',              'minha-skill'),
        ('user.create',     'web-admin', 'pat@x.com', 'ana@x.com.br',                  NULL),
        ('quarantine.create',  'web-admin', 'pat@x.com', 'relatorio@2026.q1',          NULL),
        ('quarantine.promote', 'web-admin', 'pat@x.com',
                                          'relatorio@2026.q1 -> relatorio-2026',       NULL),
        ('rag.settings',    'web-admin', 'pat@x.com', 'rag.driver=google',             NULL)
    `);

    // Os acessos do mundo antigo: por uuid, só por e-mail (com outra caixa),
    // de conta que já sumiu e sem conta nenhuma.
    await raw.query(
      `INSERT INTO skill_accesses
         (skill_uuid, skill_slug, skill_name, kind, surface, origin, auth, user_uuid, user_email)
       VALUES
         ($1, 'minha-skill', 'Minha Skill', 'view', 'admin-tool', 'mcp-admin', 'user', $2,   'ana@x.com'),
         ($1, 'minha-skill', 'Minha Skill', 'view', 'admin-tool', 'mcp-admin', 'user', NULL, 'MARIANA@x.com'),
         ($1, 'minha-skill', 'Minha Skill', 'view', 'admin-tool', 'mcp-admin', 'user', NULL, 'sumiu@x.com'),
         ($1, 'minha-skill', 'Minha Skill', 'view', 'page',       'site',      'anonymous', NULL, NULL)`,
      [U(9), U(1)],
    );

    // E então o `033` — e o que a pasta trouxer depois dele, lido dela como a
    // suíte de `settings` faz: uma lista escrita à mão quebraria a cada
    // migration nova, de quem quer que seja. O que esta suíte mede continua
    // sendo o `033` sobre dados do mundo antigo; as seguintes vêm junto
    // porque o runner aplica tudo o que falta.
    const doTrintaETresEmDiante = readdirSync(schemaDir())
      .filter((file) => file.endsWith('.sql') && file.slice(0, 3) >= '033')
      .sort();
    expect(doTrintaETresEmDiante[0]).toBe('033-username.sql');
    expect(await runMigrations(url!)).toEqual(doTrintaETresEmDiante);
    process.env.DATABASE_URL = url;
  }, 120_000);

  afterAll(async () => {
    await closeDb();
    if (!raw) return;
    await raw.query('SELECT pg_advisory_unlock($1)', [SCHEMA_LOCK]);
    await raw.end();
  });

  it('deriva o username do nome, com acento, teto e sufixo em colisão', async () => {
    // O caminho feliz, e a prova de que o mapa de acentos do SQL é o mesmo do
    // shared: as duas implementações têm de chegar ao mesmo texto.
    expect(await usernameDe(U(7))).toBe('patrick-brandao');
    expect(usernameFromName('Patrick Brandão')).toBe('patrick-brandao');

    // Nunca do e-mail: `pat@x.com` daria `pat`, e publicar o local part para
    // todo o painel é o vazamento que esta mudança fecha (decisão 4).
    expect(await usernameDe(U(7))).not.toBe('pat');

    // Colisão de nome: quem chegou primeiro fica com o derivado e o segundo
    // recebe o sufixo numérico (`usernameWithSuffix`).
    expect(await usernameDe(U(1))).toBe('ana-souza');
    expect(await usernameDe(U(5))).toBe('ana-souza-2');

    // Teto de 32, com a pontuação da emenda aparada.
    const longo = await usernameDe(U(8));
    expect(longo).toBe('maria-aparecida-conceicao-do-nas');
    expect(longo).toHaveLength(32);
  });

  it('nome inutilizável, reservado ou curto demais cai no user-<8 hex> — e o sufixo resolve o empate', async () => {
    // `!!! ???` não sobra nada, `Admin` é reservado e `Jô` fica com dois
    // caracteres: os três caem no fallback. Como os uuids compartilham os 8
    // primeiros hex (o que `uuidv7()` faz no mesmo minuto), o fallback é o
    // **mesmo** para os três — e é o sufixo numérico que salva o índice único.
    expect(usernameFromName('!!! ???')).toBeNull();
    expect(usernameFromName('Admin')).toBeNull();
    expect(usernameFromName('Jô')).toBeNull();
    expect(usernameFromUuid(U(3))).toBe('user-01990000');

    expect(await usernameDe(U(3))).toBe('user-01990000');
    expect(await usernameDe(U(4))).toBe('user-01990000-2');
    expect(await usernameDe(U(6))).toBe('user-01990000-3');
  });

  it('a coluna vira obrigatória, única por lower(username), e o livro nasce com todas', async () => {
    const { rows: colunas } = await raw.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = 'username'`,
    );
    expect(colunas).toEqual([{ is_nullable: 'NO' }]);

    await expect(
      raw.query(`INSERT INTO users (username, email, name, role)
                 VALUES ('ANA-SOUZA', 'nova@x.com', 'Nova', 'membro')`),
    ).rejects.toThrow(/users_username_lower_uniq/);

    // Uma linha por conta, sem nenhuma liberada: ninguém trocou de nome ainda.
    const { rows } = await raw.query<{ n: number; livres: number }>(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE released_at IS NOT NULL)::int AS livres
         FROM usernames`,
    );
    expect(rows[0]).toEqual({ n: 8, livres: 0 });
    expect(
      (await raw.query('SELECT user_uuid FROM usernames WHERE username_lower = $1', ['ana-souza']))
        .rows,
    ).toEqual([{ user_uuid: U(1) }]);
  });

  it('reescreve a trilha: username onde a conta existe, `conta removida` no resto', async () => {
    expect(await trilha()).toEqual([
      // Os quatro formatos de rótulo, cada um com o e-mail trocado no lugar
      // certo e o resto intacto.
      'user.create | patrick-brandao | ana-souza',
      'skill.share | patrick-brandao | ana-souza:edit',
      'catalog.share | patrick-brandao | meu-catalogo ana-souza:manage',
      'mcp.unshare | patrick-brandao | meu-mcp mariana-lopes',
      'user.link | oidc:https://accounts.google.com | ana-souza (sub 12345)',
      'update | token-global | ana-souza',

      // **`ana@x.com` não foi trocado dentro de `mariana@x.com`.** Duas
      // defesas cobrem isto: a ordem decrescente de `length(email)` (o e-mail
      // maior é substituído primeiro, e depois não há o menor onde procurar) e
      // a fronteira nas duas pontas (o `i` antes de `ana@` não é espaço nem
      // começo de texto). Sem elas a linha viraria `marina-souza`, uma conta
      // que não existe.
      'user.role | mariana-lopes | mariana-lopes',

      // Conta que já não existe: a varredura final, restrita às ações cujo
      // rótulo sabidamente é e-mail.
      'user.deactivate | patrick-brandao | conta removida',
      'skill.unshare | conta removida | conta removida',
      // `ana@x.com.br` **não** é a conta `ana@x.com` (a fronteira à direita
      // recusa o `.`), e como não é conta nenhuma vira `conta removida`.
      'user.create | patrick-brandao | conta removida',

      // **Quarentena fica fora da varredura**: `target_label` ali é nome de
      // envio escrito por gente, e um envio chamado `relatorio@2026.q1` não é
      // conta nenhuma. `rag.settings` (`chave=valor`) idem.
      'quarantine.create | patrick-brandao | relatorio@2026.q1',
      'quarantine.promote | patrick-brandao | relatorio@2026.q1 -> relatorio-2026',
      'rag.settings | patrick-brandao | rag.driver=google',
    ]);
  });

  it('skill_accesses troca user_email por user_username, pelo uuid e pelo e-mail', async () => {
    const { rows } = await raw.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_name = 'skill_accesses' AND column_name = 'user_email'`,
    );
    expect(rows[0]?.n).toBe(0);

    const itens = (await listSkillAccesses({})).items;
    expect([...itens.map((a) => a.userUsername)].sort()).toEqual([
      'ana-souza',
      'conta removida',
      // Casou por `lower(email)`, com o uuid já nulo e a caixa diferente.
      'mariana-lopes',
      // A leitura anônima do site fica **sem** username: não havia conta, e
      // `conta removida` ali seria inventar uma que nunca houve.
      null,
    ]);

    // O GIN de trigrama do `022` foi recriado sobre a coluna nova: sem ele o
    // `q` da guia Acessos volta ao `Seq Scan`.
    const { rows: indices } = await raw.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'skill_accesses' AND indexname LIKE '%user_%trgm%'`,
    );
    expect(indices.map((r) => r.indexname)).toEqual(['skill_accesses_user_username_trgm_idx']);
  });

  it('user.username entra no CHECK e as ações antigas continuam lá', async () => {
    await raw.query(
      `INSERT INTO audit_log (action, source, actor_label, target_label)
       VALUES ('user.username', 'web-admin', 'patrick-brandao', 'ana-souza -> ana')`,
    );
    await expect(
      raw.query(
        `INSERT INTO audit_log (action, source) VALUES ('user.nickname', 'web-admin')`,
      ),
    ).rejects.toThrow(/audit_log_action_check/);
    // A lista repetida no `033` parte da do `031`: a clonagem continua válida.
    await raw.query(
      `INSERT INTO audit_log (action, source, target_label)
       VALUES ('skill.clone', 'web-admin', 'a -> b')`,
    );
    await raw.query("DELETE FROM audit_log WHERE action IN ('user.username', 'skill.clone')");
  });

  it('reaplicar o 033 não reescreve nada e não falha', async () => {
    const antes = await trilha();
    const contas = (
      await raw.query<{ nomes: string }>(
        `SELECT string_agg(username, ',' ORDER BY uuid) AS nomes FROM users`,
      )
    ).rows[0]?.nomes;
    const livro = (
      await raw.query<{ nomes: string }>(
        `SELECT string_agg(username_lower, ',' ORDER BY username_lower) AS nomes FROM usernames`,
      )
    ).rows[0]?.nomes;

    // Apagar do histórico é o que força o runner a rodar o arquivo de novo —
    // uma segunda chamada normal só o pularia. A recusa de reaplicação
    // retroativa é do **CLI**; quem chama `runMigrations` direto passa.
    await raw.query("DELETE FROM schema_migrations WHERE name = '033-username.sql'");
    expect(await runMigrations(url!)).toEqual(['033-username.sql']);

    expect(await trilha()).toEqual(antes);
    expect(
      (await raw.query<{ nomes: string }>(
        `SELECT string_agg(username, ',' ORDER BY uuid) AS nomes FROM users`,
      )).rows[0]?.nomes,
    ).toBe(contas);
    expect(
      (await raw.query<{ nomes: string }>(
        `SELECT string_agg(username_lower, ',' ORDER BY username_lower) AS nomes FROM usernames`,
      )).rows[0]?.nomes,
    ).toBe(livro);

    // A função auxiliar da reescrita não fica no banco: ela existe só durante
    // a migration e é derrubada na mesma transação.
    expect(
      (await raw.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'username_troca_rotulo'`,
      )).rows[0]?.n,
    ).toBe(0);
  });
});

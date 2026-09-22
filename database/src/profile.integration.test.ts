/**
 * Teste de integração do perfil (`docs/20-perfil.md`,
 * `schema/034-perfil.sql`) — exige um PostgreSQL 18 real.
 *
 * Fica desligado por padrão: sem `TEST_DATABASE_URL` a suíte inteira é pulada,
 * então `npm test` continua rodando sem banco. Para rodar:
 *
 *   TEST_DATABASE_URL=postgres://postgres:CHANGE_ME@127.0.0.1:5432/purple_skills_test \
 *     npx vitest run database/src/profile.integration.test.ts
 *
 * O banco apontado é **recriado do zero** (DROP SCHEMA public CASCADE) a cada
 * execução: aponte para um banco descartável, nunca para o de desenvolvimento.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { AVATAR_MAX_BYTES, BIO_MAX_LENGTH, PROFILE_LINKS_MAX } from '@purple-skills/shared';
import { closeDb } from './client.js';
import { runMigrations, schemaDir } from './migrate.js';
import { AppError } from './errors.js';
import {
  avatarStamp,
  clearProfile,
  createCatalog,
  createSkill,
  createUser,
  createVirtualMcp,
  deleteAvatar,
  getAvatar,
  getAvatarByUsername,
  getProfile,
  getPublicCatalog,
  getPublicProfile,
  getSkillSummary,
  getUserByUuid,
  isProfilePublic,
  linkSkill,
  listAuditPage,
  listPublicByOwner,
  listPublicCatalogs,
  listSkills,
  listUsers,
  saveProfile,
  setAvatar,
  setCatalogSkills,
  updateUser,
} from './queries.js';

const url = process.env.TEST_DATABASE_URL;
const SOURCE = 'web-admin' as const;

/**
 * O caractere nulo **montado em código**: escrevê-lo no fonte faria deste
 * arquivo um binário aos olhos do CI (`docs/03-implementation-notes.md`, as
 * armadilhas medidas em 2026-09-18) — e já pegou `queries.ts` uma vez.
 */
const NUL = String.fromCharCode(0);

/**
 * O Vitest roda arquivos de teste em paralelo e as suítes de integração
 * recriam o **mesmo** banco. Um advisory lock segurado por toda a duração do
 * arquivo faz uma esperar a outra terminar, em vez de derrubar o schema no
 * meio da execução dela. O número precisa ser o mesmo das outras suítes.
 */
const SCHEMA_LOCK = 8_200_004;

let raw: pg.Client;
let anaUuid = '';
let brunoUuid = '';
let carlaUuid = '';
let doraUuid = '';
let abertoUuid = '';

const ana = { userUuid: '', label: 'ana' };

// ------------------------------------------------------------- fixtures ----

/**
 * Imagens mínimas, montadas pelos bytes de assinatura que `sniffAvatarMime`
 * reconhece. Não são imagens decodificáveis, e não precisam ser: o produto
 * **não** redimensiona nem decodifica nada (`docs/20` §3.2), e o que decide o
 * tipo são os primeiros bytes.
 */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('purple-skills:png'),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('purple-skills:jpeg')]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x20, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP'),
  Buffer.from('VP8 purple'),
]);
/** XML com `<script>` dentro: o formato que a decisão do `§3.2` recusa por escrito. */
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

const hexDe = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

async function capture(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (err) {
    return err as AppError;
  }
  throw new Error('a chamada deveria ter falhado');
}

/** Quantas linhas as duas tabelas do `034` têm para uma conta. */
async function linhasDoPerfil(uuid: string): Promise<{ perfis: number; avatares: number }> {
  const { rows } = await raw.query<{ perfis: string; avatares: string }>(
    `SELECT (SELECT count(*) FROM user_profiles WHERE user_uuid = $1) AS perfis,
            (SELECT count(*) FROM user_avatars  WHERE user_uuid = $1) AS avatares`,
    [uuid],
  );
  return { perfis: Number(rows[0]!.perfis), avatares: Number(rows[0]!.avatares) };
}

/** Os slugs que o site enxerga de uma pessoa, em ordem. */
const slugs = (items: readonly { slug: string }[]): string[] => items.map((i) => i.slug);

const TOOLS = { asSkill: true, asPrompt: false, asResource: false };

describe.skipIf(!url)('perfil: a página atrás do @username', () => {
  beforeAll(async () => {
    raw = new pg.Client({ connectionString: url });
    await raw.connect();
    await raw.query('SELECT pg_advisory_lock($1)', [SCHEMA_LOCK]);

    await raw.query('DROP SCHEMA IF EXISTS public CASCADE');
    await raw.query('CREATE SCHEMA public');
    await runMigrations(url!);
    // As queries resolvem a conexão por `getDb()`, que lê o ambiente na
    // primeira chamada — ainda não houve nenhuma até aqui.
    process.env.DATABASE_URL = url;

    const criada = async (username: string, name: string, role: 'admin' | 'editor' | 'membro') =>
      (await createUser({ username, email: `${username}@exemplo.dev`, name, role })).uuid;
    anaUuid = await criada('ana', 'Ana', 'admin');
    brunoUuid = await criada('bruno', 'Bruno', 'editor');
    carlaUuid = await criada('carla', 'Carla', 'editor');
    doraUuid = await criada('dora', 'Dora', 'editor');
    ana.userUuid = anaUuid;

    const bruno = { userUuid: brunoUuid, label: 'bruno' };
    abertoUuid = (
      await createVirtualMcp({ name: 'Aberto', isOpen: true, ownerUserUuid: anaUuid }, SOURCE, ana)
    ).uuid;

    // O acervo do Bruno, um caso por caminho de exposição do site.
    await createSkill({ name: 'Publica', slug: 'publica', isPublic: true, skillMd: '# p' }, SOURCE, bruno);
    await createSkill({ name: 'Privada', slug: 'privada', skillMd: '# q' }, SOURCE, bruno);
    await createSkill(
      { name: 'Desligada', slug: 'desligada', isPublic: true, isActive: false, skillMd: '# r' },
      SOURCE,
      bruno,
    );
    await createSkill({ name: 'Em vMCP aberto', slug: 'em-vmcp-aberto', skillMd: '# s' }, SOURCE, bruno);
    await linkSkill('em-vmcp-aberto', abertoUuid, TOOLS, SOURCE, ana);

    // Uma de cada uma das outras, para o `ownerHasProfile`.
    await createSkill({ name: 'Da Ana', slug: 'da-ana', isPublic: true, skillMd: '# a' }, SOURCE, ana);
    await createSkill(
      { name: 'Da Carla', slug: 'da-carla', isPublic: true, skillMd: '# c' },
      SOURCE,
      { userUuid: carlaUuid, label: 'carla' },
    );
    await createSkill(
      { name: 'Da Dora', slug: 'da-dora', isPublic: true, skillMd: '# d' },
      SOURCE,
      { userUuid: doraUuid, label: 'dora' },
    );
    // Órfã: dono nulo, o que o token global e o bootstrap criam.
    await createSkill({ name: 'Orfa', slug: 'orfa', isPublic: true, skillMd: '# o' }, SOURCE);

    const publico = await createCatalog(
      { name: 'Catálogo público', slug: 'cat-publico', isPublic: true, ownerUserUuid: brunoUuid },
      SOURCE,
      ana,
    );
    // `setCatalogSkills` endereça o catálogo pelo **uuid** (o slug é de
    // `getCatalog`), e a participação ativa é o que o `skillCount` conta.
    await setCatalogSkills(publico.uuid, [{ slug: 'publica' }], SOURCE, ana);
    expect(publico.isPublic).toBe(true);
    await createCatalog(
      { name: 'Catálogo privado', slug: 'cat-privado', ownerUserUuid: brunoUuid },
      SOURCE,
      ana,
    );
    await createCatalog(
      { name: 'Catálogo desligado', slug: 'cat-desligado', isPublic: true, ownerUserUuid: brunoUuid },
      SOURCE,
      ana,
    );
    await raw.query(`UPDATE catalogs SET is_active = false WHERE slug = 'cat-desligado'`);
  }, 60_000);

  afterAll(async () => {
    await closeDb();
    await raw.query('SELECT pg_advisory_unlock($1)', [SCHEMA_LOCK]);
    await raw.end();
  });

  // ------------------------------------------------- a linha que nasce -----

  it('a conta nasce sem linha de perfil, e a leitura devolve o vazio e privado', async () => {
    expect(await linhasDoPerfil(brunoUuid)).toEqual({ perfis: 0, avatares: 0 });

    // "Sem perfil" e "perfil em branco" são o mesmo estado para quem lê: a tela
    // abre com os campos vazios em vez de precisar tratar um nulo.
    expect(await getProfile(brunoUuid)).toEqual({
      username: 'bruno',
      name: 'Bruno',
      bio: '',
      websiteUrl: null,
      links: [],
      isPublic: false,
      hasAvatar: false,
      avatarUpdatedAt: null,
    });

    // Conta que não existe (e uuid torto) é **404**, não o perfil vazio: "não
    // tem perfil" e "não tem conta" são coisas diferentes, e é a mesma resposta
    // que `saveProfile` e `clearProfile` dão ao mesmo caso.
    expect((await capture(getProfile('00000000-0000-7000-8000-000000000000'))).status).toBe(404);
    expect((await capture(getProfile('nao-e-uuid'))).status).toBe(404);
  });

  it('o primeiro salvamento faz a linha nascer, e o perfil nasce privado', async () => {
    const salvo = await saveProfile(brunoUuid, {
      bio: 'Mantenho skills de infraestrutura.',
      websiteUrl: 'https://bruno.exemplo.dev',
      links: [{ label: 'GitHub', url: 'https://github.com/bruno' }],
    });

    expect(salvo).toMatchObject({
      username: 'bruno',
      name: 'Bruno',
      bio: 'Mantenho skills de infraestrutura.',
      websiteUrl: 'https://bruno.exemplo.dev',
      links: [{ label: 'GitHub', url: 'https://github.com/bruno' }],
      // Opt-in: salvar não publica (decisão 4).
      isPublic: false,
    });
    expect(await linhasDoPerfil(brunoUuid)).toEqual({ perfis: 1, avatares: 0 });
    expect(await getProfile(brunoUuid)).toEqual(salvo);

    // Nada de auditoria: a edição do próprio perfil fica fora da trilha, pelo
    // mesmo critério que mantém o login fora dela.
    const trilha = await listAuditPage({ action: 'user.profile' });
    expect(trilha.total).toBe(0);
  });

  it('campo ausente não é regravado, e `websiteUrl: null` apaga', async () => {
    // O PATCH do painel manda só o que mudou. Ligar o perfil não pode apagar a
    // bio de ninguém.
    const publicado = await saveProfile(brunoUuid, { isPublic: true });
    expect(publicado.bio).toBe('Mantenho skills de infraestrutura.');
    expect(publicado.websiteUrl).toBe('https://bruno.exemplo.dev');
    expect(publicado.isPublic).toBe(true);

    // `null` é a única forma de limpar o site: em `normalizeWebsite` o ausente
    // e o nulo devolvem o mesmo valor, e quem separa os dois é a presença da
    // chave.
    const semSite = await saveProfile(brunoUuid, { websiteUrl: null });
    expect(semSite.websiteUrl).toBeNull();
    expect(semSite.bio).toBe('Mantenho skills de infraestrutura.');
    expect(semSite.links).toEqual([{ label: 'GitHub', url: 'https://github.com/bruno' }]);

    await saveProfile(brunoUuid, { websiteUrl: 'https://bruno.exemplo.dev' });
  });

  it('o nome de exibição é o de `users`, e o perfil é a única escrita não-admin nele', async () => {
    const antes = await getUserByUuid(brunoUuid);
    const salvo = await saveProfile(brunoUuid, { name: '  Bruno Dias  ' });
    expect(salvo.name).toBe('Bruno Dias');

    const depois = await getUserByUuid(brunoUuid);
    expect(depois?.name).toBe('Bruno Dias');
    // Só o nome: papel, estado, e-mail e username continuam onde estavam.
    expect(depois).toMatchObject({
      username: antes!.username,
      email: antes!.email,
      role: antes!.role,
      isActive: antes!.isActive,
    });
    // Trocar o nome é alteração da conta, e o carimbo acompanha.
    expect(new Date(depois!.updatedAt).getTime()).toBeGreaterThan(
      new Date(antes!.updatedAt).getTime(),
    );

    expect((await capture(saveProfile(brunoUuid, { name: '   ' }))).status).toBe(400);
    expect((await capture(saveProfile(brunoUuid, { name: 42 as never }))).status).toBe(400);
    await saveProfile(brunoUuid, { name: 'Bruno' });
  });

  it('as recusas da regra do shared chegam como 400 com o campo nomeado', async () => {
    const erros = await Promise.all([
      capture(saveProfile(brunoUuid, { bio: 'x'.repeat(BIO_MAX_LENGTH + 1) })),
      capture(saveProfile(brunoUuid, { bio: 42 as never })),
      capture(saveProfile(brunoUuid, { bio: `tem${NUL}nulo` })),
      capture(saveProfile(brunoUuid, { websiteUrl: 'javascript:alert(1)' })),
      capture(saveProfile(brunoUuid, { websiteUrl: 'exemplo.dev' })),
      capture(
        saveProfile(brunoUuid, {
          links: Array.from({ length: PROFILE_LINKS_MAX + 1 }, (_, i) => ({
            label: `L${i}`,
            url: `https://exemplo.dev/${i}`,
          })),
        }),
      ),
      capture(
        saveProfile(brunoUuid, {
          links: [
            { label: 'Um', url: 'https://exemplo.dev/a' },
            { label: 'Outro', url: 'https://EXEMPLO.dev/a' },
          ],
        }),
      ),
      capture(saveProfile(brunoUuid, { links: [{ label: '', url: 'https://exemplo.dev' }] })),
      capture(saveProfile(brunoUuid, { links: [{ label: `x${NUL}`, url: 'https://exemplo.dev' }] })),
      capture(saveProfile(brunoUuid, { isPublic: 'sim' as never })),
    ]);
    expect(erros.map((e) => e.status)).toEqual([400, 400, 400, 400, 400, 400, 400, 400, 400, 400]);
    expect(erros[0]!.message).toMatch(/bio/);
    expect(erros[5]!.message).toMatch(/links/);

    // Nenhuma delas gravou: a bio continua a de antes.
    const perfil = await getProfile(brunoUuid);
    expect(perfil?.bio).toBe('Mantenho skills de infraestrutura.');
    expect(perfil?.links).toEqual([{ label: 'GitHub', url: 'https://github.com/bruno' }]);

    // A bio é normalizada antes de ser medida: CRLF vira LF e o espaço à
    // direita some, então 500 caracteres "de verdade" passam.
    const noTeto = await saveProfile(brunoUuid, { bio: `${'a'.repeat(BIO_MAX_LENGTH)}   \r\n` });
    expect(noTeto.bio).toHaveLength(BIO_MAX_LENGTH);
    await saveProfile(brunoUuid, { bio: 'Mantenho skills de infraestrutura.' });
  });

  it('conta inexistente é 404 nas escritas, com e sem `name`', async () => {
    const some = '00000000-0000-7000-8000-000000000000';
    // Sem `name` quem descobre é a chave estrangeira do upsert — e ela também
    // tem de virar 404, não 500.
    expect((await capture(saveProfile(some, { bio: 'oi' }))).status).toBe(404);
    expect((await capture(saveProfile(some, { name: 'Oi' }))).status).toBe(404);
    expect((await capture(saveProfile('torto', { bio: 'oi' }))).status).toBe(404);
    expect((await capture(setAvatar(some, PNG))).status).toBe(404);
    expect((await capture(clearProfile(some, SOURCE, ana))).status).toBe(404);
    expect((await capture(clearProfile('torto', SOURCE, ana))).status).toBe(404);
  });

  // ------------------------------------------------------------- a foto ----

  it('o tipo da foto sai dos bytes, e o SVG é recusado', async () => {
    const png = await setAvatar(brunoUuid, PNG);
    expect(png.mime).toBe('image/png');
    // O hash sai **cru** da coluna; o hexadecimal é do ETag, e quem o monta é
    // quem serve a imagem.
    expect(png.sha256.toString('hex')).toBe(hexDe(PNG));

    // Enviar de novo substitui: uma foto por conta.
    const jpeg = await setAvatar(brunoUuid, JPEG);
    expect(jpeg.mime).toBe('image/jpeg');
    expect(await linhasDoPerfil(brunoUuid)).toEqual({ perfis: 1, avatares: 1 });

    const webp = await setAvatar(brunoUuid, WEBP);
    expect(webp.mime).toBe('image/webp');

    // SVG é XML com `<script>` dentro: nenhum teto de tamanho resolve isso.
    const svg = await capture(setAvatar(brunoUuid, SVG));
    expect(svg.status).toBe(400);
    expect(svg.message).toMatch(/não reconhecido/);

    // O tipo informado é conferência, não fonte: quem repassa o `Content-Type`
    // do cliente recebe a recusa com os dois valores, em vez de gravar a
    // mentira que a rota depois serviria.
    const mentira = await capture(setAvatar(brunoUuid, PNG, 'image/svg+xml'));
    expect(mentira.status).toBe(400);
    expect(mentira.message).toMatch(/image\/svg\+xml.*image\/png/);
    expect((await capture(setAvatar(brunoUuid, PNG, 'image/jpeg'))).status).toBe(400);
    // Informado e correto passa — é como o painel chama, depois de sniffar.
    expect((await setAvatar(brunoUuid, PNG, 'image/png')).mime).toBe('image/png');

    // Vazio e acima do teto: os dois são 400, e o teto é conferido sobre os
    // bytes recebidos, não sobre o `Content-Length`.
    expect((await capture(setAvatar(brunoUuid, Buffer.alloc(0)))).status).toBe(400);
    const gorda = Buffer.concat([PNG, Buffer.alloc(AVATAR_MAX_BYTES)]);
    const recusada = await capture(setAvatar(brunoUuid, gorda));
    expect(recusada.status).toBe(400);
    expect(recusada.message).toMatch(/512 KB/);

    // A foto que ficou é a última aceita.
    expect((await getAvatar(brunoUuid))?.sha256.toString('hex')).toBe(hexDe(PNG));
  });

  it('o avatar volta byte a byte, com o sha256 que o ETag usa', async () => {
    await setAvatar(brunoUuid, WEBP);
    const avatar = await getAvatar(brunoUuid);
    expect(avatar?.bytes.equals(WEBP)).toBe(true);
    expect(avatar?.mime).toBe('image/webp');
    // O hash é calculado pelo banco sobre os bytes gravados e conferido pelo
    // CHECK: o ETag nunca descreve outros bytes.
    expect(avatar?.sha256.toString('hex')).toBe(hexDe(WEBP));

    // A irmã por username existe para o site não precisar de `getUserByUsername`,
    // que devolveria hash de senha e `token_version` para desenhar uma imagem.
    const porNome = await getAvatarByUsername('Bruno');
    expect(porNome?.bytes.equals(WEBP)).toBe(true);
    expect(porNome?.sha256.equals(avatar!.sha256)).toBe(true);
    expect(await getAvatarByUsername('nao-existe')).toBeNull();
    expect(await getAvatarByUsername('@bruno')).toBeNull();

    // O carimbo sozinho, para o cache-buster da URL sem ler a imagem.
    expect(await avatarStamp(brunoUuid)).toBe(avatar?.updatedAt);
    expect(await avatarStamp(carlaUuid)).toBeNull();
    expect(await avatarStamp('torto')).toBeNull();

    // O perfil diz que **há** foto e de quando ela é, e nunca traz os bytes.
    const perfil = await getProfile(brunoUuid);
    expect(perfil?.hasAvatar).toBe(true);
    expect(perfil?.avatarUpdatedAt).toBe(avatar?.updatedAt);
    expect(Object.keys(perfil!)).not.toContain('bytes');

    // E o carimbo acompanha a conta em toda lista do painel (`UserSummary`).
    const naLista = (await listUsers()).find((u) => u.uuid === brunoUuid);
    expect(naLista?.avatarUpdatedAt).toBe(avatar?.updatedAt);
    expect((await listUsers()).find((u) => u.uuid === carlaUuid)?.avatarUpdatedAt).toBeNull();
    expect((await getUserByUuid(brunoUuid))?.avatarUpdatedAt).toBe(avatar?.updatedAt);
  });

  it('as duas superfícies decidem sozinhas: o avatar não olha `is_public`', async () => {
    // Carla nunca abriu o perfil e mesmo assim tem foto no painel: o avatar
    // substitui o monograma entre contas logadas, e o `is_public` decide o que
    // sai para o **anônimo**.
    await setAvatar(carlaUuid, JPEG);
    expect(await linhasDoPerfil(carlaUuid)).toEqual({ perfis: 0, avatares: 1 });
    expect((await getAvatarByUsername('carla'))?.mime).toBe('image/jpeg');
    expect((await getProfile(carlaUuid))?.hasAvatar).toBe(true);
    // E a página pública dela não existe, que é o outro lado da mesma moeda.
    expect(await getPublicProfile('carla')).toBeNull();
  });

  it('apagar a foto é idempotente e não toca no resto do perfil', async () => {
    await setAvatar(doraUuid, PNG);
    expect(await deleteAvatar(doraUuid)).toBe(true);
    // Não havia nada: `false` é o estado normal, não erro.
    expect(await deleteAvatar(doraUuid)).toBe(false);
    expect(await deleteAvatar('torto')).toBe(false);
    expect(await getAvatar(doraUuid)).toBeNull();
  });

  // ----------------------------------------------------- a página pública ---

  it('a página pública só existe com `is_public` e conta ativa — e os três nãos são iguais', async () => {
    // Privado: Bruno salvou e ligou lá atrás, então vamos pelo caminho inverso.
    await saveProfile(brunoUuid, { isPublic: false });
    expect(await getPublicProfile('bruno')).toBeNull();

    await saveProfile(brunoUuid, { isPublic: true });
    const publico = await getPublicProfile('bruno');
    expect(publico).toMatchObject({
      username: 'bruno',
      name: 'Bruno',
      bio: 'Mantenho skills de infraestrutura.',
      websiteUrl: 'https://bruno.exemplo.dev',
      links: [{ label: 'GitHub', url: 'https://github.com/bruno' }],
      hasAvatar: true,
    });
    // Nenhum e-mail sai daqui, em campo nenhum: é a decisão 8 do `docs/19`, e
    // é o que permite esta funcionalidade existir.
    expect(JSON.stringify(publico)).not.toContain('@exemplo.dev');

    // O username devolvido é o **canônico**, não o que veio da URL: é com ele
    // que o site monta a chamada do avatar.
    expect((await getPublicProfile('BRUNO'))?.username).toBe('bruno');

    // Conta desativada não tem página, como skill desligada não aparece no
    // site. Reativar devolve.
    await saveProfile(doraUuid, { bio: 'Dora publica coisas.', isPublic: true });
    expect((await getPublicProfile('dora'))?.bio).toBe('Dora publica coisas.');
    await updateUser(doraUuid, { isActive: false });
    expect(await getPublicProfile('dora')).toBeNull();

    // Os três nãos são o mesmo nulo: perfil privado, conta desativada e
    // username inexistente. Distinguir seria responder "esta conta existe, mas
    // não quer ser vista", que é o que o opt-in existe para não dar.
    expect(await getPublicProfile('carla')).toBeNull();
    expect(await getPublicProfile('ninguem')).toBeNull();
    expect(await getPublicProfile('@bruno')).toBeNull();
    expect(await getPublicProfile('')).toBeNull();

    // O avatar continua servido: quem decide é o chamador, e o site só pede os
    // bytes **depois** de `getPublicProfile` — sem isso, a URL que esteve numa
    // página seguiria valendo.
    expect(await getAvatarByUsername('dora')).toBeNull(); // Dora nunca teve foto de volta
    await updateUser(doraUuid, { isActive: true });
    expect((await getPublicProfile('dora'))?.name).toBe('Dora');
  });

  it('a conferência da rota da imagem é barata: não toca em skill nem em catálogo', async () => {
    // `GET /u/:username/avatar` precisa saber se há página antes de servir os
    // bytes. Fazer essa pergunta com `getPublicProfile` arrastava as skills e
    // os catálogos públicos da pessoa — montados com `skillColumns` e as
    // subconsultas por linha — só para descartá-los: numa conta com 200 skills
    // públicas, abrir o perfil materializava 200 linhas **duas vezes**, uma
    // para a página e outra para a foto, numa rota anônima.
    //
    // A prova é estrutural, e não por cronômetro: com a tabela `skills` fora
    // do lugar, quem a lê **falha** e quem não a lê responde igual.
    await raw.query('ALTER TABLE skills RENAME TO skills_fora_do_lugar');
    try {
      expect(await isProfilePublic('bruno')).toBe(true);
      // Caixa diferente entra pela mesma normalização do resto do módulo.
      expect(await isProfilePublic('BRUNO')).toBe(true);
      await expect(getPublicProfile('bruno')).rejects.toThrow(/skills/);
    } finally {
      await raw.query('ALTER TABLE skills_fora_do_lugar RENAME TO skills');
    }

    // E ela responde **exatamente** o que a página responde, nos cinco casos:
    // é o mesmo predicado, não uma segunda cópia dele.
    const casos = ['bruno', 'carla', 'dora', 'ninguem', '@bruno', ''];
    for (const nome of casos) {
      expect([nome, await isProfilePublic(nome)]).toEqual([
        nome,
        (await getPublicProfile(nome)) !== null,
      ]);
    }

    // Desligar o perfil fecha as duas na mesma hora — é o que impede a foto de
    // sobreviver à página numa URL que já esteve publicada.
    await saveProfile(brunoUuid, { isPublic: false });
    expect(await isProfilePublic('bruno')).toBe(false);
    expect(await getPublicProfile('bruno')).toBeNull();
    await saveProfile(brunoUuid, { isPublic: true });

    // Desativar a conta também, e reativar devolve.
    await updateUser(brunoUuid, { isActive: false });
    expect(await isProfilePublic('bruno')).toBe(false);
    await updateUser(brunoUuid, { isActive: true });
    expect(await isProfilePublic('bruno')).toBe(true);
  });

  it('a página lista o que já era público, e nada mais', async () => {
    const perfil = await getPublicProfile('bruno');

    // A skill privada fica de fora; a desligada também, mesmo sendo pública; a
    // que só chega ao site por vMCP aberto entra, porque o site já a mostrava.
    expect(slugs(perfil!.skills)).toEqual(['em-vmcp-aberto', 'publica']);
    expect(slugs(perfil!.catalogs)).toEqual(['cat-publico']);

    // A mesma resposta pela função solta, que é o que a decisão 7 pede.
    const soltas = await listPublicByOwner('bruno');
    expect(slugs(soltas.skills)).toEqual(['em-vmcp-aberto', 'publica']);
    expect(slugs(soltas.catalogs)).toEqual(['cat-publico']);

    // Username torto, inexistente e de conta sem nada publicado: listas
    // vazias, nunca erro.
    expect(await listPublicByOwner('ninguem')).toEqual({ skills: [], catalogs: [] });
    expect(await listPublicByOwner('@bruno')).toEqual({ skills: [], catalogs: [] });
    expect(await listPublicByOwner('ana')).toMatchObject({ catalogs: [] });

    // As skills vêm na visibilidade do site: `access` nulo, `catalogs` vazio e
    // `mcps` só com os abertos e ligados.
    const publica = perfil!.skills.find((s) => s.slug === 'publica')!;
    expect(publica.access).toBeNull();
    expect(publica.catalogs).toEqual([]);
    expect(perfil!.skills.find((s) => s.slug === 'em-vmcp-aberto')!.mcps).toHaveLength(1);
  });

  // --------------------------------------------------- ownerHasProfile -----

  it('`ownerHasProfile` é a pergunta da página pública, feita na ficha da skill', async () => {
    const porSlug = new Map((await listSkills({ limit: 100 })).items.map((s) => [s.slug, s]));

    // Bruno tem perfil público: o `por @bruno` vira link.
    expect(porSlug.get('publica')?.ownerHasProfile).toBe(true);
    // Carla nunca abriu o perfil — não há linha, e um link levaria a 404.
    expect(porSlug.get('da-carla')?.ownerHasProfile).toBe(false);
    // Órfã: sem dono, sem crédito.
    expect(porSlug.get('orfa')?.ownerHasProfile).toBe(false);

    // Ana tem linha, mas privada: o mesmo `false` de quem não tem linha.
    await saveProfile(anaUuid, { bio: 'Administro a instalação.' });
    expect((await getSkillSummary('da-ana'))?.ownerHasProfile).toBe(false);
    await saveProfile(anaUuid, { isPublic: true });
    expect((await getSkillSummary('da-ana'))?.ownerHasProfile).toBe(true);

    // Conta desativada não tem página: o link levaria ao 404 que a desativação
    // acabou de criar. A skill dela continua no site — desativar uma conta
    // nunca despublicou o acervo dela.
    await updateUser(doraUuid, { isActive: false });
    expect((await getSkillSummary('da-dora'))?.ownerHasProfile).toBe(false);
    expect(slugs((await listSkills({ limit: 100 })).items)).toContain('da-dora');
    await updateUser(doraUuid, { isActive: true });
    expect((await getSkillSummary('da-dora'))?.ownerHasProfile).toBe(true);

    // Vale em toda visibilidade, inclusive a do painel e a do mcp-admin.
    const vistaDaAna = await listSkills({ viewer: { role: 'admin', userUuid: anaUuid }, limit: 100 });
    expect(vistaDaAna.items.find((s) => s.slug === 'publica')?.ownerHasProfile).toBe(true);
    expect(vistaDaAna.items.find((s) => s.slug === 'da-carla')?.ownerHasProfile).toBe(false);
    const todas = await listSkills({ visibility: 'all', limit: 100 });
    expect(todas.items.find((s) => s.slug === 'privada')?.ownerHasProfile).toBe(true);

    // E no catálogo público, que credita o dono do mesmo jeito.
    const naLista = (await listPublicCatalogs()).find((c) => c.slug === 'cat-publico');
    expect(naLista).toMatchObject({ ownerUsername: 'bruno', ownerHasProfile: true });
    expect((await getPublicCatalog('cat-publico'))?.ownerHasProfile).toBe(true);
    await saveProfile(brunoUuid, { isPublic: false });
    expect((await getPublicCatalog('cat-publico'))?.ownerHasProfile).toBe(false);
    await saveProfile(brunoUuid, { isPublic: true });
  });

  // -------------------------------------------------------- a limpeza ------

  it('`clearProfile` esvazia, desliga o público, apaga a foto e audita', async () => {
    await setAvatar(brunoUuid, PNG);
    const antes = await getProfile(brunoUuid);
    expect(antes).toMatchObject({ isPublic: true, hasAvatar: true });

    const limpo = await clearProfile(brunoUuid, SOURCE, ana);
    expect(limpo).toEqual({
      username: 'bruno',
      name: 'Bruno',
      bio: '',
      websiteUrl: null,
      links: [],
      isPublic: false,
      hasAvatar: false,
      avatarUpdatedAt: null,
    });
    expect(await getProfile(brunoUuid)).toEqual(limpo);
    // A foto sai junto — é o que "limpar perfil" quer dizer.
    expect(await getAvatar(brunoUuid)).toBeNull();
    expect(await linhasDoPerfil(brunoUuid)).toEqual({ perfis: 1, avatares: 0 });
    // A página pública some no mesmo ato.
    expect(await getPublicProfile('bruno')).toBeNull();

    // A conta não é tocada: o nome é campo de conta, de `updateUser`.
    expect((await getUserByUuid(brunoUuid))?.name).toBe('Bruno');

    const trilha = await listAuditPage({ action: 'user.profile' });
    expect(trilha.total).toBe(1);
    expect(trilha.items[0]).toMatchObject({
      action: 'user.profile',
      source: SOURCE,
      actorUserUuid: anaUuid,
      actorLabel: 'ana',
      targetLabel: 'bruno',
      skillUuid: null,
      skillSlug: null,
    });
  });

  it('a limpeza leva a foto de quem nunca salvou perfil, e audita o ato mesmo sem nada a limpar', async () => {
    // Carla tem foto e nenhuma linha de perfil: as duas tabelas são
    // independentes, e a limpeza precisa alcançar as duas.
    expect(await linhasDoPerfil(carlaUuid)).toEqual({ perfis: 0, avatares: 1 });
    await clearProfile(carlaUuid, SOURCE, ana);
    expect(await linhasDoPerfil(carlaUuid)).toEqual({ perfis: 0, avatares: 0 });

    // Limpar de novo não falha e audita de novo: a linha registra o ato de
    // quem administra, e "não havia nada" é leitura que a escrita concorrente
    // do dono já teria desmentido.
    await clearProfile(carlaUuid, SOURCE, ana);
    expect((await listAuditPage({ action: 'user.profile' })).total).toBe(3);
  });

  // ------------------------------------------------ o que o banco garante --

  it('os CHECKs do `034` recusam o que passa por fora das queries', async () => {
    const insereAvatar = (bytes: Buffer, mime: string) =>
      raw.query(
        `INSERT INTO user_avatars (user_uuid, bytes, mime, sha256)
         VALUES ($1, $2, $3, sha256($2))
         ON CONFLICT (user_uuid) DO UPDATE SET bytes = EXCLUDED.bytes, mime = EXCLUDED.mime,
                                               sha256 = EXCLUDED.sha256`,
        [carlaUuid, bytes, mime],
      );

    // Mime fora da lista fechada — o SVG que a decisão recusa por escrito.
    await expect(insereAvatar(SVG, 'image/svg+xml')).rejects.toThrow(/user_avatars_mime_chk/);
    await expect(insereAvatar(PNG, 'image/gif')).rejects.toThrow(/user_avatars_mime_chk/);
    // Teto de bytes e a outra ponta: arquivo vazio não é imagem.
    await expect(
      insereAvatar(Buffer.alloc(AVATAR_MAX_BYTES + 1, 7), 'image/png'),
    ).rejects.toThrow(/user_avatars_size_chk/);
    await expect(insereAvatar(Buffer.alloc(0), 'image/png')).rejects.toThrow(
      /user_avatars_size_chk/,
    );
    // Um ETag que não descreve os bytes é pior do que nenhum ETag.
    await expect(
      raw.query(
        `INSERT INTO user_avatars (user_uuid, bytes, mime, sha256) VALUES ($1, $2, 'image/png', sha256('outros'::bytea))`,
        [carlaUuid, PNG],
      ),
    ).rejects.toThrow(/user_avatars_sha256_chk/);
    // No teto exato passa.
    await insereAvatar(Buffer.concat([PNG, Buffer.alloc(AVATAR_MAX_BYTES - PNG.length)]), 'image/png');
    await raw.query('DELETE FROM user_avatars WHERE user_uuid = $1', [carlaUuid]);

    const inserePerfil = (coluna: string, valor: unknown) =>
      raw.query(
        `INSERT INTO user_profiles (user_uuid, ${coluna}) VALUES ($1, $2)
         ON CONFLICT (user_uuid) DO UPDATE SET ${coluna} = EXCLUDED.${coluna}`,
        [carlaUuid, valor],
      );
    await expect(inserePerfil('bio', 'x'.repeat(BIO_MAX_LENGTH + 1))).rejects.toThrow(
      /user_profiles_bio_len_chk/,
    );
    await expect(inserePerfil('website_url', `https://exemplo.dev/${'a'.repeat(512)}`)).rejects.toThrow(
      /user_profiles_website_len_chk/,
    );
    // JSONB que não é array, e array acima do teto.
    await expect(inserePerfil('links', '{"label":"x"}')).rejects.toThrow(/user_profiles_links_chk/);
    await expect(
      inserePerfil(
        'links',
        JSON.stringify(
          Array.from({ length: PROFILE_LINKS_MAX + 1 }, (_, i) => ({ label: `L${i}`, url: 'https://e.dev' })),
        ),
      ),
    ).rejects.toThrow(/user_profiles_links_chk/);
    await raw.query('DELETE FROM user_profiles WHERE user_uuid = $1', [carlaUuid]);

    // E a ação nova está no CHECK de `audit_log`, com as antigas.
    await expect(
      raw.query(
        `INSERT INTO audit_log (action, source, actor_label) VALUES ('user.perfil', 'web-admin', 'x')`,
      ),
    ).rejects.toThrow(/audit_log_action_check/);
    await raw.query(
      `INSERT INTO audit_log (action, source, actor_label) VALUES ('quarantine.promote', 'web-admin', 'x')`,
    );
    await raw.query(`DELETE FROM audit_log WHERE action = 'quarantine.promote'`);
  });

  it('apagar a conta leva o perfil e a foto junto, e deixa o acervo órfão', async () => {
    const uuid = (
      await createUser({ username: 'efemera', email: 'efemera@exemplo.dev', name: 'Efêmera', role: 'editor' })
    ).uuid;
    await saveProfile(uuid, { bio: 'Passei por aqui.', isPublic: true });
    await setAvatar(uuid, PNG);
    await createSkill({ name: 'Da efêmera', slug: 'da-efemera', isPublic: true, skillMd: '# e' }, SOURCE, {
      userUuid: uuid,
      label: 'efemera',
    });
    expect(await linhasDoPerfil(uuid)).toEqual({ perfis: 1, avatares: 1 });

    await raw.query('DELETE FROM users WHERE uuid = $1', [uuid]);

    // `ON DELETE CASCADE` nas duas: o perfil é *da* pessoa. O que ela publicou
    // fica, órfão, pelo `SET NULL` do `017` — e sem dono não há crédito nem
    // link.
    expect(await linhasDoPerfil(uuid)).toEqual({ perfis: 0, avatares: 0 });
    expect(await getPublicProfile('efemera')).toBeNull();
    expect(await getAvatarByUsername('efemera')).toBeNull();
    // E o perfil de quem não existe mais é 404, não o vazio: a conta é que sumiu.
    expect((await capture(getProfile(uuid))).status).toBe(404);
    const orfa = await getSkillSummary('da-efemera');
    expect(orfa).toMatchObject({ ownerUserUuid: null, ownerUsername: null, ownerHasProfile: false });

    // O username continua gasto (decisão 6 do `docs/19`): a linha do livro
    // sobrevive à conta, e é o que impede que outra pessoa assuma o `@efemera`
    // de uma trilha antiga.
    const { rows } = await raw.query('SELECT user_uuid FROM usernames WHERE username_lower = $1', [
      'efemera',
    ]);
    expect(rows).toEqual([{ user_uuid: null }]);
  });

  it('a `034` reaplicada não muda estrutura nem dado', async () => {
    const estrutura = async () =>
      (
        await raw.query(
          `SELECT c.relname, a.attname, format_type(a.atttypid, a.atttypmod) AS tipo, a.attnotnull
             FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
            WHERE c.relname IN ('user_profiles', 'user_avatars') AND a.attnum > 0 AND NOT a.attisdropped
            ORDER BY c.relname, a.attnum`,
        )
      ).rows;
    const conteudo = async () =>
      (
        await raw.query(
          `SELECT user_uuid, bio, website_url, links, is_public FROM user_profiles ORDER BY user_uuid`,
        )
      ).rows;

    const antesEstrutura = await estrutura();
    const antesConteudo = await conteudo();
    expect(antesConteudo.length).toBeGreaterThan(0);

    const arquivo = readdirSync(schemaDir()).find((f) => f.startsWith('034-'))!;
    await raw.query('BEGIN');
    await raw.query(readFileSync(join(schemaDir(), arquivo), 'utf8'));
    await raw.query('COMMIT');

    expect(await estrutura()).toEqual(antesEstrutura);
    expect(await conteudo()).toEqual(antesConteudo);
    // O CHECK reescrito continua com a lista inteira, a nova e as antigas.
    await expect(
      raw.query(`INSERT INTO audit_log (action, source, actor_label) VALUES ('nada', 'web-admin', 'x')`),
    ).rejects.toThrow(/audit_log_action_check/);
    await raw.query(
      `INSERT INTO audit_log (action, source, actor_label) VALUES ('user.profile', 'web-admin', 'reaplicacao')`,
    );
    await raw.query(`DELETE FROM audit_log WHERE actor_label = 'reaplicacao'`);
  });
});

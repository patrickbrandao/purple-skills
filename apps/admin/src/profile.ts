import {
  avatarStamp,
  badRequest,
  clearProfile,
  deleteAvatar,
  getAvatar,
  getProfile,
  getUserByUsername,
  getUserByUuid,
  notFound,
  saveProfile,
  setAvatar,
  updateUser,
} from '@purple-skills/db';
import {
  AVATAR_MAX_BYTES,
  BIO_MAX_LENGTH,
  PROFILE_LINKS_MAX,
  type UserProfile,
  normalizeBio,
  normalizeProfileLinks,
  normalizeUsername,
  normalizeWebsite,
  sniffAvatarMime,
} from '@purple-skills/shared';
import type { AuthUser } from './auth.js';

const SOURCE = 'web-admin' as const;

/**
 * O perfil (`docs/20-perfil.md`): o que a própria conta edita e o que o painel
 * mostra de outra pessoa.
 *
 * **Quem escreve é o dono, e só ele** (decisão 6). O admin tem um caminho, e um
 * só: `clear`, que esvazia os campos públicos e desliga o `is_public`. Ele
 * nunca escreve texto no perfil de outra pessoa — moderar é apagar, não
 * reescrever —, e por isso não existe aqui nenhuma função de "editar o perfil
 * de alguém".
 */

/** A sessão de bootstrap não é conta: não tem perfil para ler nem para gravar. */
function contaDe(user: AuthUser): string {
  if (!user.uuid) throw badRequest('A sessão de bootstrap não tem perfil — crie sua conta');
  return user.uuid;
}

export async function mine(user: AuthUser): Promise<UserProfile> {
  return getProfile(contaDe(user));
}

/**
 * Salva o próprio perfil.
 *
 * Campo ausente é "não mexe"; é o que deixa a tela mandar só o que mudou e o
 * que faz o botão de ligar/desligar o público não precisar reenviar a bio.
 *
 * `name` é a exceção que a decisão 1 criou: ele mora em `users`, não na tabela
 * de perfil, e **esta é a única escrita em `users` que não exige admin**. Por
 * isso ela é explícita aqui em vez de repassar o corpo: papel, estado, e-mail e
 * username continuam fora do alcance do dono, e um `updateUser(uuid, body)`
 * cru os colocaria ao alcance de quem montasse o JSON à mão.
 */
export async function save(
  user: AuthUser,
  input: {
    name?: unknown;
    bio?: unknown;
    websiteUrl?: unknown;
    links?: unknown;
    isPublic?: unknown;
  },
): Promise<UserProfile> {
  const uuid = contaDe(user);

  if (input.name !== undefined) {
    if (typeof input.name !== 'string') throw badRequest('O campo "name" deve ser uma string');
    const name = input.name.trim();
    if (!name) throw badRequest('O nome não pode ficar vazio');
    if (name.length > 120) throw badRequest('O nome é longo demais');
    await updateUser(uuid, { name });
  }

  const patch: { bio?: string; websiteUrl?: string | null; links?: never[]; isPublic?: boolean } =
    {};

  if (input.bio !== undefined) {
    const bio = normalizeBio(input.bio);
    if (bio === null) {
      throw badRequest(`A descrição precisa ser um texto de até ${BIO_MAX_LENGTH} caracteres`);
    }
    patch.bio = bio;
  }

  if (input.websiteUrl !== undefined) {
    const website = normalizeWebsite(input.websiteUrl);
    if (website === false) throw badRequest('O site precisa ser um endereço http(s)');
    patch.websiteUrl = website;
  }

  if (input.links !== undefined) {
    const links = normalizeProfileLinks(input.links);
    if (links === null) {
      throw badRequest(
        `Cada link precisa de um rótulo e de um endereço http(s), sem repetir o mesmo ` +
          `endereço, e no máximo ${PROFILE_LINKS_MAX} deles`,
      );
    }
    patch.links = links as never[];
  }

  if (input.isPublic !== undefined) {
    // O mesmo rigor do `isActive` da conta (`accounts.ts`): `"true"` ou `1`
    // virariam `false` num `=== true` e publicariam — ou despublicariam — o
    // perfil em silêncio.
    if (typeof input.isPublic !== 'boolean') {
      throw badRequest('"isPublic" precisa ser true ou false');
    }
    patch.isPublic = input.isPublic;
  }

  return saveProfile(uuid, patch);
}

/**
 * A foto enviada. O tipo sai dos **bytes**, nunca da extensão nem do
 * `Content-Type` da parte multipart — os dois são texto que quem envia escolhe
 * (`docs/20` §3.2, e `sniffAvatarMime` no `shared`).
 *
 * O teto é conferido aqui, depois de receber: o `limitRequestBytes` das rotas
 * de upload corta pelo teto **do painel** (64 MB), que é o do .zip de uma
 * skill; 512 KB de avatar é uma regra desta rota.
 */
export async function uploadAvatar(user: AuthUser, file?: Express.Multer.File): Promise<UserProfile> {
  const uuid = contaDe(user);
  if (!file) throw badRequest('Envie a imagem no campo "file"');

  if (file.buffer.length > AVATAR_MAX_BYTES) {
    throw badRequest(`A foto precisa ter até ${Math.round(AVATAR_MAX_BYTES / 1024)} KB`);
  }

  const mime = sniffAvatarMime(file.buffer);
  if (!mime) {
    // A mensagem nomeia o SVG porque é o que as pessoas tentam, e porque a
    // recusa dele não é de formato: é XML com `<script>` dentro, servido na
    // mesma origem do site.
    throw badRequest('A foto precisa ser PNG, JPEG ou WebP. SVG não é aceito.');
  }

  await setAvatar(uuid, file.buffer, mime);
  return getProfile(uuid);
}

export async function removeAvatar(user: AuthUser): Promise<UserProfile> {
  const uuid = contaDe(user);
  await deleteAvatar(uuid);
  return getProfile(uuid);
}

/**
 * Os bytes do avatar de uma conta, pelo username — para qualquer sessão logada.
 *
 * Não olha `is_public`: dentro do painel a foto é o avatar das listas e das
 * fichas, como o monograma já é, e o opt-in decide o que sai para o **anônimo**
 * (`docs/20` decisão 4, derivação). Quem serve o avatar do site é o `apps/site`,
 * com a conferência que aquela superfície exige.
 */
export async function avatarOf(
  rawUsername: string,
): Promise<{ bytes: Buffer; mime: string; sha256: Buffer }> {
  const username = normalizeUsername(rawUsername);
  if (!username) throw notFound('Conta não encontrada');

  const user = await getUserByUsername(username);
  if (!user) throw notFound('Conta não encontrada');

  const avatar = await getAvatar(user.uuid);
  if (!avatar) throw notFound('Esta conta não tem foto');
  return avatar;
}

/** O carimbo da foto, para o painel montar a URL com cache-buster sem ler a imagem. */
export async function stampOf(userUuid: string): Promise<string | null> {
  return avatarStamp(userUuid);
}

/**
 * Limpar o perfil de uma conta (decisão 6): esvazia bio, site e links, desliga
 * o `is_public` e apaga a foto. É de **admin**, e é a única forma de alguém que
 * não é o dono mexer no perfil.
 *
 * Fica na trilha (`user.profile`) porque é ato de um sobre outro — a edição do
 * próprio perfil não entra, pelo mesmo critério que mantém o login fora dela.
 */
export async function clear(actor: AuthUser, uuid: string): Promise<UserProfile> {
  const target = await getUserByUuid(uuid);
  if (!target) throw notFound('Conta não encontrada');

  await clearProfile(target.uuid, SOURCE, {
    userUuid: actor.uuid,
    label: actor.legacy ? 'bootstrap' : actor.username,
  });

  return getProfile(target.uuid);
}

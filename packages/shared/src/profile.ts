/**
 * Normalização e validação do perfil (`docs/20-perfil.md`).
 *
 * O mesmo papel que `username.ts` tem para o username e `email.ts` para o
 * e-mail: o único lugar que decide o que vale. Aqui a postura é a do
 * `username.ts` — **estrita** —, e pelo mesmo motivo: o que passa por aqui vai
 * para uma página anônima, e um campo sem teto servido ao mundo é um campo de
 * texto livre hospedado de graça.
 *
 * **Não há campo de e-mail neste arquivo, e isso é a funcionalidade.** A
 * decisão 8 do `docs/19-username.md` tirou o endereço de circulação; um
 * "e-mail de contato público" no perfil o traria de volta pela porta da frente
 * (`docs/20` §9).
 */

export const BIO_MAX_LENGTH = 500;
export const PROFILE_URL_MAX_LENGTH = 512;
export const LINK_LABEL_MAX_LENGTH = 40;
export const PROFILE_LINKS_MAX = 8;

/** Um link do perfil: o rótulo que a pessoa escreveu e para onde ele aponta. */
export type ProfileLink = { label: string; url: string };

/**
 * URL absoluta `http(s)`, sem espaço e dentro do teto.
 *
 * É gêmea de `isUrlIcon` (`icon.ts`) de propósito: o critério de "URL que um
 * `<a href>` pode receber" é um só, e duas regras diferentes para a mesma
 * pergunta divergiriam. Não a reusei por import porque os tetos são de coisas
 * diferentes — o do ícone é o da coluna de ícone.
 */
export function isProfileUrl(value: string): boolean {
  if (value.length > PROFILE_URL_MAX_LENGTH || /\s/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Teto do texto **cru**, antes de normalizar.
 *
 * Existe porque normalizar custa, e quem manda o texto escolhe o tamanho. A
 * folga de 4× sobre o teto final cobre com sobra o que a normalização encolhe
 * — CRLF virando LF, espaço à direita sumindo, escada de linhas em branco
 * colapsando —, então nenhum texto que caberia em 500 caracteres depois de
 * limpo é recusado antes.
 */
const BIO_RAW_MAX_LENGTH = BIO_MAX_LENGTH * 4;

/**
 * A bio como ela é gravada, ou `null` se não couber.
 *
 * CRLF vira LF (senão o mesmo texto tem tamanhos diferentes conforme o sistema
 * de quem digitou), espaço à direita de cada linha some, e três ou mais linhas
 * em branco viram uma — é o que impede usar a bio para empurrar o cartão da
 * página para baixo com cem quebras.
 *
 * Vazia devolve `''`, não `null`: "sem bio" e "bio vazia" são a mesma coisa, e
 * um valor só evita o `?? ''` espalhado por cada tela.
 *
 * **Duas coisas aqui são defesa contra entrada hostil, e não arrumação.**
 *
 * 1. **O cru é medido antes de qualquer `replace`.** A forma anterior
 *    normalizava e só então media, o que deixava o custo da limpeza nas mãos de
 *    quem envia.
 * 2. **O espaço à direita sai com `(?=\n|$)`, e não com `[ \t]+$` mais a flag
 *    `m`.** A segunda forma é quadrática numa corrida de espaços seguida de um
 *    não-espaço: em cada posição de início o motor casa avidamente e falha.
 *    Medido nesta máquina, com o texto `' '×n + 'x'`:
 *
 *    | n | antes | agora |
 *    |---|---|---|
 *    | 10 000 | 203 ms | < 1 ms |
 *    | 20 000 | 809 ms | < 1 ms |
 *    | 40 000 | 3 241 ms | < 1 ms |
 *    | 400 000 | **341 s** | < 2 ms |
 *
 *    Quatro vezes o tempo a cada duplicação da entrada. Como o corpo do
 *    `PATCH /api/me/profile` chega pelo `express.json` de 32 MB do painel — o
 *    `smallJson` de 4 KB daquela rota não valia, ver `apps/admin/src/api.ts` —,
 *    qualquer conta `membro` podia parar o processo por horas com uma
 *    requisição. As duas correções são independentes; esta é a que vale mesmo
 *    que o corpo chegue grande.
 */
export function normalizeBio(raw: unknown): string | null {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') return null;
  if (raw.length > BIO_RAW_MAX_LENGTH) return null;

  const bio = raw
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+(?=\n|$)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return bio.length > BIO_MAX_LENGTH ? null : bio;
}

/**
 * O site pessoal: `null` quando vazio (a página decide se desenha a linha) e
 * `false` quando não vale — quem chama escolhe a mensagem, como
 * `normalizeSkillIcon` faz.
 */
export function normalizeWebsite(raw: unknown): string | null | false {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') return false;

  const url = raw.trim();
  if (url === '') return null;

  return isProfileUrl(url) ? url : false;
}

/**
 * A lista de links, ou `null` quando alguma entrada não vale.
 *
 * Recusa **URL repetida** (sem diferenciar caixa no esquema e no host): duas
 * linhas idênticas no cartão são erro de digitação, não intenção, e deixá-las
 * passar significa que a página mostra o mesmo botão duas vezes. O rótulo
 * pode repetir — dois "GitHub" para repositórios diferentes são legítimos.
 */
export function normalizeProfileLinks(raw: unknown): ProfileLink[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > PROFILE_LINKS_MAX) return null;

  const links: ProfileLink[] = [];
  const vistas = new Set<string>();

  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return null;
    const { label, url } = entry as { label?: unknown; url?: unknown };
    if (typeof label !== 'string' || typeof url !== 'string') return null;

    const rotulo = label.trim();
    const endereco = url.trim();
    if (!rotulo || rotulo.length > LINK_LABEL_MAX_LENGTH) return null;
    if (!isProfileUrl(endereco)) return null;

    const chave = endereco.toLowerCase();
    if (vistas.has(chave)) return null;
    vistas.add(chave);

    links.push({ label: rotulo, url: endereco });
  }

  return links;
}

// ------------------------------------------------------------------ foto ---

/**
 * Os formatos que o avatar aceita.
 *
 * **SVG está fora, e não por descuido:** ele é XML com `<script>` dentro.
 * Servido na mesma origem do site, um SVG de avatar é execução de código de
 * terceiro na página — nenhum teto de tamanho resolve isso (`docs/20` §3.2).
 */
export const AVATAR_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

export type AvatarMime = (typeof AVATAR_MIME_TYPES)[number];

/** 512 KB. Conferido depois de receber os bytes, não pelo `Content-Length`. */
export const AVATAR_MAX_BYTES = 512 * 1024;

/**
 * O tipo da imagem **pelos bytes iniciais**, ou `null`.
 *
 * Nem a extensão do arquivo nem o `Content-Type` da parte multipart são
 * consultados: os dois são texto que quem envia escolhe, e aceitar qualquer um
 * deles é deixar o remetente declarar que o seu SVG é um PNG.
 *
 * As assinaturas:
 *
 * - **PNG** — `89 50 4E 47 0D 0A 1A 0A`, os 8 bytes do cabeçalho.
 * - **JPEG** — `FF D8 FF`: SOI mais o primeiro marcador.
 * - **WebP** — contêiner RIFF: `RIFF` nos bytes 0–3 e `WEBP` nos 8–11. Os
 *   quatro do meio são o tamanho, e por isso não entram na conferência.
 */
export function sniffAvatarMime(bytes: Uint8Array): AvatarMime | null {
  const comeca = (assinatura: readonly number[], offset = 0): boolean =>
    bytes.length >= offset + assinatura.length &&
    assinatura.every((byte, i) => bytes[offset + i] === byte);

  if (comeca([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (comeca([0xff, 0xd8, 0xff])) return 'image/jpeg';
  // 'RIFF' … 'WEBP'
  if (comeca([0x52, 0x49, 0x46, 0x46]) && comeca([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';

  return null;
}

/**
 * Os cabeçalhos com que o avatar é servido — iguais no painel e no site, e por
 * isso aqui e não duplicados nos dois.
 *
 * - `nosniff` e a CSP acompanham o que o site já faz com arquivo de skill: o
 *   tipo sai da lista fechada de `AVATAR_MIME_TYPES`, então não há caminho para
 *   `text/html`, mas a defesa em profundidade custa dois cabeçalhos.
 * - **`max-age=0, must-revalidate` é a decisão que importa.** Um cache longo
 *   deixaria a foto visível depois de o perfil virar privado ou de a conta ser
 *   desativada. Com o ETag do `sha256`, a revalidação é um 304 de alguns bytes,
 *   e trocar a foto invalida sozinha — o ETag muda com o conteúdo.
 * - `private` porque a revalidação já dá o ganho: deixar um cache compartilhado
 *   guardar a imagem só adiantaria o instante em que ela sobrevive à revogação.
 */
export function avatarHeaders(mime: string, sha256Hex: string): Record<string, string> {
  return {
    'Content-Type': mime,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cache-Control': 'private, max-age=0, must-revalidate',
    ETag: `"${sha256Hex}"`,
  };
}

// ----------------------------------------------------------------- redes ---

/**
 * A rede que um link representa, pelo host — só para o ícone.
 *
 * Nunca para validar: a lista é livre (`docs/20` decisão 5), e um host que não
 * está aqui entra com o ícone genérico, não com uma recusa. Acrescentar uma
 * rede é acrescentar uma linha, e não mexer em regra nenhuma.
 *
 * O casamento é por **sufixo de host**, com o ponto à frente, para `gist.github.com`
 * casar e `github.com.phishing.example` não.
 */
const REDES: readonly { readonly id: string; readonly hosts: readonly string[] }[] = [
  { id: 'github', hosts: ['github.com', 'gist.github.com'] },
  { id: 'gitlab', hosts: ['gitlab.com'] },
  { id: 'linkedin', hosts: ['linkedin.com'] },
  { id: 'x', hosts: ['x.com', 'twitter.com'] },
  { id: 'mastodon', hosts: ['mastodon.social', 'mastodon.online'] },
  { id: 'bluesky', hosts: ['bsky.app'] },
  { id: 'youtube', hosts: ['youtube.com', 'youtu.be'] },
  { id: 'instagram', hosts: ['instagram.com'] },
];

/** O id da rede conhecida, ou `null` — e `null` é um resultado normal. */
export function socialNetworkOf(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }

  for (const rede of REDES) {
    if (rede.hosts.some((conhecido) => host === conhecido || host.endsWith(`.${conhecido}`))) {
      return rede.id;
    }
  }
  return null;
}

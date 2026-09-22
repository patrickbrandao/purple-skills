import { describe, expect, it } from 'vitest';
import {
  AVATAR_MAX_BYTES,
  BIO_MAX_LENGTH,
  PROFILE_LINKS_MAX,
  isProfileUrl,
  normalizeBio,
  normalizeProfileLinks,
  normalizeWebsite,
  sniffAvatarMime,
  socialNetworkOf,
} from './profile.js';

describe('bio', () => {
  it('normaliza antes de medir', () => {
    expect(normalizeBio('  Mantenho as skills de git.  ')).toBe('Mantenho as skills de git.');
    // CRLF vira LF: o mesmo texto não pode ter tamanhos diferentes conforme o
    // sistema de quem digitou.
    expect(normalizeBio('uma\r\noutra')).toBe('uma\noutra');
    expect(normalizeBio('uma   \noutra\t\n')).toBe('uma\noutra');
  });

  it('colapsa a escada de linhas em branco', () => {
    // Sem isto, cem quebras empurram o cartão da página para baixo.
    expect(normalizeBio('topo\n\n\n\n\n\nfundo')).toBe('topo\n\nfundo');
  });

  it('ausente e vazia são a mesma coisa: string vazia', () => {
    expect(normalizeBio(undefined)).toBe('');
    expect(normalizeBio(null)).toBe('');
    expect(normalizeBio('   ')).toBe('');
  });

  it('recusa o que passa do teto e o que não é texto', () => {
    expect(normalizeBio('a'.repeat(BIO_MAX_LENGTH))).toHaveLength(BIO_MAX_LENGTH);
    expect(normalizeBio('a'.repeat(BIO_MAX_LENGTH + 1))).toBeNull();
    expect(normalizeBio(42)).toBeNull();
    expect(normalizeBio({})).toBeNull();
  });

  it('mede depois de aparar, não antes', () => {
    // Espaço em volta não pode gastar a cota de quem escreveu no limite.
    expect(normalizeBio(`  ${'a'.repeat(BIO_MAX_LENGTH)}  `)).toHaveLength(BIO_MAX_LENGTH);
  });

  /**
   * A forma anterior media **depois** de normalizar, e o `[ \t]+$` com a flag
   * `m` é quadrático numa corrida de espaços: 3,2 s com 40 mil, 341 s com 400
   * mil. Como o corpo do `PATCH /api/me/profile` chega pelo parser de 32 MB,
   * qualquer conta `membro` parava o processo com uma requisição.
   */
  it('não fica quadrática com uma corrida de espaços', () => {
    const hostil = `${' '.repeat(200_000)}x`;
    const inicio = performance.now();
    // Recusada pelo teto do cru, antes de qualquer `replace` — e, mesmo que
    // passasse, o `(?=\n|$)` não backtracka.
    expect(normalizeBio(hostil)).toBeNull();
    expect(performance.now() - inicio).toBeLessThan(50);
  });

  it('o teto do cru tem folga para o que a normalização encolhe', () => {
    // CRLF é o pior caso de encolhimento: 500 linhas vazias em CRLF ocupam
    // 1 000 caracteres crus e viram 500 — e depois colapsam. Tem de passar.
    expect(normalizeBio('\r\n'.repeat(500))).toBe('');
    // Um texto no teto final, com espaço à direita em cada linha, também.
    const comLixo = Array.from({ length: 50 }, () => `${'a'.repeat(9)}   `).join('\n');
    expect(normalizeBio(comLixo)).toHaveLength(50 * 9 + 49);
  });
});

describe('site pessoal', () => {
  it('aceita http e https absolutos', () => {
    expect(normalizeWebsite(' https://exemplo.dev/sobre ')).toBe('https://exemplo.dev/sobre');
    expect(normalizeWebsite('http://exemplo.dev')).toBe('http://exemplo.dev');
  });

  it('vazio é null, e null é "sem site"', () => {
    expect(normalizeWebsite('')).toBeNull();
    expect(normalizeWebsite('   ')).toBeNull();
    expect(normalizeWebsite(undefined)).toBeNull();
  });

  it('recusa o que não é URL http(s)', () => {
    // `javascript:` é o caso que importa: o valor vai para um `href`.
    expect(normalizeWebsite('javascript:alert(1)')).toBe(false);
    expect(normalizeWebsite('exemplo.dev')).toBe(false);
    expect(normalizeWebsite('ftp://exemplo.dev')).toBe(false);
    expect(normalizeWebsite('file:///etc/passwd')).toBe(false);
    expect(normalizeWebsite('https://exemplo.dev/com espaço')).toBe(false);
    expect(normalizeWebsite(42)).toBe(false);
    expect(isProfileUrl(`https://exemplo.dev/${'a'.repeat(600)}`)).toBe(false);
  });
});

describe('links', () => {
  const link = (label: string, url: string) => ({ label, url });

  it('apara rótulo e URL, e mantém a ordem', () => {
    expect(normalizeProfileLinks([link('  GitHub ', ' https://github.com/ana ')])).toEqual([
      link('GitHub', 'https://github.com/ana'),
    ]);
  });

  it('ausente é lista vazia', () => {
    expect(normalizeProfileLinks(undefined)).toEqual([]);
    expect(normalizeProfileLinks([])).toEqual([]);
  });

  it('recusa URL repetida, e não rótulo repetido', () => {
    // Duas linhas idênticas no cartão são erro de digitação.
    expect(
      normalizeProfileLinks([
        link('GitHub', 'https://github.com/ana'),
        link('Outro', 'HTTPS://GitHub.com/ana'),
      ]),
    ).toBeNull();
    // Dois "GitHub" para repositórios diferentes são legítimos.
    expect(
      normalizeProfileLinks([
        link('GitHub', 'https://github.com/ana'),
        link('GitHub', 'https://github.com/ana/skills'),
      ]),
    ).toHaveLength(2);
  });

  it('recusa entrada torta e lista longa demais', () => {
    expect(normalizeProfileLinks([link('', 'https://exemplo.dev')])).toBeNull();
    expect(normalizeProfileLinks([link('a'.repeat(41), 'https://exemplo.dev')])).toBeNull();
    expect(normalizeProfileLinks([link('Site', 'javascript:alert(1)')])).toBeNull();
    expect(normalizeProfileLinks(['https://exemplo.dev'])).toBeNull();
    expect(normalizeProfileLinks([{ url: 'https://exemplo.dev' }])).toBeNull();
    expect(normalizeProfileLinks('https://exemplo.dev')).toBeNull();

    const muitos = Array.from({ length: PROFILE_LINKS_MAX + 1 }, (_, i) =>
      link(`L${i}`, `https://exemplo.dev/${i}`),
    );
    expect(normalizeProfileLinks(muitos)).toBeNull();
    expect(normalizeProfileLinks(muitos.slice(0, PROFILE_LINKS_MAX))).toHaveLength(
      PROFILE_LINKS_MAX,
    );
  });
});

describe('tipo da imagem pelos bytes', () => {
  const comBytes = (...bytes: number[]) => new Uint8Array(bytes);

  it('reconhece PNG, JPEG e WebP pelo cabeçalho', () => {
    expect(sniffAvatarMime(comBytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00))).toBe(
      'image/png',
    );
    expect(sniffAvatarMime(comBytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg');
    // RIFF … WEBP, com os quatro bytes de tamanho no meio ignorados.
    expect(
      sniffAvatarMime(
        comBytes(0x52, 0x49, 0x46, 0x46, 0x2a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50),
      ),
    ).toBe('image/webp');
  });

  it('recusa SVG, mesmo que o cliente jure que é PNG', () => {
    // O ponto inteiro da conferência por bytes: a extensão e o `Content-Type`
    // são texto que quem envia escolhe.
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
    expect(sniffAvatarMime(svg)).toBeNull();
  });

  it('recusa RIFF que não é WebP, e arquivo curto demais', () => {
    // Um .wav também começa com RIFF.
    expect(
      sniffAvatarMime(
        comBytes(0x52, 0x49, 0x46, 0x46, 0x2a, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45),
      ),
    ).toBeNull();
    expect(sniffAvatarMime(comBytes(0x89, 0x50))).toBeNull();
    expect(sniffAvatarMime(comBytes())).toBeNull();
    expect(sniffAvatarMime(comBytes(0x52, 0x49, 0x46, 0x46))).toBeNull();
  });

  it('o teto é meio megabyte', () => {
    expect(AVATAR_MAX_BYTES).toBe(524_288);
  });
});

describe('rede social pelo host', () => {
  it('reconhece as conhecidas, com e sem www', () => {
    expect(socialNetworkOf('https://github.com/ana')).toBe('github');
    expect(socialNetworkOf('https://www.linkedin.com/in/ana')).toBe('linkedin');
    expect(socialNetworkOf('https://twitter.com/ana')).toBe('x');
    expect(socialNetworkOf('https://gist.github.com/ana')).toBe('github');
  });

  it('não casa host que apenas termina parecido', () => {
    // `github.com.phishing.example` não é o GitHub.
    expect(socialNetworkOf('https://github.com.phishing.example/ana')).toBeNull();
    expect(socialNetworkOf('https://naogithub.com/ana')).toBeNull();
  });

  it('desconhecido e torto devolvem null, que é resultado normal', () => {
    expect(socialNetworkOf('https://exemplo.dev/ana')).toBeNull();
    expect(socialNetworkOf('nao-e-url')).toBeNull();
  });
});

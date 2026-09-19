import { describe, expect, it } from 'vitest';
import { isBrandIconUrl, isValidSkillIcon, normalizeSkillIcon } from './icon.js';

describe('isValidSkillIcon', () => {
  it.each(['🐘', '🚀', '👩‍💻', '🇧🇷', '1️⃣', '☁️', '🏳️‍🌈', '👍🏽'])('aceita o emoji %s', (icon) => {
    expect(isValidSkillIcon(icon)).toBe(true);
  });

  it.each(['https://exemplo.com/logo.png', 'http://intranet/icone.svg'])('aceita a URL %s', (icon) => {
    expect(isValidSkillIcon(icon)).toBe(true);
  });

  it.each([
    ['dois emojis', '🐘🚀'],
    ['letra', 'A'],
    ['palavra', 'postgres'],
    ['esquema errado', 'ftp://x/y.png'],
    ['caminho relativo', '/assets/x.png'],
    ['URL com espaço', 'https://exemplo.com/a b.png'],
    ['javascript:', 'javascript:alert(1)'],
    ['URL longa demais', `https://x.io/${'a'.repeat(600)}`],
    // Duzentos emojis unidos por ZWJ: casam no regex e têm 599 caracteres, mais
    // que o `skills_icon_length_chk` do banco aceita.
    ['cadeia ZWJ longa demais', Array(200).fill('😀').join('\u200d')],
  ])('recusa %s', (_rotulo, icon) => {
    expect(isValidSkillIcon(icon)).toBe(false);
  });
});

describe('normalizeSkillIcon', () => {
  it('undefined não mexe; vazio e null apagam', () => {
    expect(normalizeSkillIcon(undefined)).toBeUndefined();
    expect(normalizeSkillIcon(null)).toBeNull();
    expect(normalizeSkillIcon('')).toBeNull();
    expect(normalizeSkillIcon('   ')).toBeNull();
  });

  it('apara e devolve o ícone válido; inválido vira false', () => {
    expect(normalizeSkillIcon(' 🐘 ')).toBe('🐘');
    expect(normalizeSkillIcon('abc')).toBe(false);
    expect(normalizeSkillIcon(42)).toBe(false);
  });
});

describe('isBrandIconUrl', () => {
  it.each(['/assets/images/purple-hat-256.png', '/logo.svg', 'https://cdn.exemplo.com/marca.png', 'http://intranet/icone.svg'])(
    'aceita %s',
    (value) => {
      expect(isBrandIconUrl(value)).toBe(true);
    },
  );

  it.each([
    ['caminho relativo', 'assets/logo.png'],
    ['protocolo relativo', '//cdn.exemplo.com/logo.png'],
    ['javascript:', 'javascript:alert(1)'],
    ['data:', 'data:image/png;base64,AAAA'],
    ['espaço', '/assets/meu logo.png'],
    ['barra invertida', '/\\evil.example/logo.png'],
    ['longo demais', `/${'a'.repeat(600)}.png`],
  ])('recusa %s', (_label, value) => {
    expect(isBrandIconUrl(value)).toBe(false);
  });
});

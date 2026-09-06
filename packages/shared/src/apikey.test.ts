import { describe, expect, it } from 'vitest';
import {
  API_KEY_PREFIX_LENGTH,
  generateApiKey,
  looksLikeApiKey,
  maskApiKey,
  parseApiKey,
  verifyApiKeySecret,
} from './apikey.js';

describe('chaves de API', () => {
  it('gera token no formato psk_<prefixo>_<segredo>', () => {
    const key = generateApiKey();
    const parsed = parseApiKey(key.token);

    expect(parsed).not.toBeNull();
    expect(parsed?.prefix).toBe(key.prefix);
    expect(key.prefix).toHaveLength(API_KEY_PREFIX_LENGTH);
    expect(key.token.startsWith(`psk_${key.prefix}_`)).toBe(true);
  });

  it('o hash guardado confere o segredo e não contém o token', () => {
    const key = generateApiKey();
    const parsed = parseApiKey(key.token)!;

    expect(verifyApiKeySecret(parsed.secret, key.keyHash)).toBe(true);
    expect(verifyApiKeySecret('segredo-errado', key.keyHash)).toBe(false);
    expect(key.keyHash).not.toContain(parsed.secret);
  });

  it('duas chaves não colidem em prefixo nem em segredo', () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.prefix).not.toBe(b.prefix);
    expect(a.token).not.toBe(b.token);
    // O segredo de uma não abre a outra.
    expect(verifyApiKeySecret(parseApiKey(a.token)!.secret, b.keyHash)).toBe(false);
  });

  it('recusa formatos que não são chave', () => {
    expect(parseApiKey(undefined)).toBeNull();
    expect(parseApiKey('')).toBeNull();
    expect(parseApiKey('psk_curto_x')).toBeNull();
    expect(parseApiKey('xyz_abcdefgh_segredo-bem-longo-aqui')).toBeNull();
    expect(parseApiKey('psk_abcdefgh')).toBeNull();
    expect(parseApiKey('psk_abcd efg_segredo-bem-longo-aqui')).toBeNull();
    expect(looksLikeApiKey('um-token-administrativo-comum')).toBe(false);
  });

  it('aceita underscore no segredo — base64url produz um a cada 64 caracteres', () => {
    const parsed = parseApiKey('psk_abcdefgh_seg_re_do-bem-longo-aqui');
    expect(parsed).toEqual({ prefix: 'abcdefgh', secret: 'seg_re_do-bem-longo-aqui' });
  });

  it('mascara mostrando só o prefixo', () => {
    const key = generateApiKey();
    expect(maskApiKey(key.prefix)).toBe(`psk_${key.prefix}_…`);
  });
});

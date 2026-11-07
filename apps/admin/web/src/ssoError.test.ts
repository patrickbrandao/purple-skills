import { describe, expect, it } from 'vitest';
import { SSO_ERROR_GENERICO, erroDoSso } from './ssoError.js';

/**
 * Relatório 019 da auditoria de 2026-11-07: a tela de login exibia o texto do
 * `?sso_error=` como erro oficial. O texto agora vem só do cookie que o
 * servidor grava; a URL não decide o que aparece.
 */
describe('erroDoSso', () => {
  it('sem o cookie, o texto genérico — o que vier na URL não importa', () => {
    expect(erroDoSso('')).toBe(SSO_ERROR_GENERICO);
    expect(erroDoSso('ps_admin=abc; outro=1')).toBe(SSO_ERROR_GENERICO);
  });

  it('com o cookie, o motivo que o servidor gravou', () => {
    const motivo = 'Este e-mail não está em um domínio autorizado para entrar por SSO neste catálogo';
    expect(erroDoSso(`ps_admin=abc; ps_sso_error=${encodeURIComponent(motivo)}`)).toBe(motivo);
  });

  it('valor malformado ou enorme cai no genérico', () => {
    expect(erroDoSso('ps_sso_error=%E0%A4%A')).toBe(SSO_ERROR_GENERICO);
    expect(erroDoSso(`ps_sso_error=${'x'.repeat(501)}`)).toBe(SSO_ERROR_GENERICO);
    expect(erroDoSso('ps_sso_error=')).toBe(SSO_ERROR_GENERICO);
  });

  it('casa o nome inteiro, não um sufixo', () => {
    expect(erroDoSso('xps_sso_error=forjado')).toBe(SSO_ERROR_GENERICO);
  });
});

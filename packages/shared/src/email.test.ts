import { describe, expect, it } from 'vitest';
import { emailDomain, emailInDomains, normalizeEmail, parseDomainList } from './email.js';

describe('normalização de e-mail', () => {
  it('apara e baixa a caixa', () => {
    expect(normalizeEmail('  Maria@Exemplo.COM ')).toBe('maria@exemplo.com');
  });

  it('recusa o que não tem cara de endereço', () => {
    expect(normalizeEmail('sem-arroba')).toBeNull();
    expect(normalizeEmail('a@b')).toBeNull();
    expect(normalizeEmail('a@@b.com')).toBeNull();
    expect(normalizeEmail('com espaço@exemplo.com')).toBeNull();
    expect(normalizeEmail(42)).toBeNull();
    expect(normalizeEmail(`${'a'.repeat(250)}@exemplo.com`)).toBeNull();
  });

  it('extrai o domínio', () => {
    expect(emailDomain('Maria@Sub.Exemplo.com')).toBe('sub.exemplo.com');
    expect(emailDomain('invalido')).toBeNull();
  });
});

describe('allowlist de domínio', () => {
  const allowed = parseDomainList('exemplo.com, @outra.org');

  it('aceita o domínio e seus subdomínios', () => {
    expect(emailInDomains('maria@exemplo.com', allowed)).toBe(true);
    expect(emailInDomains('joao@eng.exemplo.com', allowed)).toBe(true);
    expect(emailInDomains('ana@outra.org', allowed)).toBe(true);
  });

  it('recusa domínio de fora e o truque do sufixo', () => {
    expect(emailInDomains('atacante@gmail.com', allowed)).toBe(false);
    expect(emailInDomains('atacante@naoexemplo.com', allowed)).toBe(false);
    expect(emailInDomains('atacante@exemplo.com.br', allowed)).toBe(false);
  });

  it('lista vazia recusa tudo — falha fechado', () => {
    expect(emailInDomains('maria@exemplo.com', [])).toBe(false);
    expect(parseDomainList('')).toEqual([]);
    expect(parseDomainList(undefined)).toEqual([]);
  });
});

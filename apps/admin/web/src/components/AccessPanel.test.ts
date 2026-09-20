import { describe, expect, it } from 'vitest';
import { isInactiveGrant, ownedBy } from './AccessPanel.js';

/**
 * O uuid de uma conta não sai mais do servidor: `ownerUserUuid` chega como
 * apelido do e-mail (relatório 011 da auditoria de 2026-09-19). Comparado com
 * `user.uuid`, como era, o "você" da guia Acesso sumiria para todo dono.
 */
describe('ownedBy: o dono se reconhece pelo e-mail', () => {
  const ana = { uuid: '3f2b8c4e-1a6d-4b7f-9c0e-8d5a2f1b6c37', email: 'ana@exemplo.dev' };

  it('a sessão dona do objeto é "você", qualquer que seja a caixa do e-mail', () => {
    expect(ownedBy({ ownerEmail: 'ana@exemplo.dev' }, ana)).toBe(true);
    expect(ownedBy({ ownerEmail: 'Ana@Exemplo.dev' }, ana)).toBe(true);
  });

  it('dono alheio e objeto sem dono não são', () => {
    expect(ownedBy({ ownerEmail: 'bia@exemplo.dev' }, ana)).toBe(false);
    expect(ownedBy({ ownerEmail: null }, ana)).toBe(false);
  });

  // A sessão de bootstrap não é conta: `uuid` nulo e e-mail vazio. Sem a guarda,
  // um dono de e-mail vazio — que o banco não produz, mas um mock sim — casaria.
  it('a sessão de bootstrap não é dona de nada', () => {
    expect(ownedBy({ ownerEmail: '' }, { uuid: null, email: '' })).toBe(false);
    expect(ownedBy({ ownerEmail: null }, { uuid: null, email: '' })).toBe(false);
  });
});

/**
 * A concessão de conta desativada fica na lista, inerte, e volta a valer se a
 * conta for reativada: a guia a marca (relatório 039 da mesma auditoria).
 */
describe('isInactiveGrant', () => {
  it('só a concessão gravada de conta desativada', () => {
    expect(isInactiveGrant({ saved: { isActive: false } })).toBe(true);
    expect(isInactiveGrant({ saved: { isActive: true } })).toBe(false);
    // Concessão nova, ainda no rascunho: a busca só oferece conta ativa.
    expect(isInactiveGrant({ saved: null })).toBe(false);
  });
});

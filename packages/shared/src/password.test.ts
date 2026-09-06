import { describe, expect, it } from 'vitest';
import {
  KEY_COST,
  MIN_PASSWORD_LENGTH,
  generatePassword,
  hashPassword,
  hashSecret,
  passwordProblem,
  verifyPassword,
  verifySecret,
} from './password.js';

// Custo baixo: os testes conferem o formato e a lógica, não a dureza do scrypt.
const CHEAP = { N: 2 ** 10, r: 8, p: 1 };

describe('hash de senha', () => {
  it('confere a senha correta e recusa a errada', () => {
    const stored = hashSecret('senha-correta-do-painel', CHEAP);
    expect(verifySecret('senha-correta-do-painel', stored)).toBe(true);
    expect(verifySecret('senha-errada-do-painel', stored)).toBe(false);
  });

  it('gera salt novo a cada chamada', () => {
    const a = hashSecret('mesma-senha', CHEAP);
    const b = hashSecret('mesma-senha', CHEAP);
    expect(a).not.toBe(b);
    expect(verifySecret('mesma-senha', a)).toBe(true);
    expect(verifySecret('mesma-senha', b)).toBe(true);
  });

  it('guarda os parâmetros no próprio hash', () => {
    const stored = hashSecret('outra-senha', KEY_COST);
    expect(stored.startsWith(`scrypt$${KEY_COST.N}$${KEY_COST.r}$${KEY_COST.p}$`)).toBe(true);
    // Um hash escrito com custo antigo continua conferindo depois da troca.
    expect(verifySecret('outra-senha', stored)).toBe(true);
  });

  it('recusa hash ausente ou malformado sem lançar', () => {
    expect(verifySecret('x', null)).toBe(false);
    expect(verifySecret('x', undefined)).toBe(false);
    expect(verifySecret('x', '')).toBe(false);
    expect(verifySecret('x', 'nao-e-um-hash')).toBe(false);
    expect(verifySecret('x', 'scrypt$0$8$1$c2FsdA$aGFzaA')).toBe(false);
    expect(verifySecret('x', 'argon2$1$2$3$4$5')).toBe(false);
  });

  it('hashPassword usa o custo de senha e continua conferindo', () => {
    const stored = hashPassword('senha-de-pessoa-longa');
    expect(verifyPassword('senha-de-pessoa-longa', stored)).toBe(true);
    expect(verifyPassword('senha-de-pessoa-long', stored)).toBe(false);
  });
});

describe('regra mínima de senha', () => {
  it('recusa vazio, curta e não-string', () => {
    expect(passwordProblem('')).toBeTruthy();
    expect(passwordProblem(undefined)).toBeTruthy();
    expect(passwordProblem(123)).toBeTruthy();
    expect(passwordProblem('a'.repeat(MIN_PASSWORD_LENGTH - 1))).toBeTruthy();
  });

  it('aceita a partir do comprimento mínimo', () => {
    expect(passwordProblem('a'.repeat(MIN_PASSWORD_LENGTH))).toBeNull();
  });

  it('recusa senha absurdamente longa', () => {
    expect(passwordProblem('a'.repeat(513))).toBeTruthy();
  });
});

describe('senha temporária', () => {
  it('sai em grupos e não se repete', () => {
    const a = generatePassword();
    expect(a.split('-')).toHaveLength(4);
    expect(passwordProblem(a)).toBeNull();
    expect(a).not.toBe(generatePassword());
  });
});

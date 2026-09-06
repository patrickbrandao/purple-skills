import { describe, expect, it } from 'vitest';
import { canDelete, canManageUsers, canWrite, isRole, roleAtLeast } from './roles.js';

describe('papéis', () => {
  it('reconhece só os três papéis', () => {
    expect(isRole('admin')).toBe(true);
    expect(isRole('editor')).toBe(true);
    expect(isRole('leitor')).toBe(true);
    expect(isRole('root')).toBe(false);
    expect(isRole(undefined)).toBe(false);
  });

  it('a matriz da §2.1 vale para os três', () => {
    expect([canWrite('admin'), canDelete('admin'), canManageUsers('admin')]).toEqual([
      true,
      true,
      true,
    ]);
    expect([canWrite('editor'), canDelete('editor'), canManageUsers('editor')]).toEqual([
      true,
      false,
      false,
    ]);
    expect([canWrite('leitor'), canDelete('leitor'), canManageUsers('leitor')]).toEqual([
      false,
      false,
      false,
    ]);
  });

  it('ordena por poder', () => {
    expect(roleAtLeast('admin', 'editor')).toBe(true);
    expect(roleAtLeast('editor', 'editor')).toBe(true);
    expect(roleAtLeast('leitor', 'editor')).toBe(false);
  });
});

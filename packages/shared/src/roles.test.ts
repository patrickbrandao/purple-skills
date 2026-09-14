import { describe, expect, it } from 'vitest';
import {
  accessLevel,
  canCreate,
  canEdit,
  canManage,
  canManageUsers,
  canOwn,
  canView,
  isAccessLevel,
  isRole,
  roleAtLeast,
} from './roles.js';

describe('papéis', () => {
  it('reconhece só os três papéis', () => {
    expect(isRole('admin')).toBe(true);
    expect(isRole('editor')).toBe(true);
    expect(isRole('membro')).toBe(true);
    expect(isRole('leitor')).toBe(false);
    expect(isRole('root')).toBe(false);
    expect(isRole(undefined)).toBe(false);
  });

  it('a matriz da §3.3 do doc 12 vale para os três', () => {
    expect([canCreate('admin'), canManageUsers('admin')]).toEqual([true, true]);
    expect([canCreate('editor'), canManageUsers('editor')]).toEqual([true, false]);
    expect([canCreate('membro'), canManageUsers('membro')]).toEqual([false, false]);
  });

  it('ordena por poder', () => {
    expect(roleAtLeast('admin', 'editor')).toBe(true);
    expect(roleAtLeast('editor', 'editor')).toBe(true);
    expect(roleAtLeast('membro', 'editor')).toBe(false);
  });
});

describe('acesso por objeto', () => {
  const dono = 'u-dono';
  const outro = 'u-outro';

  it('admin é dono de tudo, inclusive sem conta', () => {
    expect(accessLevel('admin', dono, null, outro)).toBe('owner');
    expect(accessLevel('admin', null, null, null)).toBe('owner');
  });

  it('o dono tem tudo; sem concessão, o resto não vê', () => {
    expect(accessLevel('membro', dono, null, dono)).toBe('owner');
    expect(accessLevel('editor', dono, null, outro)).toBeNull();
    expect(accessLevel('editor', null, null, null)).toBeNull();
  });

  it('a concessão dá o nível dela', () => {
    expect(accessLevel('membro', dono, 'view', outro)).toBe('view');
    expect(accessLevel('membro', dono, 'edit', outro)).toBe('edit');
    expect(accessLevel('membro', dono, 'manage', outro)).toBe('manage');
  });

  it('os níveis são cumulativos e nenhum chega a dono', () => {
    expect([canView('view'), canEdit('view'), canManage('view'), canOwn('view')]).toEqual([
      true,
      false,
      false,
      false,
    ]);
    expect([canView('edit'), canEdit('edit'), canManage('edit'), canOwn('edit')]).toEqual([
      true,
      true,
      false,
      false,
    ]);
    expect([canView('manage'), canEdit('manage'), canManage('manage'), canOwn('manage')]).toEqual(
      [true, true, true, false],
    );
    expect([canView('owner'), canOwn('owner')]).toEqual([true, true]);
    expect([canView(null), canEdit(null), canManage(null), canOwn(null)]).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  it('reconhece só os três níveis', () => {
    expect(isAccessLevel('manage')).toBe(true);
    expect(isAccessLevel('owner')).toBe(false);
  });
});

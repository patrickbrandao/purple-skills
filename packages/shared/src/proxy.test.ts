import { describe, expect, it } from 'vitest';
import { trustProxySetting } from './proxy.js';

describe('trustProxySetting', () => {
  it('não confia na Internet por padrão', () => {
    expect(trustProxySetting(undefined)).toBe('loopback, uniquelocal');
    expect(trustProxySetting('')).toBe('loopback, uniquelocal');
    expect(trustProxySetting('   ')).toBe('loopback, uniquelocal');
  });

  it('aceita um número de saltos', () => {
    expect(trustProxySetting('1')).toBe(1);
    expect(trustProxySetting('0')).toBe(0);
  });

  it('aceita booleanos explícitos', () => {
    expect(trustProxySetting('true')).toBe(true);
    expect(trustProxySetting('false')).toBe(false);
  });

  it('repassa CIDRs e listas para o Express', () => {
    expect(trustProxySetting('10.1.0.0/16')).toBe('10.1.0.0/16');
    expect(trustProxySetting('loopback, 172.18.0.0/16')).toBe('loopback, 172.18.0.0/16');
  });
});

import { describe, expect, it } from 'vitest';
import { type TrustProxyValue, isInternalAddress, trustProxySetting } from './proxy.js';

/**
 * Reproduz o que o Express faz com o valor: o `proxy-addr` anda pela cadeia
 * `[socket, …X-Forwarded-For invertido]` enquanto o salto for confiável e
 * devolve o último endereço que sobrou. É isso — e não o valor em si — que
 * decide o `req.ip`, então é isso que os testes do padrão precisam olhar.
 */
function ipResolvido(trust: TrustProxyValue, socket: string, xff: string[] = []): string {
  if (typeof trust !== 'function') throw new Error('só o padrão é função');
  const cadeia = [socket, ...[...xff].reverse()];
  for (let i = 0; i < cadeia.length - 1; i += 1) {
    if (trust(cadeia[i]!, i)) continue;
    cadeia.length = i + 1;
    break;
  }
  return cadeia[cadeia.length - 1]!;
}

describe('trustProxySetting', () => {
  it('por padrão confia num salto, e só de peer interno', () => {
    for (const raw of [undefined, '', '   ']) {
      const trust = trustProxySetting(raw);
      expect(typeof trust).toBe('function');
      const confia = trust as (addr: string, salto: number) => boolean;
      expect(confia('172.18.0.2', 0)).toBe(true);
      expect(confia('127.0.0.1', 0)).toBe(true);
      // Peer da Internet: nada de `X-Forwarded-*` dele.
      expect(confia('203.0.113.9', 0)).toBe(false);
      // A trava do padrão: o salto seguinte nunca é confiável.
      expect(confia('10.0.0.1', 1)).toBe(false);
    }
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
    // A saída de emergência: quem precisa do padrão anterior o declara, e aí
    // vale ao pé da letra — sem a trava de um salto.
    expect(trustProxySetting('loopback, uniquelocal')).toBe('loopback, uniquelocal');
  });
});

describe('req.ip com o padrão', () => {
  const padrao = trustProxySetting('');

  it('atrás do proxy, vale o endereço que o proxy anotou', () => {
    // Traefik numa rede Docker, cliente da Internet.
    expect(ipResolvido(padrao, '172.18.0.2', ['203.0.113.9'])).toBe('203.0.113.9');
  });

  it('cliente de faixa privada não escolhe mais o próprio IP', () => {
    // O cliente 192.168.1.5 mandou `X-Forwarded-For: 9.9.9.9`; o proxy
    // acrescentou o endereço real à direita. O padrão anterior seguia a cadeia
    // (os dois são privados) e devolvia o forjado.
    expect(ipResolvido(padrao, '172.18.0.2', ['9.9.9.9', '192.168.1.5'])).toBe('192.168.1.5');
  });

  it('peer da Internet não tem X-Forwarded-For aceito', () => {
    expect(ipResolvido(padrao, '203.0.113.9', ['10.0.0.1'])).toBe('203.0.113.9');
  });

  it('sem cabeçalho, vale o peer', () => {
    expect(ipResolvido(padrao, '172.18.0.2')).toBe('172.18.0.2');
    expect(ipResolvido(padrao, '203.0.113.9')).toBe('203.0.113.9');
  });

  it('dois proxies encadeados param no de fora — é o caso de declarar TRUST_PROXY', () => {
    // CDN → Traefik → app: o Traefik anota a borda da CDN, que é pública.
    expect(ipResolvido(padrao, '172.18.0.2', ['198.51.100.7', '203.0.113.9'])).toBe('203.0.113.9');
  });
});

describe('isInternalAddress', () => {
  const enderecos: [string | undefined, boolean][] = [
    ['127.0.0.1', true],
    ['127.1.2.3', true],
    ['10.0.0.1', true],
    ['172.16.0.1', true],
    ['172.31.255.254', true],
    ['172.15.0.1', false],
    ['172.32.0.1', false],
    ['192.168.1.5', true],
    ['192.169.1.5', false],
    ['203.0.113.9', false],
    ['::1', true],
    ['fd00::1', true],
    ['fc12:3456::9', true],
    ['fe80::1', false],
    ['2001:db8::1', false],
    // Socket dual-stack: o IPv4 de dentro é o que classifica.
    ['::ffff:172.18.0.1', true],
    ['::FFFF:203.0.113.9', false],
    ['', false],
    [undefined, false],
  ];

  it.each(enderecos)('isInternalAddress(%j) = %s', (ip, esperado) => {
    expect(isInternalAddress(ip)).toBe(esperado);
  });
});

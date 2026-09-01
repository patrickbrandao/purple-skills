import { describe, expect, it } from 'vitest';
import { signSession, verifySession } from './session.js';

const SECRET = 'segredo-de-teste';
const future = () => Math.floor(Date.now() / 1000) + 3600;

describe('sessão assinada', () => {
  it('valida um token recém-assinado', () => {
    const token = signSession({ sub: 'admin', exp: future() }, SECRET);
    expect(verifySession(token, SECRET)?.sub).toBe('admin');
  });

  it('rejeita assinatura feita com outro segredo', () => {
    const token = signSession({ sub: 'admin', exp: future() }, SECRET);
    expect(verifySession(token, 'outro-segredo')).toBeNull();
  });

  it('rejeita payload adulterado', () => {
    const token = signSession({ sub: 'admin', exp: future() }, SECRET);
    const forged = Buffer.from(JSON.stringify({ sub: 'root', exp: future() })).toString('base64url');
    expect(verifySession(`${forged}.${token.split('.')[1]}`, SECRET)).toBeNull();
  });

  it('rejeita token expirado', () => {
    const token = signSession({ sub: 'admin', exp: Math.floor(Date.now() / 1000) - 1 }, SECRET);
    expect(verifySession(token, SECRET)).toBeNull();
  });

  it('rejeita entradas malformadas', () => {
    expect(verifySession(undefined, SECRET)).toBeNull();
    expect(verifySession('', SECRET)).toBeNull();
    expect(verifySession('sem-ponto', SECRET)).toBeNull();
    expect(verifySession('a.b', SECRET)).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import {
  GOOGLE_FONTS_FILES,
  GOOGLE_FONTS_STYLE,
  REFERRER_POLICY_PRIVATE,
  contentSecurityPolicy,
  inlineScriptHashes,
  securityHeaders,
} from './headers.js';

/** `sha256` de `alert(1)` em base64 — o hash que a CSP espera ver. */
const ALERT_1 = "'sha256-bhHHL3z2vDgxUt0W3dWQOrprscmda2Y5pLsLg4GF+pI='";

describe('inlineScriptHashes', () => {
  it('calcula o hash do script embutido', () => {
    expect(inlineScriptHashes('<script>alert(1)</script>')).toEqual([ALERT_1]);
  });

  it('ignora script externo, que já entra por "self"', () => {
    const html = '<script type="module" crossorigin src="/assets/index-abc.js"></script>';
    expect(inlineScriptHashes(html)).toEqual([]);
  });

  it('não apara espaço: o hash é sobre o texto exato do documento', () => {
    expect(inlineScriptHashes('<script>\n  alert(1)\n</script>')).not.toEqual([ALERT_1]);
  });

  it('não repete o mesmo script duas vezes', () => {
    expect(inlineScriptHashes('<script>alert(1)</script><script>alert(1)</script>')).toEqual([ALERT_1]);
  });

  it('pega o atributo antes do corpo sem se perder', () => {
    expect(inlineScriptHashes('<script type="text/javascript">alert(1)</script>')).toEqual([ALERT_1]);
  });
});

describe('contentSecurityPolicy', () => {
  it('põe o hash do tema no script-src', () => {
    const policy = contentSecurityPolicy({ html: '<script>alert(1)</script>' });
    expect(policy).toContain(`script-src 'self' ${ALERT_1}`);
  });

  it('sem HTML, o script-src fica só com self', () => {
    expect(contentSecurityPolicy()).toContain("script-src 'self';");
  });

  it('fecha o que não tem uso e libera o que tem', () => {
    const policy = contentSecurityPolicy({
      styleSources: [GOOGLE_FONTS_STYLE],
      fontSources: [GOOGLE_FONTS_FILES],
    });
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("base-uri 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("form-action 'self'");
    expect(policy).toContain("connect-src 'self'");
    // O ícone de uma skill é uma URL http(s) qualquer.
    expect(policy).toContain('img-src');
    expect(policy).toContain(`style-src 'self' 'unsafe-inline' ${GOOGLE_FONTS_STYLE}`);
    expect(policy).toContain(`font-src 'self' data: ${GOOGLE_FONTS_FILES}`);
  });
});

describe('securityHeaders', () => {
  it('manda a política bloqueando por padrão', () => {
    const headers = securityHeaders();
    expect(headers['Content-Security-Policy']).toBeDefined();
    expect(headers['Content-Security-Policy-Report-Only']).toBeUndefined();
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['Cross-Origin-Opener-Policy']).toBe('same-origin');
    expect(headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
  });

  it('em modo relatório, nada é bloqueado', () => {
    const headers = securityHeaders({ reportOnly: true });
    expect(headers['Content-Security-Policy']).toBeUndefined();
    expect(headers['Content-Security-Policy-Report-Only']).toBeDefined();
  });

  it('o painel usa a política de referência mais fechada', () => {
    expect(securityHeaders({ referrerPolicy: REFERRER_POLICY_PRIVATE })['Referrer-Policy']).toBe('same-origin');
  });
});

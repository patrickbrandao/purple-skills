/**
 * Valor de `app.set('trust proxy', …)` lido do ambiente.
 *
 * `true` faz o Express confiar em `X-Forwarded-*` vindo de qualquer origem —
 * o cliente passa a controlar `req.secure` (que decide a flag `Secure` do
 * cookie de sessão) e `req.ip` (que envenena logs e qualquer rate limiter por
 * IP). O padrão aqui confia apenas em loopback e nas faixas privadas, o que
 * cobre um proxy reverso no host ou numa rede Docker sem confiar na Internet.
 *
 * Ajuste com `TRUST_PROXY`:
 * - `loopback, uniquelocal` (padrão)
 * - `1` — confia num único proxy imediatamente à frente
 * - `10.1.0.0/16` — uma sub-rede específica
 * - `true` — confia em qualquer origem (não use em produção exposta)
 */
export function trustProxySetting(raw = process.env.TRUST_PROXY): boolean | number | string {
  const value = (raw ?? '').trim();
  if (!value) return 'loopback, uniquelocal';
  if (value === 'true') return true;
  if (value === 'false') return false;

  const hops = Number(value);
  if (Number.isInteger(hops) && hops >= 0) return hops;

  return value;
}

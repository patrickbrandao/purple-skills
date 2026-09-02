/**
 * Leitura validada de números vindos do ambiente.
 *
 * `Number('25MB')` é `NaN`, e toda comparação com `NaN` é falsa: um limite
 * escrito errado desligaria em silêncio justamente a proteção que ele deveria
 * configurar (teto de descompressão de zip, teto de sessões, tamanho máximo de
 * upload). `Number('')` é `0`, que fecha a porta por completo. Nos dois casos o
 * operador não recebe aviso nenhum — daí um valor inválido derrubar o boot com
 * uma mensagem explícita, em vez de virar default ou "sem limite".
 */
export type ReadIntEnvOptions = {
  /** Menor valor aceito, inclusive. Padrão: 1. */
  min?: number;
  /** Maior valor aceito, inclusive. Padrão: `Number.MAX_SAFE_INTEGER`. */
  max?: number;
  env?: NodeJS.ProcessEnv;
};

/** Lê um inteiro do ambiente. Ausente ou vazio devolve `fallback`; inválido lança. */
export function readIntEnv(
  name: string,
  fallback: number,
  options: ReadIntEnvOptions = {},
): number {
  const { min = 1, max = Number.MAX_SAFE_INTEGER, env = process.env } = options;
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(
      `${name} inválida: esperado um inteiro entre ${min} e ${max}, recebido "${raw}"`,
    );
  }

  return value;
}

/**
 * Lê um texto do ambiente tratando vazio como ausente.
 *
 * O docker-compose repassa uma variável não preenchida como string vazia
 * (`FOO: ${FOO:-}`), e `process.env.FOO ?? padrão` devolveria `''` — o valor
 * some em vez de cair no padrão.
 */
export function readTextEnv(name: string, fallback: string, env = process.env): string {
  const raw = env[name]?.trim();
  return raw === undefined || raw === '' ? fallback : raw;
}

/** Porta TCP lida do ambiente, com a faixa válida já aplicada. */
export function readPortEnv(name: string, fallback: number, env = process.env): number {
  return readIntEnv(name, fallback, { min: 1, max: 65_535, env });
}

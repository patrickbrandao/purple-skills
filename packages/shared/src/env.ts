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

const BOOL_TRUE = new Set(['true', '1', 'yes', 'on']);
const BOOL_FALSE = new Set(['false', '0', 'no', 'off']);

/**
 * Lê um booleano do ambiente. Ausente, vazio ou só-espaços devolve `undefined`
 * — quem chama decide o padrão (`readBoolEnv('X') ?? true`) ou trata a
 * ausência como um terceiro estado, que é o caso do `ADMIN_COOKIE_SECURE`
 * (vazio = acompanhar o protocolo da requisição).
 *
 * Valor irreconhecível lança, pela razão do cabeçalho deste módulo: o leitor
 * que existia no painel devolvia `false` para tudo que não fosse `true`/`1`, e
 * `ADMIN_COOKIE_SECURE=TRUE` — ou `yes`, ou `true ` com um espaço sobrando —
 * destravava em silêncio o cookie de sessão que o operador quis travar.
 */
export function readBoolEnv(name: string, env = process.env): boolean | undefined {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return undefined;

  const value = raw.toLowerCase();
  if (BOOL_TRUE.has(value)) return true;
  if (BOOL_FALSE.has(value)) return false;

  throw new Error(
    `${name} inválida: esperado true ou false (também 1/0, yes/no, on/off), recebido "${raw}"`,
  );
}

/**
 * Lê um tamanho no formato que o `express.json({ limit })` entende — `1mb`,
 * `512kb`, `1.5mb`, ou um inteiro de bytes (`1048576`, `512b`) — e devolve o
 * próprio texto, aparado, para ser entregue como está. Ausente ou vazio
 * devolve `fallback`; inválido lança.
 *
 * Existe porque o `bytes`, que o body-parser usa, não recusa o que não entende:
 * cai num `parseInt` e aproveita o que der. Medido com bytes 3.1.2: `48m`,
 * `48 megas` e `48MiB` valem 48 **bytes**, `1mbb` vale 1 byte, `-1mb` vira teto
 * negativo e ` 1mb ` com espaço nas pontas vale 1 byte — o serviço sobe e passa
 * a responder 413 a toda requisição. Só o que não tem dígito nenhum (`abc`)
 * derruba o `express.json`, e com uma mensagem que não diz de qual variável
 * veio. Aqui o erro aparece no boot, com o nome dela.
 */
export function readSizeEnv(name: string, fallback: string, env = process.env): string {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;

  const match = /^(\d+(?:\.\d+)?) *(?:kb|mb|gb)$|^(\d+) *b?$/i.exec(raw);
  // Zero passaria no formato e fecharia a porta por completo, como o
  // `Number('')` do cabeçalho: teto de corpo que não deixa passar corpo nenhum.
  if (!match || !(Number(match[1] ?? match[2]) > 0)) {
    throw new Error(
      `${name} inválida: esperado um tamanho como "1mb", "512kb" ou um inteiro de bytes, recebido "${raw}"`,
    );
  }

  return raw;
}

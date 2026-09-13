/**
 * O ícone de uma skill: um emoji ou a URL de uma imagem.
 *
 * É o que o painel desenha nos cards e nos nós do canvas
 * (`docs/10-admin-canvas-e-sessoes.md`). Sem ícone, o painel cai no monograma
 * pelas iniciais — por isso o campo é opcional e vazio vira nulo, nunca erro.
 */
export const SKILL_ICON_MAX_LENGTH = 512;

/**
 * Um único emoji: pictograma com modificador de tom ou seletor de variação,
 * sequência unida por ZWJ (👩‍💻), bandeira (par de indicadores regionais) ou
 * keycap (1️⃣). Dois emojis lado a lado não passam: o espaço é de um só.
 */
const EMOJI =
  /^(?:\p{Regional_Indicator}{2}|[0-9#*]️?⃣|\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|️)?(?:‍\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|️)?)*)$/u;

export function isEmojiIcon(value: string): boolean {
  return EMOJI.test(value);
}

/** URL absoluta http(s), sem espaço e dentro do limite: é onde o `<img>` aponta. */
export function isUrlIcon(value: string): boolean {
  if (value.length > SKILL_ICON_MAX_LENGTH || /\s/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function isValidSkillIcon(value: string): boolean {
  return isEmojiIcon(value) || isUrlIcon(value);
}

/**
 * O ícone da marca do painel (`ADMIN_BRAND_ICON_URL`): URL http(s) ou um
 * caminho servido pelo próprio painel, começando por uma única `/`. Diferente
 * do ícone de skill, o caminho local vale — é assim que o padrão aponta para
 * o chapéu em `/assets`.
 */
export function isBrandIconUrl(value: string): boolean {
  if (isUrlIcon(value)) return true;
  return value.length <= SKILL_ICON_MAX_LENGTH && /^\/(?!\/)[^\s\\]*$/.test(value);
}

/**
 * Normaliza o que chegou do formulário ou de uma tool: `undefined` é "não
 * mexe", vazio (ou `null`) é "apaga", texto válido é o ícone. Devolve `false`
 * quando o valor não é emoji nem URL — quem chama decide a mensagem.
 */
export function normalizeSkillIcon(value: unknown): string | null | undefined | false {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return isValidSkillIcon(trimmed) ? trimmed : false;
}

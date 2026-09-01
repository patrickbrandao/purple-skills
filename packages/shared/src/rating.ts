/**
 * "Votação de acesso": ranking é a soma simples de views + downloads.
 * Calculado também em SQL (ORDER BY), replicado aqui para uso no frontend/MCP.
 */
export function skillScore(viewCount: number | bigint, downloadCount: number | bigint): number {
  return Number(viewCount ?? 0) + Number(downloadCount ?? 0);
}

export type RankableSkill = { viewCount: number | bigint; downloadCount: number | bigint };

/** Ordena skills pelo score decrescente (não muta o array de entrada). */
export function rankSkills<T extends RankableSkill>(skills: readonly T[]): T[] {
  return [...skills].sort(
    (a, b) =>
      skillScore(b.viewCount, b.downloadCount) - skillScore(a.viewCount, a.downloadCount),
  );
}

/**
 * Converte o score bruto em estrelas de 0 a 5, com escala logarítmica —
 * usado apenas para exibição no site.
 */
export function scoreToStars(score: number): number {
  if (score <= 0) return 0;
  const stars = Math.log10(score + 1) * 2;
  return Math.max(0, Math.min(5, Math.round(stars * 10) / 10));
}

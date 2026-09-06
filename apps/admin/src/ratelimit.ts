/**
 * Janela deslizante em memória, por chave (o IP do cliente).
 *
 * É a **primeira** das duas camadas do §2.7: absorve a rajada sem tocar o
 * banco. A segunda é `users.locked_until`, que sobrevive a restart e vale para
 * vários containers do painel — nenhuma das duas resolve sozinha, porque esta
 * some no restart e aquela não protege contra varredura de e-mails
 * inexistentes.
 */
export type RateLimiter = {
  /** `true` quando a tentativa é permitida (e já foi contabilizada). */
  hit(key: string): boolean;
  /** Zera o contador — chamado no login bem-sucedido. */
  reset(key: string): void;
  /** Segundos até a janela liberar. `0` quando não está bloqueado. */
  retryAfter(key: string): number;
};

export function createRateLimiter(options: {
  max: number;
  windowSeconds: number;
  /** Teto de chaves distintas — impede que a memória vire alvo. */
  maxKeys?: number;
}): RateLimiter {
  const windowMs = options.windowSeconds * 1000;
  const maxKeys = options.maxKeys ?? 10_000;
  const hits = new Map<string, number[]>();

  const prune = (key: string, now: number): number[] => {
    const kept = (hits.get(key) ?? []).filter((at) => now - at < windowMs);
    if (kept.length === 0) hits.delete(key);
    else hits.set(key, kept);
    return kept;
  };

  return {
    hit(key) {
      const now = Date.now();

      // Varredura barata: só quando o mapa passa do teto, e só do que expirou.
      if (hits.size > maxKeys) {
        for (const [candidate, stamps] of hits) {
          if (stamps.every((at) => now - at >= windowMs)) hits.delete(candidate);
        }
        // Ainda cheio depois da limpeza: o mais antigo sai para abrir espaço.
        if (hits.size > maxKeys) hits.delete(hits.keys().next().value as string);
      }

      const kept = prune(key, now);
      if (kept.length >= options.max) return false;

      kept.push(now);
      hits.set(key, kept);
      return true;
    },

    reset(key) {
      hits.delete(key);
    },

    retryAfter(key) {
      const now = Date.now();
      const kept = prune(key, now);
      if (kept.length < options.max) return 0;
      return Math.max(1, Math.ceil((windowMs - (now - kept[0])) / 1000));
    },
  };
}

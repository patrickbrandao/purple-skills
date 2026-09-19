/**
 * Janela deslizante em memória, por chave — em geral o IP do cliente.
 *
 * Mora aqui, e não dentro de um app, porque as três superfícies HTTP precisam
 * da mesma conta: o login do painel (§2.7 de `docs/05-accounts-and-roles.md`),
 * o site e o MCP público. Como o `securityHeaders`, não conhece Express de
 * propósito — quem escreve o corpo da recusa é cada app, porque o site responde
 * `{ error, message }` e os MCP respondem JSON-RPC.
 *
 * O que ela é: a camada barata, que absorve a rajada **antes** de qualquer
 * consulta ou escrita no banco. O que ela não é: quota contábil. A conta vive
 * no processo, então dois containers do mesmo serviço têm cada um a sua e um
 * restart zera — o que precisa sobreviver a restart é o `users.locked_until`
 * do painel.
 */
export type RateLimiter = {
  /** `true` quando a requisição é permitida (e já foi contabilizada). */
  hit(key: string): boolean;
  /** Zera o contador — chamado no login bem-sucedido. */
  reset(key: string): void;
  /**
   * Devolve a marca mais recente da chave: a requisição aconteceu, mas não
   * gasta cota. É como o MCP público isenta quem chegou autenticado por chave
   * própria sem deixar de contar quem chegou anônimo do mesmo IP.
   */
  forgive(key: string): void;
  /** Segundos até a janela liberar. `0` quando não está bloqueado. */
  retryAfter(key: string): number;
};

export type RateLimiterOptions = {
  /** Requisições permitidas por janela, por chave. */
  max: number;
  /** Tamanho da janela, em segundos. */
  windowSeconds: number;
  /**
   * Teto de chaves distintas — impede que a memória vire alvo. Estourado, a
   * chave parada há mais tempo sai: o pior caso é o limite não valer para ela
   * (liberar, nunca bloquear quem não devia).
   */
  maxKeys?: number;
};

/** Varredura do mapa no máximo uma vez por segundo — ver `faxina`. */
const FAXINA_MIN_MS = 1000;

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const windowMs = options.windowSeconds * 1000;
  const maxKeys = options.maxKeys ?? 10_000;
  /**
   * Marcas de tempo por chave, em ordem crescente dentro de cada chave; o mapa
   * fica em ordem de uso, porque `hit` reinsere a chave que acabou de contar.
   * É isso que faz `keys().next()` devolver a mais parada quando falta espaço.
   */
  const hits = new Map<string, number[]>();
  let ultimaFaxina = 0;

  /**
   * As marcas ainda dentro da janela. Como elas entram em ordem, as vencidas
   * são sempre um prefixo: dá para cortar sem varrer o resto do vetor.
   */
  const dentroDaJanela = (key: string, now: number): number[] => {
    const marcas = hits.get(key);
    if (!marcas) return [];
    let vencidas = 0;
    while (vencidas < marcas.length && now - marcas[vencidas]! >= windowMs) vencidas += 1;
    return vencidas === 0 ? marcas : marcas.slice(vencidas);
  };

  /**
   * Tira do mapa as chaves paradas há mais de uma janela.
   *
   * Amortizada de propósito: varrer a cada requisição custa O(chaves) por
   * requisição justamente quando o servidor está sob rajada — a proteção viraria
   * o próximo problema de capacidade. Entre duas varreduras, o espaço sai da
   * chave mais parada, que é O(1).
   */
  const faxina = (now: number): void => {
    if (hits.size < maxKeys && now - ultimaFaxina < windowMs) return;

    if (now - ultimaFaxina >= FAXINA_MIN_MS) {
      ultimaFaxina = now;
      for (const [candidata, marcas] of hits) {
        if (now - marcas[marcas.length - 1]! >= windowMs) hits.delete(candidata);
      }
    }

    while (hits.size >= maxKeys) {
      const maisParada = hits.keys().next();
      if (maisParada.done) break;
      hits.delete(maisParada.value);
    }
  };

  return {
    hit(key) {
      const now = Date.now();
      faxina(now);

      const marcas = dentroDaJanela(key, now);
      if (marcas.length >= options.max) {
        // Guarda o vetor já podado, mas **sem** reinserir a chave: quem está
        // bloqueado não renova a posição e é o primeiro a sair se faltar espaço.
        hits.set(key, marcas);
        return false;
      }

      marcas.push(now);
      hits.delete(key);
      hits.set(key, marcas);
      return true;
    },

    reset(key) {
      hits.delete(key);
    },

    forgive(key) {
      const marcas = hits.get(key);
      if (!marcas || marcas.length === 0) return;
      marcas.pop();
      if (marcas.length === 0) hits.delete(key);
    },

    retryAfter(key) {
      const now = Date.now();
      const marcas = dentroDaJanela(key, now);
      if (marcas.length < options.max) return 0;
      return Math.max(1, Math.ceil((windowMs - (now - marcas[0]!)) / 1000));
    },
  };
}

/** Os quatro primeiros grupos de um IPv6, com `::` já expandido. */
function prefixoIpv6(endereco: string): string {
  const [esquerda = '', direita = ''] = endereco.split('::');
  const antes = esquerda === '' ? [] : esquerda.split(':');
  const depois = direita === '' ? [] : direita.split(':');
  const grupos = endereco.includes('::')
    ? [...antes, ...Array.from({ length: Math.max(0, 8 - antes.length - depois.length) }, () => '0'), ...depois]
    : antes;

  return grupos
    .slice(0, 4)
    .map((grupo) => (grupo === '' ? '0' : grupo.replace(/^0+(?=.)/, '').toLowerCase()))
    .join(':');
}

/**
 * A chave do limite a partir do IP do cliente.
 *
 * IPv4 conta por endereço. **IPv6 conta por /64**, porque um assinante recebe o
 * /64 inteiro (2^64 endereços) e o próprio sistema troca de endereço de origem
 * sozinho (privacy extensions): contar por endereço daria cota infinita a quem
 * tem IPv6 e cota única a quem tem IPv4. `::ffff:` é IPv4 disfarçado e volta a
 * contar como IPv4.
 *
 * Sem IP — socket já fechado, ou `trust proxy` esperando um cabeçalho que não
 * veio — todos caem na mesma chave: contar junto é melhor que não contar.
 *
 * Vale lembrar que a chave só é confiável se `req.ip` for: com `trust proxy`
 * largo, quem alcança o servidor escolhe o próprio IP (ver `trustProxySetting`).
 */
export function rateLimitKey(ip: string | undefined): string {
  const bruto = (ip ?? '').trim();
  if (bruto === '') return 'desconhecido';

  // `fe80::1%eth0`: a zona é do host que recebeu, não do cliente.
  const semZona = bruto.split('%')[0]!;
  const mapeado = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(semZona);
  if (mapeado) return mapeado[1]!;
  if (!semZona.includes(':')) return semZona;

  return `${prefixoIpv6(semZona)}::/64`;
}

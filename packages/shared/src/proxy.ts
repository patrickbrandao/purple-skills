/**
 * O que o Express aceita em `app.set('trust proxy', …)`. A forma de função é
 * `(endereço, salto) => confia?`, chamada de fora para dentro da cadeia
 * `[socket, …X-Forwarded-For invertido]`: é o único formato que permite
 * combinar "quem" com "quantos saltos".
 */
export type TrustProxyValue = boolean | number | string | ((addr: string, salto: number) => boolean);

/**
 * Valor de `app.set('trust proxy', …)` lido do ambiente.
 *
 * Quem decide o que são `req.ip`, `req.secure` e `req.hostname` é esta função:
 * os três saem de cabeçalhos `X-Forwarded-*`, que só valem algo se quem
 * escreveu for confiável. `true` faz o Express confiar em qualquer origem — o
 * cliente passa a controlar a flag `Secure` do cookie de sessão e o IP que
 * alimenta log, auditoria e limitador de taxa.
 *
 * O padrão é **um salto a partir de um peer interno**: confia em quem abriu a
 * conexão, e só se o endereço dele for loopback ou faixa privada, tomando como
 * cliente a **última** entrada do `X-Forwarded-For` — a que esse peer anotou.
 * Confiar na lista inteira (`loopback, uniquelocal`, o padrão anterior) faz o
 * Express seguir a cadeia enquanto os endereços forem privados, e aí um cliente
 * de faixa privada que atravessa o proxy reverso escolhe o próprio `req.ip`:
 * basta mandar um `X-Forwarded-For` qualquer, porque o proxy acrescenta o
 * endereço real **à direita** e o valor forjado, à esquerda, é o que sobra.
 *
 * O que o padrão não resolve: quem alcança a porta do serviço direto já de
 * dentro de uma faixa privada — um contêiner vizinho na mesma rede Docker, uma
 * máquina da LAN com `BIND_ADDR=0.0.0.0` — é o salto 0 e continua declarando o
 * IP que quiser. Contra isso não existe padrão seguro: ou o proxy é nomeado em
 * `TRUST_PROXY`, ou a porta não fica alcançável sem passar por ele (é o que o
 * `docker-compose.traefik.yml` faz, com `ports: !reset []`).
 *
 * O preço de não adivinhar a profundidade da cadeia: com **dois** proxies
 * internos em sequência e `TRUST_PROXY` vazio, `req.ip` passa a ser o endereço
 * do proxy de dentro — todo cliente cai no mesmo balde do limitador de taxa e o
 * link de redefinição de senha volta a aceitar o `Host` da requisição. Essa
 * topologia precisa declarar `TRUST_PROXY`; instalação com um proxy (o compose
 * com Traefik, um nginx no host) não muda de comportamento.
 *
 * Ajuste com `TRUST_PROXY`. Valor explícito é obedecido ao pé da letra, **sem**
 * a trava de um salto:
 * - vazio — o padrão acima
 * - `172.18.0.2`, `10.1.0.0/16` — o endereço ou a faixa do proxy; é a opção
 *   mais segura, e a única que não confia nos vizinhos dele
 * - `2` — dois proxies em cadeia (CDN à frente do proxy reverso). Contagem de
 *   saltos confia no peer **seja quem for**, então só use quando a porta não
 *   for alcançável sem passar pelo proxy
 * - `loopback, uniquelocal` — o padrão anterior: toda a RFC1918, em qualquer
 *   profundidade
 * - `true` — confia em qualquer origem (não use em produção exposta)
 */
export function trustProxySetting(raw = process.env.TRUST_PROXY): TrustProxyValue {
  const value = (raw ?? '').trim();
  if (!value) return umSaltoDePeerInterno;
  if (value === 'true') return true;
  if (value === 'false') return false;

  const hops = Number(value);
  if (Number.isInteger(hops) && hops >= 0) return hops;

  return value;
}

/**
 * O padrão: confia no salto 0 — o peer que abriu a conexão — quando ele é
 * interno, e para aí. Recusar o salto 1 é o que faz `req.ip` ser o endereço que
 * o proxy anotou, nunca uma entrada que o cliente pôs antes dela.
 *
 * Recusar o salto 0 de endereço público é o que separa este padrão de
 * `TRUST_PROXY=1`: com a contagem de saltos, qualquer cliente que fale direto
 * com a porta (numa instalação sem proxy, exposta na Internet) passa a escolher
 * o próprio IP — o remédio seria pior que a doença.
 */
function umSaltoDePeerInterno(addr: string, salto: number): boolean {
  return salto === 0 && isInternalAddress(addr);
}

/**
 * `true` para os endereços que o Express chama de `loopback, uniquelocal`:
 * 127.0.0.0/8, ::1, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 e fc00::/7.
 * Link-local (169.254.0.0/16, fe80::/10) fica fora, como no padrão anterior.
 *
 * `apps/admin/src/config.ts` tem uma gêmea desta função, que decide se o `Host`
 * da requisição pode virar base do link de redefinição de senha: as duas
 * precisam dizer a mesma coisa, e consolidar é trocar a local por um `import`.
 */
export function isInternalAddress(ip: string | undefined): boolean {
  if (!ip) return false;

  // Socket dual-stack entrega IPv4 mapeado (`::ffff:172.18.0.1`): o que
  // interessa classificar é o IPv4 de dentro.
  const value = ip.trim().toLowerCase().replace(/^::ffff:/, '');

  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(value);
  if (v4) {
    const first = Number(v4[1]);
    const second = Number(v4[2]);
    if (first === 127 || first === 10) return true;
    if (first === 172) return second >= 16 && second <= 31;
    return first === 192 && second === 168;
  }

  if (value === '::1') return true;
  // fc00::/7 são os prefixos `fc` e `fd`. O primeiro hexteto sempre aparece com
  // os quatro dígitos, porque começa por um dígito diferente de zero.
  return /^f[cd][0-9a-f]{2}:/.test(value);
}

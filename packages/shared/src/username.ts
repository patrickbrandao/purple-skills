/**
 * Normalização, validação e derivação de username.
 *
 * **Este módulo é o único do `shared` com export próprio no `package.json`**
 * (`@purple-skills/shared/username`), e por um motivo específico: o bundle do
 * painel não importa `@purple-skills/shared` — a raiz reexporta módulos que
 * falam com `node:fs` e `node:crypto`, e puxá-los para o navegador quebraria o
 * build. Mas a **regra do username tem de ser uma só**: ela já existe duas
 * vezes (aqui e em SQL, na migration `033`, que roda uma vez e some), e uma
 * terceira cópia no navegador, essa sim viva, divergiria na primeira mudança.
 * Este arquivo não importa nada — é folha, e entra no bundle sozinho.
 *
 * O username é o **identificador público** de uma conta (`docs/19-username.md`):
 * é ele que aparece como dono, como linha da ACL, como quem leu uma skill na
 * guia Acessos e — desde a decisão 11 — na ficha pública do site. O e-mail
 * ocupava esse lugar e voltou a ser privado, com três usos: entrar, recuperar a
 * senha e casar com a identidade do OIDC.
 *
 * Este módulo é para o username o que `email.ts` é para o e-mail: o único lugar
 * que decide o que vale. A diferença de postura entre os dois é deliberada — a
 * validação do e-mail é frouxa de propósito (recusar um endereço válido é pior
 * do que aceitar um que nunca receberá e-mail), e a do username é **estrita**,
 * porque um username confundível com outro é um erro de atribuição na tela de
 * quem administra.
 */

/**
 * Nomes que nenhuma conta pode tomar.
 *
 * `admin`, `api` e `setup` colidem com caminho de rota ou com papel; `me`,
 * `system`, `null`, `none` e `root` são os rótulos que um leitor humano lê como
 * "não é uma pessoa"; `purple-skills` é o nome do projeto, que numa trilha de
 * auditoria seria lido como ação da instalação e não de alguém.
 */
export const RESERVED_USERNAMES: readonly string[] = [
  'admin',
  'api',
  'me',
  'none',
  'null',
  'purple-skills',
  'root',
  'setup',
  'support',
  'system',
];

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 32;

/**
 * Alfanumérico nas pontas, `[a-z0-9._-]` no meio e **nunca duas pontuações
 * seguidas**. A regra do meio é o que impede o par confundível: sem ela
 * `ana.silva`, `ana..silva` e `ana._silva` seriam três contas diferentes que
 * ninguém distingue lendo a tela do painel.
 *
 * **O separador é obrigatório dentro do grupo, e isso não é estilo — é o que
 * impede backtracking catastrófico.** A forma anterior era
 * `/^[a-z0-9](?:[._-]?[a-z0-9]+)*$/`, com o separador **opcional**: numa cadeia
 * de alfanuméricos ela aceita 2^(n-1) partições diferentes, e uma entrada que
 * **falha no fim** obriga o motor a testar todas. Medido nesta máquina, com o
 * teto de 32 caracteres que o próprio validador impõe logo acima:
 *
 * | entrada | antes | agora |
 * |---|---|---|
 * | `'a'×20 + '!'` | 27 ms | 0,02 ms |
 * | `'a'×28 + '!'` | 766 ms | 0,002 ms |
 * | `'a'×31 + '!'` | **6 273 ms** | 0,002 ms |
 *
 * Seis segundos de event loop **por requisição anônima**: `GET /u/<32
 * caracteres>/avatar` e `GET /api/profiles/<…>` no site chegam aqui antes de
 * qualquer ida ao banco, e o limite de 240/min por IP compra minutos de CPU com
 * uma requisição. No navegador era pior de perceber: `normalizeUsername` roda a
 * cada tecla nos formulários de conta, e digitar 31 letras e um `!` congelava a
 * aba.
 *
 * O teto de 32 **não** protegia: 2^31 é o problema, não o tamanho da string.
 *
 * A linguagem aceita é idêntica — o `+` inicial absorve o que o separador
 * opcional absorvia —, e a partição passa a ser única, que é o que torna o
 * casamento linear. Há teste de equivalência entre as duas formas.
 */
const USERNAME_SHAPE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

/** A forma de um uuid — ver `normalizeUsername`. */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * O username como ele é gravado, ou `null` se não valer.
 *
 * A caixa **não** é preservada, diferente do e-mail: o e-mail é gravado como a
 * pessoa escreveu porque o endereço é dela, e o username é identificador
 * público — `@Joao` e `@joao` sendo a mesma conta com duas grafias na tela é
 * confusão sem ganho.
 *
 * Duas recusas que não são de formato e valem ser lidas:
 *
 * - **Sem `@`.** É o que torna decidível o campo único do login (`docs/19`
 *   decisão 3): tem `@`, é e-mail; não tem, é username. Cai fora pelo
 *   `USERNAME_SHAPE`, e o teste garante que continue caindo.
 * - **Sem forma de uuid.** `ownerUserUuid` do `PATCH` aceita username **ou**
 *   uuid; um username com a cara de um uuid tornaria a entrada ambígua.
 */
export function normalizeUsername(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;

  const username = raw.trim().toLowerCase();
  if (username.length < USERNAME_MIN_LENGTH || username.length > USERNAME_MAX_LENGTH) return null;
  if (!USERNAME_SHAPE.test(username)) return null;
  if (UUID_SHAPE.test(username)) return null;
  if (RESERVED_USERNAMES.includes(username)) return null;

  return username;
}

/** `true` quando o texto está reservado (para separar a mensagem de recusa). */
export function isReservedUsername(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  return RESERVED_USERNAMES.includes(raw.trim().toLowerCase());
}

/**
 * O identificador do login é um e-mail ou um username?
 *
 * A presença do `@` decide (`docs/19` decisão 3). Um endereço sem `@` não é
 * e-mail, e `normalizeUsername` garante que nenhum username tem `@` — então os
 * dois conjuntos não se tocam e a regra não tem caso ambíguo.
 */
export function isEmailLogin(raw: unknown): boolean {
  return typeof raw === 'string' && raw.includes('@');
}

/**
 * Mapa de acentos do `usernameFromName`.
 *
 * Escrito à mão, e não com `String.normalize('NFD')` + remoção de combinantes,
 * porque **a migration `033` precisa da mesma regra em SQL** e esta instalação
 * não tem a extensão `unaccent` — a migration faz `translate()` com este mesmo
 * par de cadeias. Duas implementações da mesma regra só ficam iguais se a regra
 * for uma tabela; se fosse NFD aqui e `translate()` lá, o backfill e a criação
 * de conta divergiriam em silêncio no primeiro nome acentuado.
 */
const ACCENT_FROM = 'àáâãäåèéêëìíîïòóôõöùúûüýÿñçÀÁÂÃÄÅÈÉÊËÌÍÎÏÒÓÔÕÖÙÚÛÜÝÑÇ';
const ACCENT_TO = 'aaaaaaeeeeiiiiooooouuuuyyncAAAAAAEEEEIIIIOOOOOUUUUYNC';

function stripAccents(text: string): string {
  let out = '';
  for (const char of text) {
    const at = ACCENT_FROM.indexOf(char);
    out += at === -1 ? char : ACCENT_TO[at];
  }
  return out;
}

/**
 * O candidato a username derivado do nome da pessoa (`docs/19` §3.1).
 *
 * `Patrick Brandão` → `patrick-brandao`. É o que alimenta o backfill da
 * migration, a sugestão do formulário de criar conta e o
 * auto-provisionamento do OIDC — **nunca a parte antes do `@` do e-mail**:
 * publicar o local part para todo o painel vazaria metade do endereço, que é o
 * que esta mudança existe para evitar.
 *
 * Devolve `null` quando o nome não dá um username utilizável (vazio, curto
 * demais, só pontuação, reservado). Quem chama usa o fallback `user-<8 hex do
 * uuid>`, e a colisão é resolvida por quem grava, com sufixo numérico.
 */
export function usernameFromName(name: unknown): string | null {
  if (typeof name !== 'string') return null;

  const slug = stripAccents(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, USERNAME_MAX_LENGTH)
    .replace(/[-._]+$/g, '');

  return normalizeUsername(slug);
}

/**
 * O n-ésimo candidato para resolver colisão: `joao`, `joao-2`, `joao-3`, …
 *
 * O radical é truncado para o sufixo caber no teto — `…-10` num username de 32
 * caracteres corta dois do radical, não estoura o limite e não devolve `null`
 * na volta pelo `normalizeUsername`.
 */
export function usernameWithSuffix(base: string, n: number): string | null {
  if (n <= 1) return normalizeUsername(base);

  const suffix = `-${n}`;
  const root = base.slice(0, USERNAME_MAX_LENGTH - suffix.length).replace(/[-._]+$/g, '');
  if (!root) return null;

  return normalizeUsername(`${root}${suffix}`);
}

/**
 * O fallback de quem não tem nome utilizável: `user-` + os 8 primeiros hex do
 * uuid.
 *
 * **Não é único, e quem chama tem de resolver a colisão.** Com `uuidv7()` — que
 * é o default de `users.uuid` — os 8 primeiros hex são os 32 bits **altos** do
 * carimbo de milissegundos, e eles só mudam a cada ~65 s: duas contas criadas
 * no mesmo minuto produzem o mesmo valor. Medido pelo dba ao escrever a
 * migration `033`, onde o índice único derrubaria a execução. Com `randomUUID()`
 * (v4), que é o que o app passa aqui, os 8 hex são aleatórios e a colisão é
 * remota — mas o caminho é o mesmo dos dois lados: `nextFreeUsername` numera o
 * candidato (`-2`, `-3`, …) consultando o banco.
 */
export function usernameFromUuid(uuid: string): string {
  return `user-${uuid.replace(/-/g, '').slice(0, 8)}`;
}

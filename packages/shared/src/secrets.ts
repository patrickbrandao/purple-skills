import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';

/**
 * Padrão de secrets do projeto: `<NOME>_FILE` tem prioridade sobre `<NOME>`.
 * Retorna `undefined` quando nenhum dos dois está definido (ou está vazio).
 */
export function readSecret(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const filePath = env[`${name}_FILE`];
  if (filePath && filePath.trim()) {
    // `trim()`, e não `replace(/\r?\n$/)`: um arquivo salvo com linha em branco
    // no fim devolvia `'chave\n'`, e o `\n` que sobrava não aparece em erro
    // nenhum — ele só faz o `safeEqual` do `MCP_ADMIN_TOKEN` nunca casar com o
    // token que o cliente manda (`bearerToken` apara o dele) e a senha de
    // bootstrap ficar impossível de digitar. É o caminho `_FILE` do Docker
    // secrets, onde quem escreve o arquivo é um editor, não uma variável.
    // Vazio vira `undefined`, como no ramo da variável e como o cabeçalho diz.
    const doArquivo = readFileSync(filePath.trim(), 'utf8').trim();
    return doArquivo.length > 0 ? doArquivo : undefined;
  }

  const value = env[name];
  return value && value.length > 0 ? value : undefined;
}

/**
 * Placeholders do `.env.example`. A lista é a mesma do `.gitleaks.toml`: o que
 * a varredura dispensa por **não** ser segredo é exatamente o que o boot
 * precisa recusar. O padrão é ancorado de propósito — uma `DATABASE_URL` que
 * carregue `CHANGE_ME` no meio da string não casa.
 */
const PLACEHOLDERS =
  /^(CHANGE_ME|CHANGEME|REDACTED|PLACEHOLDER|EXEMPLO|EXAMPLE|TODO|xxx+|undefined)$/i;

/**
 * Diz se o valor é um dos placeholders do `.env.example`, sem lançar.
 *
 * Existe para quem precisa tratar o placeholder como **ausência** em vez de
 * erro de boot — hoje, as chaves do RAG (`readApiKeyEnv`, em
 * `@purple-skills/rag`), que saem do `.env.example` com `CHANGE_ME`: elas não
 * podem derrubar serviço nenhum (ver `assertNotPlaceholder`), mas também não
 * podem ser enviadas a um provedor como se fossem credencial. A lista é a mesma
 * do `assertNotPlaceholder`, de propósito: uma só, em par com o `.gitleaks.toml`.
 */
export function isPlaceholder(value: string): boolean {
  return PLACEHOLDERS.test(value.trim());
}

/**
 * Recusa o placeholder do `.env.example`; devolve o próprio valor quando serve.
 *
 * Um placeholder é público no repositório aberto: aceitá-lo como credencial
 * deixa qualquer pessoa autenticar-se na instalação. É a única defesa que não
 * depende de o operador ter lido a documentação certa.
 *
 * Fica **fora** do `readSecret` de propósito. As chaves do RAG também saem do
 * `.env.example` com `CHANGE_ME` e são lidas por lá mesmo com a busca semântica
 * desligada, então validar dentro do `readSecret` derrubaria o boot do site, do
 * mcp-public e do indexador por uma variável que ninguém usa. Quem chama é quem
 * sabe que aquele valor vai autenticar alguém.
 */
export function assertNotPlaceholder(name: string, value: string): string {
  const limpo = value.trim();
  if (isPlaceholder(limpo)) {
    throw new Error(
      `${name} está com o placeholder do .env.example ("${limpo}"), que é público no ` +
        'repositório: qualquer pessoa se autenticaria nesta instalação. Gere um valor ' +
        'próprio: openssl rand -hex 32',
    );
  }
  return value;
}

/**
 * Igual a `readSecret`, mas lança quando o segredo é obrigatório e falta — ou
 * quando ainda está com o placeholder do `.env.example`.
 */
export function requireSecret(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = readSecret(name, env);
  if (!value) {
    throw new Error(`Segredo obrigatório ausente: defina ${name} ou ${name}_FILE`);
  }
  return assertNotPlaceholder(name, value);
}

/** Comparação de strings resistente a timing attacks. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a ?? '', 'utf8');
  const bufB = Buffer.from(b ?? '', 'utf8');
  if (bufA.length !== bufB.length) {
    // Compara mesmo assim para manter o tempo constante em relação a `a`.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/** Extrai o token de um header `Authorization: Bearer <token>`. */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

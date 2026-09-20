/**
 * Guarda do fio entre o `.env` e a trava de boot do mcp-public.
 *
 * Por que existe: `assertNoLegacyAuthEnv` (`config.ts`) lê o ambiente **do
 * container**, e o `.env` do compose só interpola o `docker-compose.yml` — ao
 * container chega apenas o que o `environment` do serviço lista. Da beta.15 à
 * beta.22 as três variáveis do antigo MCP principal ficaram fora dessa lista
 * (saíram como "variável morta" no mesmo commit que criou a trava), e ela nunca
 * disparava no caminho de instalação que o README ensina: o `/mcp` de quem
 * protegia o servidor com `MCP_PUBLIC_KEY` abria em silêncio ao subir de versão
 * (relatório 074, `docs/09-mcp-padrao-e-skills-flutuantes.md` §3.4).
 *
 * Elas NÃO configuram nada. Estão no compose só para a trava enxergar o resíduo.
 * Este teste falha quando a próxima faxina as tirar de lá outra vez.
 *
 * Lê o arquivo como texto, sem parser de YAML: o projeto não tem um nas
 * dependências, e o que importa aqui são três linhas de um bloco.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** Sobe da pasta do teste até a raiz do monorepo (mesmo critério de `arquivosCopiados.test.ts`). */
function raizDoRepo(): string {
  let pasta = dirname(fileURLToPath(import.meta.url));
  for (let salto = 0; salto < 12; salto += 1) {
    if (existsSync(resolve(pasta, 'vitest.config.ts')) && existsSync(resolve(pasta, 'AGENTS.md'))) {
      return pasta;
    }
    const pai = dirname(pasta);
    if (pai === pasta) break;
    pasta = pai;
  }
  throw new Error(`raiz do monorepo não encontrada a partir de ${fileURLToPath(import.meta.url)}`);
}

/** O bloco do serviço no compose: da linha `  <nome>:` até o próximo serviço (ou o fim). */
function blocoDoServico(compose: string, nome: string): string {
  const linhas = compose.split('\n');
  const inicio = linhas.findIndex((linha) => linha === `  ${nome}:`);
  if (inicio < 0) throw new Error(`serviço "${nome}" não encontrado no docker-compose.yml`);
  // Outra chave com dois espaços de recuo é o próximo serviço; sem recuo, o fim de `services`.
  const resto = linhas.slice(inicio + 1);
  const fim = resto.findIndex((linha) => /^( {2})?[A-Za-z0-9_-]+:/.test(linha));
  return resto.slice(0, fim < 0 ? undefined : fim).join('\n');
}

const LEGADAS = ['MCP_PUBLIC_AUTH', 'MCP_PUBLIC_KEY', 'MCP_PUBLIC_KEY_FILE'];

describe('o compose entrega à trava de boot as variáveis do antigo MCP principal', () => {
  const compose = readFileSync(resolve(raizDoRepo(), 'docker-compose.yml'), 'utf8');
  const mcpPublic = blocoDoServico(compose, 'mcp-public');

  it.each(LEGADAS)('%s está no environment do mcp-public, com padrão vazio', (nome) => {
    // Padrão vazio de propósito: vazio conta como ausente na trava, então quem
    // não define a variável sobe como sempre. Um padrão preenchido derrubaria
    // o boot de toda instalação.
    const esperado = new RegExp(`^ {6}${nome}: \\$\\{${nome}:-\\}\\s*$`, 'm');
    if (!esperado.test(mcpPublic)) {
      expect.fail(
        `docker-compose.yml: falta "${nome}: \${${nome}:-}" no environment do serviço mcp-public.\n` +
          'Ela não configura nada — está lá só para a trava de boot (assertNoLegacyAuthEnv) enxergar o\n' +
          'resíduo do .env de quem protegia o /mcp antes do 011. Sem ela, a trava fica inerte sob o compose\n' +
          'e o vMCP "public" do backfill abre em silêncio (relatório 074, docs/09 §3.4). Devolva a linha.',
      );
    }
  });

  it('nenhum outro serviço as recebe', () => {
    const fora = compose.replace(mcpPublic, '');
    for (const nome of LEGADAS) {
      expect(fora, `${nome} só tem sentido no mcp-public`).not.toMatch(new RegExp(`^\\s+${nome}:`, 'm'));
    }
  });
});

/**
 * O outro fio do mesmo compose: o teto do corpo JSON (relatório 029 da auditoria
 * de 2026-09-19).
 *
 * Os dois MCPs leem `MCP_JSON_LIMIT`, com padrões diferentes de propósito — 1mb
 * aqui, que é a superfície anônima, e 48mb no admin, que recebe `.zip` em
 * base64. Enquanto os dois serviços interpolavam a **mesma** variável do `.env`,
 * quem a preenchia para subir o teto do admin abria os mesmos megabytes a
 * qualquer anônimo. O nome no `.env` é por serviço, como o `MCP_SERVER_NAME`; o
 * antigo segue valendo só como queda do admin. Este teste falha quando alguém
 * "simplificar" as duas linhas de volta para uma variável só.
 */
describe('o teto do corpo JSON tem um nome por serviço no .env', () => {
  const raiz = raizDoRepo();
  const compose = readFileSync(resolve(raiz, 'docker-compose.yml'), 'utf8');
  const linhaDoLimite = (servico: string): string | undefined =>
    blocoDoServico(compose, servico)
      .split('\n')
      .find((linha) => /^ {6}MCP_JSON_LIMIT:/.test(linha));

  it('o mcp-public só lê MCP_PUBLIC_JSON_LIMIT: o teto do admin não chega à superfície anônima', () => {
    expect(linhaDoLimite('mcp-public')).toBe('      MCP_JSON_LIMIT: ${MCP_PUBLIC_JSON_LIMIT:-}');
  });

  it('o mcp-admin lê MCP_ADMIN_JSON_LIMIT, e o nome antigo só como queda', () => {
    expect(linhaDoLimite('mcp-admin')).toBe('      MCP_JSON_LIMIT: ${MCP_ADMIN_JSON_LIMIT:-${MCP_JSON_LIMIT:-}}');
  });

  it('o .env.example oferece as duas, vazias, e não mais a variável única', () => {
    const exemplo = readFileSync(resolve(raiz, '.env.example'), 'utf8');

    expect(exemplo).toMatch(/^MCP_PUBLIC_JSON_LIMIT=$/m);
    expect(exemplo).toMatch(/^MCP_ADMIN_JSON_LIMIT=$/m);
    expect(exemplo).not.toMatch(/^#? ?MCP_JSON_LIMIT=/m);
  });
});

/**
 * E o teto do texto inline (relatório 032 da mesma auditoria): a variável só
 * chegava ao mcp-public, e o mcp-admin — que passou a ter a mesma guarda em
 * `get_file` e `get_skill` — ficaria preso ao padrão compilado. A variável
 * própria do admin existe para o operador subir a leitura do agente
 * administrativo sem abrir o mesmo teto à superfície anônima.
 */
describe('o teto do texto inline chega aos dois MCPs', () => {
  const compose = readFileSync(resolve(raizDoRepo(), 'docker-compose.yml'), 'utf8');
  const linhaDoTeto = (servico: string): string | undefined =>
    blocoDoServico(compose, servico)
      .split('\n')
      .find((linha) => /^ {6}MCP_MAX_FILE_TEXT_BYTES:/.test(linha));

  it('o mcp-public lê MCP_MAX_FILE_TEXT_BYTES', () => {
    expect(linhaDoTeto('mcp-public')).toBe('      MCP_MAX_FILE_TEXT_BYTES: ${MCP_MAX_FILE_TEXT_BYTES:-}');
  });

  it('o mcp-admin lê a própria e, sem ela, a do público', () => {
    expect(linhaDoTeto('mcp-admin')).toBe(
      '      MCP_MAX_FILE_TEXT_BYTES: ${MCP_ADMIN_MAX_FILE_TEXT_BYTES:-${MCP_MAX_FILE_TEXT_BYTES:-}}',
    );
  });
});

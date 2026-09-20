/**
 * Guarda do que a homepage AFIRMA sobre o projeto.
 *
 * Por que existe: a homepage é estática — não lê banco nem API —, então todo
 * número dela é constante de código, e constante de código envelhece calada.
 * "17 ferramentas MCP", "doze ferramentas do MCP admin" e "cinco containers"
 * eram medições exatas no commit em que nasceram e foram ultrapassadas em três
 * dias; a receita de instalação mandava trocar dois `CHANGE_ME` quando o painel
 * recusa subir com um terceiro (`tasks/067-HOMEPAGE-DESMENTIDA-PELO-CODIGO.md`).
 * Aqui a afirmação é lida do componente e conferida contra o que a sustenta.
 *
 * Mora no `src/` do servidor, e não no `web/src/`, pelo mesmo motivo do
 * `apps/site/src/arquivosCopiados.test.ts`: lê o disco, e o `web/tsconfig.json`
 * é só de navegador (`types: ["vite/client"]`) e não conhece `node:fs`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** Sobe da pasta do teste até a raiz do monorepo. */
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

const RAIZ = raizDoRepo();
const ESTE_TESTE = relative(RAIZ, fileURLToPath(import.meta.url));
const LANDING = 'apps/homepage/web/src/components/landing';

const ler = (caminho: string): string => readFileSync(resolve(RAIZ, caminho), 'utf8');

/** O item de `ITEMS` do `Stats.tsx` com este rótulo: o número e o sufixo que a página mostra. */
function numeroDoStats(label: string): { value: number; suffix: string } {
  const item = new RegExp(
    `\\{\\s*value:\\s*(\\d+),\\s*suffix:\\s*'([^']*)',\\s*label:\\s*'${label}'\\s*\\}`,
  ).exec(ler(`${LANDING}/Stats.tsx`));
  if (!item) {
    expect.fail(
      `\n${LANDING}/Stats.tsx não tem mais o item "${label}" na forma esperada.\n` +
        `Se a afirmação mudou de propósito, atualize a conferência dela em ${ESTE_TESTE} —\n` +
        'número novo na homepage entra junto com o que o sustenta no código.\n',
    );
  }
  return { value: Number(item[1]), suffix: item[2]! };
}

describe('o que a homepage afirma sobre o projeto', () => {
  it('"ferramentas MCP" não passa do que os dois servidores registram', () => {
    const servidores = ['apps/mcp-admin/src/server.ts', 'apps/mcp-public/src/server.ts'];
    const porServidor = servidores.map((arquivo) => (ler(arquivo).match(/\bregisterTool\(/g) ?? []).length);
    const registradas = porServidor.reduce((soma, n) => soma + n, 0);
    const { value, suffix } = numeroDoStats('ferramentas MCP');

    // Com "+" o número é piso; sem, é contagem exata — e aí envelhece a cada tool.
    const sustenta = suffix === '+' ? registradas >= value : registradas === value;
    if (!sustenta) {
      expect.fail(
        `\nA homepage anuncia "${value}${suffix} ferramentas MCP", e o código registra ${registradas} ` +
          `(${servidores.map((arquivo, i) => `${arquivo}: ${porServidor[i]}`).join('; ')}).\n` +
          `Acerte o item em ${LANDING}/Stats.tsx — de preferência como piso ("N+"), que não\n` +
          'envelhece a cada ferramenta nova — e confira a frase do cartão "Painel e MCP\n' +
          `administrativo" em ${LANDING}/Features.tsx.\n`,
      );
    }
  });

  it('"imagens Docker" é a conta das imagens do projeto nos dois composes', () => {
    const imagens = new Set<string>();
    for (const compose of ['docker-compose.yml', 'database/docker-compose.yml']) {
      for (const achada of ler(compose).matchAll(/^\s*image:\s*tmsoftbrasil\/(purple-skills-[a-z0-9-]+)/gm)) {
        imagens.add(achada[1]!);
      }
    }
    const { value } = numeroDoStats('imagens Docker');

    if (imagens.size !== value) {
      expect.fail(
        `\nA homepage anuncia "${value} imagens Docker", e os composes usam ${imagens.size} imagens do ` +
          `projeto:\n  ${[...imagens].sort().join(', ')}\n` +
          `Acerte o item em ${LANDING}/Stats.tsx e a lista do README ("Imagens no Docker Hub").\n`,
      );
    }
  });

  it('a receita de 60 segundos nomeia todo CHANGE_ME que a instalação precisa trocar', () => {
    const env = ler('.env.example');
    const finale = ler(`${LANDING}/Finale.tsx`);

    // As chaves do RAG também nascem `CHANGE_ME`, mas a busca semântica é opcional
    // e vem desligada: quem não a usa não troca nada ali.
    const aTrocar = [...env.matchAll(/^([A-Z][A-Z0-9_]*)=CHANGE_ME$/gm)]
      .map((linha) => linha[1]!)
      .filter((nome) => !nome.startsWith('RAG_'));
    expect(aTrocar.length).toBeGreaterThan(0);

    const faltando = aTrocar.filter((nome) => !finale.includes(nome));
    if (faltando.length > 0) {
      expect.fail(
        `\nO bloco "bash — 60 segundos" de ${LANDING}/Finale.tsx não cita ${faltando.join(', ')},\n` +
          'que sai do .env.example como CHANGE_ME. O painel e o mcp-admin RECUSAM subir com o\n' +
          'placeholder nas credenciais (`assertNotPlaceholder`, packages/shared/src/secrets.ts):\n' +
          'quem segue a receita à risca fica com o container em ciclo de reinício.\n' +
          'Acrescente o nome ao comentário do bloco — e ao "Começando em 60 segundos" do README.\n',
      );
    }

    // O avesso: variável citada na receita que o `.env.example` não tem mais.
    const citadas = [...new Set(finale.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) ?? [])].filter(
      (nome) => nome !== 'CHANGE_ME',
    );
    const inexistentes = citadas.filter((nome) => !new RegExp(`^${nome}=`, 'm').test(env));
    if (inexistentes.length > 0) {
      expect.fail(
        `\n${LANDING}/Finale.tsx cita ${inexistentes.join(', ')}, que não existe no .env.example.\n` +
          'A variável foi renomeada ou removida? Acerte a receita da homepage.\n',
      );
    }
  });
});

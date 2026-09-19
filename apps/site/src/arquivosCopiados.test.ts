/**
 * Guarda dos arquivos que são cópia byte a byte entre apps.
 *
 * Por que existe: copiar um desses arquivos para o app errado apaga uma
 * interface inteira e "funciona" — só fica errado
 * (`tasks/043-AGENTS-MANDA-COPIAR-CSS-DO-PAINEL.md`). A regra de quem copia de
 * quem morava só no `AGENTS.md` e no `docs/04-design-system.md`; aqui ela falha
 * no CI quando um lado do par muda sozinho, é renomeado ou desaparece.
 *
 * Os pares saem da tabela do `docs/04-design-system.md`. O site é a **origem**
 * de todas as cópias, nunca o destino.
 *
 * Mora no site porque é dele que partem todas as cópias, e no `src/` do servidor
 * (não no `web/src/`) porque lê o disco: o `web/tsconfig.json` é só de navegador
 * (`types: ["vite/client"]`) e não conhece `node:fs`. O `vitest.config.ts` já
 * coleta todo `*.test.ts` dentro de um `src/` de app, então não precisou de
 * configuração nova.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** Sobe da pasta do teste até a raiz do monorepo, para os pares ficarem legíveis. */
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
  throw new Error(
    `raiz do monorepo não encontrada a partir de ${fileURLToPath(import.meta.url)} — ` +
      'o teste dos arquivos copiados precisa dela para montar os caminhos dos pares.',
  );
}

const RAIZ = raizDoRepo();

/** Caminho deste arquivo, citado nas mensagens de falha para quem precisar editar a lista. */
const ESTE_TESTE = relative(RAIZ, fileURLToPath(import.meta.url));

type Par = {
  /** Nome curto do arquivo, só para o título do teste e a primeira linha do erro. */
  arquivo: string;
  /** De onde se copia, relativo à raiz do repositório. */
  origem: string;
  /** Para onde se copia. */
  copia: string;
  /** Uma linha dizendo por que os dois têm de ser iguais, para quem lê a falha. */
  motivo: string;
};

const ENTRE_SITE_E_HOMEPAGE =
  'Par: tokens.css, base.css e chrome.css são cópia byte a byte entre a homepage e o site, ' +
  'e só entre esses dois — o painel tem paleta própria e fica fora dessa cópia.';

const PARES: Par[] = [
  // Os três primeiros: homepage ↔ site. O painel NÃO entra (docs/04 e docs/10).
  {
    arquivo: 'tokens.css',
    origem: 'apps/site/web/src/styles/tokens.css',
    copia: 'apps/homepage/web/src/styles/tokens.css',
    motivo: ENTRE_SITE_E_HOMEPAGE,
  },
  {
    arquivo: 'base.css',
    origem: 'apps/site/web/src/styles/base.css',
    copia: 'apps/homepage/web/src/styles/base.css',
    motivo: ENTRE_SITE_E_HOMEPAGE,
  },
  {
    arquivo: 'chrome.css',
    origem: 'apps/site/web/src/styles/chrome.css',
    copia: 'apps/homepage/web/src/styles/chrome.css',
    motivo: ENTRE_SITE_E_HOMEPAGE,
  },
  // markdown.css: o único CSS que o painel compartilha com o site.
  {
    arquivo: 'markdown.css',
    origem: 'apps/site/web/src/styles/markdown.css',
    copia: 'apps/admin/web/src/styles/markdown.css',
    motivo:
      'Par: markdown.css é cópia byte a byte entre o site e o painel — é o único CSS ' +
      'compartilhado com o painel, apoiado nos aliases do tokens.css dele.',
  },
  // Módulos da árvore de arquivos e da caixa do prompt: site ↔ painel.
  {
    arquivo: 'fileTree.ts',
    origem: 'apps/site/web/src/fileTree.ts',
    copia: 'apps/admin/web/src/fileTree.ts',
    motivo:
      'Par: fileTree.ts e FileTypeIcon.tsx são cópia idêntica entre o site e o painel, ' +
      'que desenham a mesma árvore de arquivos da skill (docs/04, "Árvore de arquivos").',
  },
  {
    arquivo: 'FileTypeIcon.tsx',
    origem: 'apps/site/web/src/components/FileTypeIcon.tsx',
    copia: 'apps/admin/web/src/components/FileTypeIcon.tsx',
    motivo:
      'Par: fileTree.ts e FileTypeIcon.tsx são cópia idêntica entre o site e o painel, ' +
      'que desenham a mesma árvore de arquivos da skill (docs/04, "Árvore de arquivos").',
  },
  {
    arquivo: 'frontmatter.ts',
    origem: 'apps/site/web/src/frontmatter.ts',
    copia: 'apps/admin/web/src/frontmatter.ts',
    motivo:
      'Par: frontmatter.ts (monta o SKILL.md) e Markdown.tsx (renderiza) são cópia ' +
      'idêntica entre o site e o painel. Só o SkillDoc.tsx diverge, pelos ícones.',
  },
  {
    arquivo: 'Markdown.tsx',
    origem: 'apps/site/web/src/components/Markdown.tsx',
    copia: 'apps/admin/web/src/components/Markdown.tsx',
    motivo:
      'Par: frontmatter.ts (monta o SKILL.md) e Markdown.tsx (renderiza) são cópia ' +
      'idêntica entre o site e o painel. Só o SkillDoc.tsx diverge, pelos ícones.',
  },
  // useTheme.ts é o único copiado nos três apps: um por app, arquivos idênticos.
  {
    arquivo: 'useTheme.ts',
    origem: 'apps/site/web/src/useTheme.ts',
    copia: 'apps/homepage/web/src/useTheme.ts',
    motivo:
      'Par: useTheme.ts é um por app e idêntico nos três (docs/04, "Tema claro e escuro"); ' +
      'o site é a origem das duas cópias.',
  },
  {
    arquivo: 'useTheme.ts',
    origem: 'apps/site/web/src/useTheme.ts',
    copia: 'apps/admin/web/src/useTheme.ts',
    motivo:
      'Par: useTheme.ts é um por app e idêntico nos três (docs/04, "Tema claro e escuro"); ' +
      'o site é a origem das duas cópias.',
  },
];

/** Mensagem de quem divergiu de quem, e o comando de cópia na direção certa. */
function mensagemDivergencia(par: Par): string {
  return [
    '',
    `${par.arquivo} deixou de ser cópia byte a byte.`,
    '',
    `  origem: ${par.origem}`,
    `  cópia:  ${par.copia}`,
    '',
    par.motivo,
    '',
    'Para sincronizar, copie da origem para a cópia — exatamente nesta direção:',
    '',
    `  cp ${par.origem} ${par.copia}`,
    '',
    'Se a versão certa é a da cópia, leve a mudança para a origem primeiro e só então',
    'rode o cp acima: o site é a origem de todas as cópias, nunca o destino.',
    'Regras em AGENTS.md (seção do visual, "quem copia de quem") e docs/04-design-system.md.',
    '',
  ].join('\n');
}

/** Mensagem de par incompleto: renomear ou apagar um lado é o mesmo defeito. */
function mensagemFaltando(par: Par, ausente: string): string {
  const outro = ausente === par.origem ? par.copia : par.origem;
  return [
    '',
    `${par.arquivo} perdeu um lado do par: ${ausente} não existe.`,
    '',
    `  o par dele é: ${outro}`,
    '',
    par.motivo,
    '',
    'Renomear, mover ou apagar um lado é o mesmo defeito que deixar o par divergir —',
    'a cópia para de existir sem ninguém notar. Restaure o arquivo que falta (ou desfaça',
    'o rename nos dois lados de uma vez). Depois confira com:',
    '',
    `  cp ${par.origem} ${par.copia}`,
    '',
    `Se a remoção foi de propósito, tire o par da lista em ${ESTE_TESTE} e atualize,`,
    'no mesmo commit, o docs/04-design-system.md e a seção do visual do AGENTS.md.',
    '',
  ].join('\n');
}

describe('arquivos que são cópia byte a byte entre apps', () => {
  for (const par of PARES) {
    it(`${par.copia} é cópia byte a byte de ${par.origem}`, () => {
      const origem = resolve(RAIZ, par.origem);
      const copia = resolve(RAIZ, par.copia);

      // `expect.fail` em vez de `expect(...).toBe(true)` de propósito: assim a
      // saída do CI é só a mensagem, sem o "expected false to be true" no fim —
      // quem vê o erro não deveria precisar abrir este arquivo.
      //
      // Par sem um dos lados: renomear ou apagar é o mesmo defeito que divergir.
      if (!existsSync(origem)) expect.fail(mensagemFaltando(par, par.origem));
      if (!existsSync(copia)) expect.fail(mensagemFaltando(par, par.copia));

      // Comparação de bytes, não de texto: pega também fim de linha e BOM.
      if (!readFileSync(copia).equals(readFileSync(origem))) expect.fail(mensagemDivergencia(par));
    });
  }
});

/** Mensagem do estrago que o 043 descreve: o painel sobrescrito com o CSS do site. */
function mensagemPainelSobrescrito(arquivo: string): string {
  return [
    '',
    `apps/admin/web/src/styles/${arquivo} ficou idêntico ao do site — o painel foi sobrescrito.`,
    '',
    'O painel é um console com paleta própria desde o docs/10-admin-canvas-e-sessoes.md:',
    'ele NÃO entra na cópia de tokens.css, base.css e chrome.css. Sobrescrevê-lo com os',
    'arquivos do site apaga o visual do console inteiro — e "funciona", só fica errado',
    '(tasks/043-AGENTS-MANDA-COPIAR-CSS-DO-PAINEL.md).',
    '',
    `Desfaça a cópia: recupere apps/admin/web/src/styles/${arquivo} da versão versionada,`,
    'em vez de copiar o do site por cima. A única cópia válida entre o site e o painel',
    'no CSS é o markdown.css.',
    '',
  ].join('\n');
}

/**
 * O avesso do bloco de cima: aqui a falha é a cópia ter sido feita. É o estrago
 * do 043 — o painel fica igual ao site e ninguém vê o erro no build.
 */
describe('o painel fica fora da cópia de tokens.css, base.css e chrome.css', () => {
  for (const arquivo of ['tokens.css', 'base.css']) {
    it(`${arquivo} do painel continua divergindo do site`, () => {
      const site = resolve(RAIZ, `apps/site/web/src/styles/${arquivo}`);
      const painel = resolve(RAIZ, `apps/admin/web/src/styles/${arquivo}`);

      if (!existsSync(painel)) {
        expect.fail(
          `\napps/admin/web/src/styles/${arquivo} não existe: o painel tem os seus próprios ` +
            `tokens.css e base.css (docs/04-design-system.md). Restaure o arquivo — e não o ` +
            `substitua pelo do site, que apagaria o visual do console.\n`,
        );
      }

      if (readFileSync(painel).equals(readFileSync(site))) {
        expect.fail(mensagemPainelSobrescrito(arquivo));
      }
    });
  }

  it('o painel não tem chrome.css', () => {
    if (existsSync(resolve(RAIZ, 'apps/admin/web/src/styles/chrome.css'))) {
      expect.fail(
        '\napps/admin/web/src/styles/chrome.css apareceu. O chrome.css é a nav flutuante e o ' +
          'rodapé do site e da homepage; o console usa shell.css (sidebar, barra superior, palco).\n' +
          'Se ele veio de um cp do site, apague-o: o painel não entra nessa cópia ' +
          '(docs/04-design-system.md e tasks/043-AGENTS-MANDA-COPIAR-CSS-DO-PAINEL.md).\n',
      );
    }
  });
});

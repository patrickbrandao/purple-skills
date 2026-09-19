import { describe, expect, it } from 'vitest';
import { languageFor, languageLabel, readLineCount, toCodeLines, type CodeLine } from './highlight.js';

const text = (line: CodeLine) => line.map((token) => token.text).join('');
const classOf = (line: CodeLine, piece: string) => line.find((token) => token.text.includes(piece))?.className;

describe('languageFor', () => {
  it('reconhece as extensões mais comuns numa skill', () => {
    expect(languageFor('SKILL.md')).toBe('markdown');
    expect(languageFor('scripts/run.py')).toBe('python');
    expect(languageFor('src/index.ts')).toBe('typescript');
    expect(languageFor('web/App.tsx')).toBe('typescript');
    expect(languageFor('lib/Cliente.php')).toBe('php');
    expect(languageFor('config.yml')).toBe('yaml');
    expect(languageFor('pyproject.toml')).toBe('ini');
    expect(languageFor('templates/mail.html.j2')).toBe('django');
    expect(languageFor('install.PS1')).toBe('powershell');
  });

  it('reconhece arquivos pelo nome inteiro', () => {
    expect(languageFor('docker/Dockerfile')).toBe('dockerfile');
    expect(languageFor('Makefile')).toBe('makefile');
    expect(languageFor('CMakeLists.txt')).toBe('cmake');
    expect(languageFor('.env')).toBe('ini');
    expect(languageFor('.env.example')).toBe('ini');
  });

  it('usa o shebang quando o nome não diz a linguagem', () => {
    expect(languageFor('scripts/deploy', '#!/bin/bash\necho oi\n')).toBe('bash');
    expect(languageFor('bin/tool', '#!/usr/bin/env python3.12\nprint(1)')).toBe('python');
    expect(languageFor('bin/dev', '#!/usr/bin/env -S uv run --script\n')).toBe('python');
    expect(languageFor('bin/cli', '#!/usr/bin/env node\n')).toBe('javascript');
    // o nome vale mais que o shebang
    expect(languageFor('notas.md', '#!/bin/bash\n')).toBe('markdown');
  });

  it('deixa em texto puro o que não reconhece', () => {
    expect(languageFor('LICENSE')).toBeNull();
    expect(languageFor('dados.csv')).toBeNull();
    expect(languageFor('notas.txt')).toBeNull();
    expect(languageFor('rotina.m')).toBeNull();
    expect(languageFor('arquivo', 'sem shebang')).toBeNull();
    expect(languageFor('.gitignore')).toBeNull();
  });
});

describe('languageLabel', () => {
  it('dá nome de gente às gramáticas', () => {
    expect(languageLabel('typescript')).toBe('TypeScript');
    expect(languageLabel('php')).toBe('PHP');
    expect(languageLabel(null)).toBe('Texto');
  });
});

describe('toCodeLines', () => {
  it('colore com as classes do prefixo do painel', () => {
    const view = toCodeLines('def soma(a, b):\n    return a + b\n', 'python');
    expect(view.colored).toBe(true);
    expect(view.total).toBe(2);
    expect(view.lines).toHaveLength(2);
    expect(classOf(view.lines[0]!, 'def')).toBe('sx-keyword');
    expect(classOf(view.lines[0]!, 'soma')).toBe('sx-title function_');
    expect(text(view.lines[1]!)).toBe('    return a + b');
  });

  it('repete a classe de um bloco que atravessa linhas', () => {
    const view = toCodeLines('/* um\ndois */\nconst x = 1;', 'typescript');
    expect(view.lines.map(text)).toEqual(['/* um', 'dois */', 'const x = 1;']);
    expect(view.lines[0]![0]!.className).toBe('sx-comment');
    expect(view.lines[1]![0]!.className).toBe('sx-comment');
  });

  it('colore o frontmatter do markdown como YAML', () => {
    const view = toCodeLines('---\nname: commit\ntags: [git]\n---\n\n# Título\n', 'markdown');
    expect(view.lines.map(text)).toEqual(['---', 'name: commit', 'tags: [git]', '---', '', '# Título']);
    expect(classOf(view.lines[1]!, 'name')).toBe('sx-attr');
    expect(classOf(view.lines[5]!, 'Título')).toBe('sx-section');
    // sem o fecho, é tudo markdown
    const open = toCodeLines('---\nname: x', 'markdown');
    expect(classOf(open.lines[1]!, 'name')).toBeUndefined();
  });

  it('no YAML, literal no meio de uma frase é só palavra', () => {
    const [frase, sim, lista, item] = toCodeLines(
      'description: Escreve commits no padrão, versão 2 da API\nativa: no\nlista: [yes, 3]\n- texto no meio',
      'yaml',
    ).lines;
    expect(frase).toEqual([
      { text: 'description:', className: 'sx-attr' },
      { text: ' ' },
      { text: 'Escreve commits no padrão, versão 2 da API', className: 'sx-string' },
    ]);
    expect(classOf(sim!, 'no')).toBe('sx-literal');
    expect(classOf(lista!, 'yes')).toBe('sx-literal');
    expect(classOf(lista!, '3')).toBe('sx-number');
    expect(item!.at(-1)).toEqual({ text: 'texto no meio', className: 'sx-string' });
  });

  it('mantém linhas vazias e não inventa uma no fim', () => {
    const view = toCodeLines('# Título\r\n\r\nTexto\r\n', 'markdown');
    expect(view.lines.map(text)).toEqual(['# Título', '', 'Texto']);
    expect(view.lines[1]).toEqual([]);
    expect(view.total).toBe(3);
  });

  it('só a última quebra some', () => {
    expect(toCodeLines('a\n\n', null).lines.map(text)).toEqual(['a', '']);
    expect(toCodeLines('', null).lines).toEqual([[]]);
    for (const content of ['', 'a', 'a\n', 'a\n\n', 'a\r\nb\r\n']) {
      expect(readLineCount(content), JSON.stringify(content)).toBe(toCodeLines(content, null).total);
    }
  });

  it('texto puro sai em um pedaço por linha, sem classe', () => {
    const view = toCodeLines('nome,idade\nana,30', null);
    expect(view.colored).toBe(false);
    expect(view.lines).toEqual([[{ text: 'nome,idade' }], [{ text: 'ana,30' }]]);
  });

  it('corta nas linhas máximas e conta o total', () => {
    const content = Array.from({ length: 30 }, (_, index) => `linha ${index + 1}`).join('\n');
    const view = toCodeLines(content, 'markdown', { maxLines: 10 });
    expect(view.lines).toHaveLength(10);
    expect(view.total).toBe(30);
    expect(text(view.lines[9]!)).toBe('linha 10');
  });

  it('não colore um trecho grande demais', () => {
    const view = toCodeLines('const x = 1;\n'.repeat(20), 'typescript', { maxChars: 50 });
    expect(view.colored).toBe(false);
    expect(view.language).toBe('typescript');
    expect(view.lines).toHaveLength(20);
  });

  it('uma gramática desconhecida não quebra a leitura', () => {
    const view = toCodeLines('qualquer coisa', 'cobol-inexistente');
    expect(view.colored).toBe(false);
    expect(view.lines.map(text)).toEqual(['qualquer coisa']);
  });

  it('nunca devolve HTML: o texto sai como está', () => {
    const view = toCodeLines('<script>alert("x")</script>', 'xml');
    expect(view.lines.map(text)).toEqual(['<script>alert("x")</script>']);
  });
});

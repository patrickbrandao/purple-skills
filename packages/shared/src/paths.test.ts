import { describe, expect, it } from 'vitest';
import {
  contentDisposition,
  isExecutableInlineMime,
  isSkillMd,
  isTextualContent,
  isTextualMime,
  mimeTypeFor,
  normalizeRelativePath,
  safeContentType,
} from './paths.js';

describe('normalizeRelativePath', () => {
  it('mantém caminhos simples', () => {
    expect(normalizeRelativePath('SKILL.md')).toBe('SKILL.md');
    expect(normalizeRelativePath('examples/foo.md')).toBe('examples/foo.md');
  });

  it('normaliza barras invertidas, duplicadas e "./"', () => {
    expect(normalizeRelativePath('examples\\sub\\foo.md')).toBe('examples/sub/foo.md');
    expect(normalizeRelativePath('./examples//foo.md')).toBe('examples/foo.md');
    expect(normalizeRelativePath('/leading/slash.md')).toBe('leading/slash.md');
  });

  it('rejeita travessia de diretório', () => {
    expect(normalizeRelativePath('../etc/passwd')).toBeNull();
    expect(normalizeRelativePath('a/../../b')).toBeNull();
    expect(normalizeRelativePath('C:/windows/system32')).toBeNull();
  });

  it('rejeita caminhos vazios ou absurdamente longos', () => {
    expect(normalizeRelativePath('')).toBeNull();
    expect(normalizeRelativePath('   ')).toBe('   ');
    expect(normalizeRelativePath('/')).toBeNull();
    expect(normalizeRelativePath('a/'.repeat(400))).toBeNull();
  });

  it('canoniza a caixa do arquivo principal', () => {
    expect(normalizeRelativePath('skill.md')).toBe('SKILL.md');
    expect(normalizeRelativePath('Skill.MD')).toBe('SKILL.md');
    expect(normalizeRelativePath('./skill.md')).toBe('SKILL.md');
    expect(normalizeRelativePath('\\SKILL.MD')).toBe('SKILL.md');
  });

  it('não mexe na caixa de outros arquivos nem do SKILL.md em subpasta', () => {
    expect(normalizeRelativePath('docs/skill.md')).toBe('docs/skill.md');
    expect(normalizeRelativePath('README.md')).toBe('README.md');
    expect(normalizeRelativePath('skill.markdown')).toBe('skill.markdown');
  });
});

describe('isSkillMd', () => {
  it('compara sem diferenciar caixa', () => {
    expect(isSkillMd('SKILL.md')).toBe(true);
    expect(isSkillMd('skill.MD')).toBe(true);
    expect(isSkillMd('docs/SKILL.md')).toBe(false);
  });
});

describe('mimeTypeFor', () => {
  it('detecta tipos comuns por extensão', () => {
    expect(mimeTypeFor('SKILL.md')).toBe('text/markdown');
    expect(mimeTypeFor('a/b/logo.png')).toBe('image/png');
    expect(mimeTypeFor('data.json')).toBe('application/json');
    expect(mimeTypeFor('script.sh')).toBe('text/x-shellscript');
  });

  it('trata como texto o código e a configuração que as skills costumam trazer', () => {
    for (const path of ['lib/Cliente.php', 'app.kt', 'run.ps1', 'build.bat', 'tema.scss', 'saida.log', 'setup.cfg', '.env.example', 'mail.j2']) {
      expect(isTextualMime(mimeTypeFor(path)), path).toBe(true);
    }
    expect(mimeTypeFor('lib/Cliente.php')).toBe('text/x-php');
  });

  it('cai para text/plain sem extensão e octet-stream para desconhecidos', () => {
    expect(mimeTypeFor('LICENSE')).toBe('text/plain');
    expect(mimeTypeFor('firmware.bin')).toBe('application/octet-stream');
  });
});

describe('isTextualMime', () => {
  it('classifica corretamente texto e binário', () => {
    expect(isTextualMime('text/markdown')).toBe(true);
    expect(isTextualMime('application/json')).toBe(true);
    expect(isTextualMime('image/svg+xml')).toBe(true);
    expect(isTextualMime('image/png')).toBe(false);
    expect(isTextualMime('application/octet-stream')).toBe(false);
  });
});

describe('isTextualContent', () => {
  // `preço` em Windows-1252: o `ç` é o byte 0xE7 sozinho, que em UTF-8 abriria
  // uma sequência de três bytes e não tem continuação.
  const cp1252 = Buffer.from([0x70, 0x72, 0x65, 0xe7, 0x6f]);

  it('só é texto o que tem mime textual, nenhum byte nulo e UTF-8 válido', () => {
    expect(isTextualContent('text/csv', Buffer.from('preço', 'utf8'))).toBe(true);
    expect(isTextualContent('text/csv', cp1252)).toBe(false);
    expect(isTextualContent('text/markdown', Buffer.from([0x61, 0x00, 0x62]))).toBe(false);
    expect(isTextualContent('image/png', Buffer.from('preço', 'utf8'))).toBe(false);
  });

  it('aceita o vazio e o UTF-8 com BOM', () => {
    expect(isTextualContent('text/plain', Buffer.alloc(0))).toBe(true);
    expect(isTextualContent('text/csv', Buffer.from([0xef, 0xbb, 0xbf, 0x61]))).toBe(true);
  });

  it('recusa UTF-8 malformado que `toString` consertaria calado', () => {
    // Sequência cortada no fim, forma longa demais e surrogate codificado.
    expect(isTextualContent('text/plain', Buffer.from([0x61, 0xc3]))).toBe(false);
    expect(isTextualContent('text/plain', Buffer.from([0xc0, 0x80]))).toBe(false);
    expect(isTextualContent('text/plain', Buffer.from([0xed, 0xa0, 0x80]))).toBe(false);
  });
});

describe('safeContentType', () => {
  it('neutraliza tipos que o navegador executaria na origem', () => {
    expect(safeContentType('text/html', true)).toBe('text/plain; charset=utf-8');
    expect(safeContentType('image/svg+xml', true)).toBe('text/plain; charset=utf-8');
    expect(safeContentType('application/xml', true)).toBe('text/plain; charset=utf-8');
  });

  it("neutraliza script e folha de estilo: como sub-recurso, o `'self'` da CSP aceitaria o arquivo cru", () => {
    // O que `mimeTypeFor` grava para estas extensões é o que a rota crua serve.
    for (const path of ['lib/a.js', 'a.mjs', 'a.cjs', 'a.jsx', 'tema.css']) {
      expect(safeContentType(mimeTypeFor(path), true), path).toBe('text/plain; charset=utf-8');
    }
    // Os outros tipos de JavaScript do padrão: a tabela não os produz hoje, mas
    // o `nosniff` os deixaria rodar do mesmo jeito.
    for (const mime of ['application/javascript', 'application/x-javascript', 'text/ecmascript', 'text/jscript']) {
      expect(safeContentType(mime, true), mime).toBe('text/plain; charset=utf-8');
    }
  });

  it('compara pela essência do tipo: caixa e parâmetros não abrem exceção', () => {
    expect(safeContentType('Text/HTML', true)).toBe('text/plain; charset=utf-8');
    expect(safeContentType('text/javascript; charset=utf-8', true)).toBe('text/plain; charset=utf-8');
    expect(safeContentType(' text/css ', true)).toBe('text/plain; charset=utf-8');
  });

  it('preserva os demais tipos', () => {
    expect(safeContentType('text/markdown', true)).toBe('text/markdown; charset=utf-8');
    expect(safeContentType('image/png', false)).toBe('image/png');
    // Código que o navegador não executa segue com o tipo que o leitor conhece,
    // e a imagem da pré-visualização do painel (`<img src=…?raw>`) não muda.
    expect(safeContentType('text/x-typescript', true)).toBe('text/x-typescript; charset=utf-8');
    expect(safeContentType('application/json', true)).toBe('application/json; charset=utf-8');
    expect(safeContentType('image/jpeg', false)).toBe('image/jpeg');
  });

  it('concorda com isExecutableInlineMime', () => {
    expect(isExecutableInlineMime('text/html')).toBe(true);
    expect(isExecutableInlineMime('text/markdown')).toBe(false);
    // "Inline" é o documento aberto na aba: ali um .js é só texto. Quem o
    // neutraliza é `safeContentType`, pelo risco de sub-recurso.
    expect(isExecutableInlineMime('text/javascript')).toBe(false);
  });
});

describe('contentDisposition', () => {
  it('usa só o nome do arquivo, sem o diretório', () => {
    expect(contentDisposition('examples/foo.md', 'attachment')).toBe(
      'attachment; filename="foo.md"; filename*=UTF-8\'\'foo.md',
    );
  });

  it('saneia aspas, que corromperiam o header', () => {
    const header = contentDisposition('a"b.md', 'attachment');
    expect(header).not.toContain('a"b.md');
    expect(header).toContain('filename="a_b.md"');
  });

  it('carrega o nome original em filename* quando há acentos', () => {
    const header = contentDisposition('anotações.md', 'inline');
    expect(header.startsWith('inline; ')).toBe(true);
    expect(header).toContain(`filename*=UTF-8''${encodeURIComponent('anotações.md')}`);
  });
});

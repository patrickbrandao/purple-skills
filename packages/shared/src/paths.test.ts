import { describe, expect, it } from 'vitest';
import {
  contentDisposition,
  isExecutableInlineMime,
  isSkillMd,
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

describe('safeContentType', () => {
  it('neutraliza tipos que o navegador executaria na origem', () => {
    expect(safeContentType('text/html', true)).toBe('text/plain; charset=utf-8');
    expect(safeContentType('image/svg+xml', true)).toBe('text/plain; charset=utf-8');
    expect(safeContentType('application/xml', true)).toBe('text/plain; charset=utf-8');
  });

  it('preserva os demais tipos', () => {
    expect(safeContentType('text/markdown', true)).toBe('text/markdown; charset=utf-8');
    expect(safeContentType('image/png', false)).toBe('image/png');
  });

  it('concorda com isExecutableInlineMime', () => {
    expect(isExecutableInlineMime('text/html')).toBe(true);
    expect(isExecutableInlineMime('text/markdown')).toBe(false);
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

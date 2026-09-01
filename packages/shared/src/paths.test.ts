import { describe, expect, it } from 'vitest';
import { isSkillMd, isTextualMime, mimeTypeFor, normalizeRelativePath } from './paths.js';

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

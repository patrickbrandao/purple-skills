import AdmZip from 'adm-zip';
import { describe, expect, it } from 'vitest';
import { extractZip, toExtractedFile, zipToBuffer } from './zip.js';

function makeZip(entries: Record<string, Buffer | string>): Buffer {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(entries)) {
    zip.addFile(name, Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'));
  }
  return zip.toBuffer();
}

describe('zipToBuffer', () => {
  it('gera um zip legível preservando os caminhos', async () => {
    const buffer = await zipToBuffer([
      { relativePath: 'SKILL.md', content: '# Olá' },
      { relativePath: 'examples/foo.txt', content: Buffer.from('bar') },
    ]);

    const entries = new AdmZip(buffer).getEntries().map((e) => e.entryName).sort();
    expect(entries).toEqual(['SKILL.md', 'examples/foo.txt']);
    expect(new AdmZip(buffer).getEntry('SKILL.md')!.getData().toString('utf8')).toBe('# Olá');
  });

  it('gera um zip vazio sem falhar', async () => {
    const buffer = await zipToBuffer([]);
    expect(new AdmZip(buffer).getEntries()).toHaveLength(0);
  });
});

describe('extractZip', () => {
  it('extrai arquivos de texto e binários com o mime correto', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
    const files = extractZip(makeZip({ 'SKILL.md': '# Skill', 'img/logo.png': png }));

    const md = files.find((f) => f.relativePath === 'SKILL.md')!;
    expect(md.textContent).toBe('# Skill');
    expect(md.binaryContent).toBeNull();
    expect(md.mimeType).toBe('text/markdown');

    const logo = files.find((f) => f.relativePath === 'img/logo.png')!;
    expect(logo.textContent).toBeNull();
    expect(logo.binaryContent?.equals(png)).toBe(true);
    expect(logo.sizeBytes).toBe(png.byteLength);
  });

  it('remove a pasta raiz única', () => {
    const files = extractZip(makeZip({ 'minha-skill/SKILL.md': '# a', 'minha-skill/ref/b.md': '# b' }));
    expect(files.map((f) => f.relativePath).sort()).toEqual(['SKILL.md', 'ref/b.md']);
  });

  it('preserva a estrutura quando há mais de uma raiz', () => {
    const files = extractZip(makeZip({ 'SKILL.md': '# a', 'ref/b.md': '# b' }));
    expect(files.map((f) => f.relativePath).sort()).toEqual(['SKILL.md', 'ref/b.md']);
  });

  it('ignora lixo de sistema operacional', () => {
    const files = extractZip(makeZip({ 'SKILL.md': '# a', '__MACOSX/._SKILL.md': 'x', '.DS_Store': 'y' }));
    expect(files.map((f) => f.relativePath)).toEqual(['SKILL.md']);
  });

  it('nunca produz um caminho que escape da raiz da skill', () => {
    const files = extractZip(
      makeZip({ '../escapou.md': 'x', '/abs.md': 'y', 'SKILL.md': '# ok' }),
      { stripSingleRootDir: false },
    );

    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(file.relativePath.startsWith('/')).toBe(false);
      expect(file.relativePath.split('/')).not.toContain('..');
    }
    expect(files.map((f) => f.relativePath)).toContain('SKILL.md');
  });
});

describe('toExtractedFile', () => {
  it('trata conteúdo textual com bytes nulos como binário', () => {
    const file = toExtractedFile('notas.md', Buffer.from([0x61, 0x00, 0x62]));
    expect(file.textContent).toBeNull();
    expect(file.binaryContent).not.toBeNull();
  });
});

import type { Response } from 'express';
import archiver from 'archiver';
import type { FileContent } from '@purple-skills/db';
import { composeSkillMd, isSkillMd, type SkillMeta } from '@purple-skills/shared';

/** Envia os arquivos da skill como um ZIP gerado on-the-fly (streaming). */
export function streamSkillZip(
  res: Response,
  slug: string,
  files: readonly FileContent[],
  meta: SkillMeta,
): void {
  const archive = archiver('zip', { zlib: { level: 9 } });

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${slug}.zip"`);
  res.setHeader('Cache-Control', 'no-store');

  archive.on('error', (err) => {
    console.error('[zip] erro ao gerar pacote:', err.message);
    res.destroy(err);
  });

  archive.pipe(res);
  for (const file of files) {
    // O SKILL.md do pacote nasce dos metadados da skill: o que está gravado é
    // só o corpo do prompt.
    const content = isSkillMd(file.relativePath)
      ? Buffer.from(composeSkillMd(meta, file.buffer.toString('utf8')), 'utf8')
      : file.buffer;
    archive.append(content, { name: `${slug}/${file.relativePath}` });
  }
  void archive.finalize();
}

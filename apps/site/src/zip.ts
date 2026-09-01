import type { Response } from 'express';
import archiver from 'archiver';
import type { FileContent } from '@purple-skills/db';

/** Envia os arquivos da skill como um ZIP gerado on-the-fly (streaming). */
export function streamSkillZip(res: Response, slug: string, files: readonly FileContent[]): void {
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
    archive.append(file.buffer, { name: `${slug}/${file.relativePath}` });
  }
  void archive.finalize();
}

import type { Response } from 'express';
import type { FileContent } from '@purple-skills/db';
import { composeSkillMd, isSkillMd, type SkillMeta, writeZip } from '@purple-skills/shared';

/**
 * Envia os arquivos da skill como um pacote ZIP gerado na hora (streaming). O
 * pacote `.skill` é exatamente o mesmo ZIP — só muda a extensão do arquivo
 * baixado, que é o formato aberto de Agent Skills.
 */
export async function streamSkillZip(
  res: Response,
  slug: string,
  files: readonly FileContent[],
  meta: SkillMeta,
  ext: 'zip' | 'skill' = 'zip',
): Promise<void> {
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${slug}.${ext}"`);
  res.setHeader('Cache-Control', 'no-store');

  const entries = files.map((file) => ({
    relativePath: `${slug}/${file.relativePath}`,
    // O SKILL.md do pacote nasce dos metadados da skill: o que está gravado é
    // só o corpo do prompt.
    content: isSkillMd(file.relativePath)
      ? Buffer.from(composeSkillMd(meta, file.buffer.toString('utf8')), 'utf8')
      : file.buffer,
  }));

  try {
    await writeZip(entries, res);
  } catch (err) {
    // O stream já começou: não dá para trocar por uma resposta de erro JSON,
    // só derrubar a conexão e registrar.
    console.error('[admin] erro ao gerar pacote da skill:', (err as Error).message);
    res.destroy(err as Error);
  }
}

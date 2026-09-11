import type { Request, RequestHandler, Response, Router } from 'express';
import {
  getSkillSummary,
  incrementDownloadCount,
  incrementViewCount,
  readAllFiles,
  readFile,
} from '@purple-skills/db';
import {
  composeSkillMd,
  contentDisposition,
  isSkillMd,
  normalizeRelativePath,
  safeContentType,
  writeZip,
} from '@purple-skills/shared';
import { virtualAuth } from './auth.js';

/**
 * Downloads de um MCP virtual — o `.zip` da skill e os arquivos avulsos —
 * servidos pelo próprio mcp-public, sob `/virtual/<slug>/skills/<skill>/…`,
 * com a mesma autenticação do MCP (`docs/08-mcp-virtual.md` §4.3).
 *
 * Existem porque o site só serve skill **pública**, e um virtual pode carregar
 * skill privada: as URLs que `download_skill` e `get_skill_file` devolvem
 * precisam funcionar com a chave que o agente já tem. Espelham as rotas do
 * site, com uma diferença: só a superfície de ferramentas (`as_skill`) entra
 * — quem está no virtual só como prompt ou resource não tem `.zip` aqui, do
 * mesmo jeito que não tem no principal.
 */
export function registrarDownloads(router: Router): void {
  router.get('/skills/:skill/download', virtualAuth, servirZip('zip'));
  router.get('/skills/:skill/download.skill', virtualAuth, servirZip('skill'));
  router.get('/skills/:skill/files/*path', virtualAuth, servirArquivo);
}

const param = (req: Request, name: string): string => {
  const value = (req.params as Record<string, unknown>)[name];
  return Array.isArray(value) ? value.join('/') : String(value ?? '');
};

const notFound = (res: Response, message: string) => {
  res.status(404).json({ error: 'not_found', message });
};

const asyncRoute =
  (handler: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    handler(req, res).catch(next);
  };

const skillDoVirtual = (req: Request) =>
  getSkillSummary(param(req, 'skill'), {
    virtualMcp: { uuid: req.virtual!.mcp.uuid, surface: 'skill' },
  });

/**
 * O pacote — conta um download no vínculo e na skill. `.zip` e `.skill` são o
 * mesmo arquivo com outra extensão (o formato aberto de Agent Skills).
 */
const servirZip = (ext: 'zip' | 'skill') =>
  asyncRoute(async (req, res) => {
    const skill = await skillDoVirtual(req);
    if (!skill) {
      notFound(res, 'Skill não encontrada neste MCP virtual');
      return;
    }

    const files = await readAllFiles(skill.uuid);
    await incrementDownloadCount(skill.uuid, req.virtual!.mcp.uuid);

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${skill.slug}.${ext}"`);
    res.setHeader('Cache-Control', 'no-store');

    await writeZip(
      files.map((file) => ({
        relativePath: `${skill.slug}/${file.relativePath}`,
        // O SKILL.md do pacote nasce dos metadados da skill: o que está
        // gravado é só o corpo do prompt.
        content: isSkillMd(file.relativePath)
          ? composeSkillMd(skill, file.buffer.toString('utf8'))
          : file.buffer,
      })),
      res,
    );
  });

/** Arquivo avulso. Só o SKILL.md conta acesso, como no site. */
const servirArquivo = asyncRoute(async (req, res) => {
  const skill = await skillDoVirtual(req);
  if (!skill) {
    notFound(res, 'Skill não encontrada neste MCP virtual');
    return;
  }

  const path = normalizeRelativePath(param(req, 'path'));
  if (!path) {
    res.status(400).json({ error: 'bad_request', message: 'Caminho inválido' });
    return;
  }

  const file = await readFile(skill.uuid, path);
  if (!file) {
    notFound(res, 'Arquivo não encontrado');
    return;
  }

  let buffer = file.buffer;
  if (isSkillMd(file.relativePath)) {
    buffer = Buffer.from(composeSkillMd(skill, file.buffer.toString('utf8')), 'utf8');
    await incrementViewCount(skill.uuid, req.virtual!.mcp.uuid);
  }

  // Conteúdo de terceiros: tipos executáveis descem como texto, e nada é
  // renderizado inline — a mesma política do site.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Content-Type', safeContentType(file.mimeType, file.isText));
  res.setHeader('Content-Length', String(buffer.byteLength));
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Disposition', contentDisposition(file.relativePath, 'attachment'));
  res.send(buffer);
});

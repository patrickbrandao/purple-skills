import type { ErrorRequestHandler } from 'express';
import multer from 'multer';
import { config } from './config.js';

/**
 * Tratador de erros da API do painel.
 *
 * Erros lançados por middlewares — `multer` num upload acima do limite,
 * `express.json` num corpo malformado — não passam pelo wrapper `route()` das
 * rotas. Sem este handler, o Express responde HTML numa API JSON: o front-end
 * tenta ler `message`, não encontra, e mostra apenas "Erro 500" para o que na
 * verdade é um erro do cliente, com status errado.
 */
export const onError: ErrorRequestHandler = (err, _req, res, _next) => {
  if (res.headersSent) return;

  if (err instanceof multer.MulterError) {
    const tooBig = err.code === 'LIMIT_FILE_SIZE';
    res.status(tooBig ? 413 : 400).json({
      error: tooBig ? 'payload_too_large' : 'bad_request',
      message: tooBig
        ? `Arquivo maior que o limite de ${Math.round(config.maxUploadBytes / (1024 * 1024))} MB`
        : `Upload inválido: ${err.message}`,
    });
    return;
  }

  const type = (err as { type?: string })?.type;
  if (type === 'entity.parse.failed') {
    res.status(400).json({ error: 'invalid_json', message: 'Corpo JSON malformado' });
    return;
  }
  if (type === 'entity.too.large') {
    res
      .status(413)
      .json({ error: 'payload_too_large', message: 'Corpo da requisição grande demais' });
    return;
  }

  const status = Number((err as { status?: number })?.status);
  if (status >= 400 && status < 500) {
    res.status(status).json({ error: 'bad_request', message: 'Requisição inválida' });
    return;
  }

  // Falha de verdade: a mensagem fica no log, o cliente recebe só o código.
  console.error('[admin] erro não tratado:', err);
  res.status(500).json({ error: 'internal_error', message: 'Erro interno' });
};

import { closeDb } from '@purple-skills/db';
import { runCli } from './cli.js';

/**
 * Ponto de entrada do `purple-admin` (`docs/21-cli-admin.md`). A imagem o
 * instala em `/usr/local/bin/purple-admin`; fora dela,
 * `node apps/admin/dist/admin-cli.js <comando>`.
 *
 * Usa o mesmo ambiente do painel (`DATABASE_URL`/`PG*`, via `getDb()`), e por
 * isso roda dentro do container: `docker compose exec admin purple-admin …`.
 */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

let code = 1;
try {
  code = await runCli(process.argv.slice(2), {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    readStdin,
  });
} catch (err) {
  console.error('[purple-admin] falha inesperada:', err instanceof Error ? err.message : err);
} finally {
  await closeDb().catch(() => undefined);
}
process.exitCode = code;

import { config, smtpEnabled, smtpUrl } from './config.js';

/**
 * Envio de e-mail — **opcional**.
 *
 * Sem `SMTP_URL` + `SMTP_FROM` o painel continua inteiro: o "esqueci a senha"
 * passa a explicar que o administrador precisa resetar (§2.6). Isso é o que
 * mantém `docker compose up` funcionando sem infraestrutura de e-mail.
 *
 * O `nodemailer` é carregado sob demanda, no primeiro envio: uma instalação
 * sem SMTP nunca paga o `import`.
 */
type Transport = { sendMail(message: Record<string, unknown>): Promise<unknown> };

let transport: Transport | null = null;

async function getTransport(): Promise<Transport | null> {
  if (!smtpEnabled()) return null;
  if (transport) return transport;

  const nodemailer = await import('nodemailer');
  transport = nodemailer.default.createTransport(smtpUrl() as string) as Transport;
  return transport;
}

export async function sendMail(message: {
  to: string;
  subject: string;
  text: string;
}): Promise<boolean> {
  const mailer = await getTransport();
  if (!mailer) return false;

  await mailer.sendMail({ from: config.smtpFrom, ...message });
  return true;
}

export function passwordResetMessage(name: string, link: string, ttlSeconds: number) {
  const minutes = Math.round(ttlSeconds / 60);
  return {
    subject: `${config.siteName} — redefinição de senha`,
    text:
      `Olá, ${name}.\n\n` +
      `Alguém pediu a redefinição da sua senha no painel do ${config.siteName}.\n` +
      `Se foi você, abra o link abaixo (vale por ${minutes} minutos e só pode ser usado uma vez):\n\n` +
      `${link}\n\n` +
      'Se não foi você, ignore este e-mail: nada muda enquanto o link não for usado.\n',
  };
}

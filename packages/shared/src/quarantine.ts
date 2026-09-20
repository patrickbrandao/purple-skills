/**
 * Quem aprova um envio da quarentena (`docs/15-quarentena.md`).
 *
 * A quarentena é o portão entre o pacote que alguém enviou e o acervo: só a
 * aprovação cria a skill de verdade. Quem tem a chave desse portão é escolha da
 * instalação, não do código — daí a chave `quarantine.approvers` em `settings`.
 *
 * O papel continua limitando a **ação** (submeter exige `canCreate`, ou seja,
 * editor para cima) e o dono continua sendo quem submeteu; o que esta política
 * decide é só **promover**. Admin aprova em qualquer uma das três.
 */
import { canCreate, type Role } from './roles.js';

export type QuarantineApprovers = 'admin' | 'admin+owner' | 'admin+editor';

export const QUARANTINE_APPROVERS: readonly QuarantineApprovers[] = [
  'admin',
  'admin+owner',
  'admin+editor',
];

/** A chave em `settings`; o valor é um dos três acima. */
export const QUARANTINE_APPROVERS_SETTING = 'quarantine.approvers';

/**
 * O padrão da instalação: quem enviou também aprova o que é seu. É o meio
 * termo — o portão existe para o pacote de terceiro, não para atrapalhar quem
 * já podia criar a skill direto pelo formulário.
 */
export const QUARANTINE_APPROVERS_DEFAULT: QuarantineApprovers = 'admin+owner';

export function isQuarantineApprovers(value: unknown): value is QuarantineApprovers {
  return typeof value === 'string' && (QUARANTINE_APPROVERS as readonly string[]).includes(value);
}

export const QUARANTINE_APPROVERS_LABEL: Record<QuarantineApprovers, string> = {
  admin: 'somente administradores',
  'admin+owner': 'administradores e o dono do envio',
  'admin+editor': 'administradores e editores',
};

/**
 * Enxergar a quarentena: o dono do envio, o admin e o editor.
 *
 * O editor vê a fila inteira para poder revisar o que está para ser aprovado —
 * mesmo o que não é dele. Quem perdeu o papel de editor continua vendo (e
 * corrigindo) o que **submeteu**: o envio é dele, e sumir com ele numa troca de
 * papel seria perder trabalho sem aviso.
 */
export function canViewQuarantine(
  role: Role,
  ownerUserUuid: string | null,
  userUuid: string | null,
): boolean {
  if (role === 'admin' || role === 'editor') return true;
  return userUuid !== null && ownerUserUuid === userUuid;
}

/** Editar os arquivos de um envio e apagá-lo: quem o enxerga. */
export const canEditQuarantine = canViewQuarantine;

/**
 * Promover para produção, pela política da instalação.
 *
 * Duas condições além dela, e nenhuma se dispensa:
 *
 * - **enxergar o envio.** A política amplia o portão, nunca o acesso.
 * - **poder criar no acervo** (`canCreate`). Promover *é* criar uma skill, e o
 *   papel limita a ação (`docs/12` decisão 12). Sem isto, a conta rebaixada a
 *   `membro` depois de enviar continuava aprovando o próprio envio na política
 *   padrão — e, como dona da skill que nascia, podia torná-la pública. Medido:
 *   `POST /api/skills` e `POST /api/skills/import` davam 403 para ela, e a
 *   promoção criava a skill assim mesmo. O envio dela continua visível e
 *   editável; o que ela não faz mais é passá-lo ao acervo sozinha.
 *
 * Admin não é afetado por nenhuma das duas, como em todo o resto.
 */
export function canPromoteQuarantine(
  approvers: QuarantineApprovers,
  role: Role,
  ownerUserUuid: string | null,
  userUuid: string | null,
): boolean {
  if (role === 'admin') return true;
  if (!canCreate(role)) return false;
  if (!canViewQuarantine(role, ownerUserUuid, userUuid)) return false;
  if (approvers === 'admin+editor') return role === 'editor';
  if (approvers === 'admin+owner') return userUuid !== null && ownerUserUuid === userUuid;
  return false;
}

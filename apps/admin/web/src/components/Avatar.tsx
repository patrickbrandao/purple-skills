import { useEffect, useState } from 'react';
import { avatarUrl } from '../api.js';
import { cx } from './ui.js';
import { initials } from './SkillIcon.js';

/**
 * O avatar de uma conta: a foto, ou o monograma das iniciais.
 *
 * O monograma **continua sendo o padrão** (`docs/20-perfil.md` decisão 2): ele
 * já existia, funciona sem perfil nenhum e é o que quase toda conta vai mostrar
 * enquanto ninguém enviar foto. Este componente só põe a imagem na frente
 * quando ela existe.
 *
 * A foto aparece **mesmo com o perfil privado**. O `is_public` decide o que sai
 * para o visitante anônimo; dentro do painel, entre contas logadas, o avatar é
 * o que as listas e as fichas sempre mostraram.
 *
 * `stamp` é o `avatarUpdatedAt` do perfil, e `null` significa "sem foto" — é o
 * que evita uma requisição por linha de lista só para descobrir que não há
 * imagem, e é por isso que ele vem junto com o resto do perfil em vez de o
 * componente ir buscá-lo.
 */
export function Avatar({
  username,
  name,
  stamp,
  className,
}: {
  username: string;
  name: string;
  /** `avatarUpdatedAt` da conta; `null` cai no monograma. */
  stamp?: string | null;
  className?: string;
}) {
  /**
   * A imagem falhou (404, rede, formato que o navegador recusou)? Cai no
   * monograma em vez de deixar o ícone quebrado do `<img>`.
   *
   * Não é hipótese remota: entre a leitura que trouxe o carimbo e o desenho da
   * imagem, a foto pode ter sido apagada pelo dono em outra aba ou limpa por um
   * admin.
   *
   * **O `useEffect` é o que torna a falha recuperável, e sem ele havia um
   * travamento real.** O `sniffAvatarMime` aprova pelos bytes iniciais, então
   * um PNG truncado — cabeçalho válido, resto corrompido — é aceito pelo
   * servidor e recusado pelo navegador. A pessoa então envia um PNG bom: o
   * toast diz "Foto atualizada", o `stamp` muda, e a imagem **não voltava** —
   * `falhou` continuava `true` e o componente seguia no monograma até um
   * recarregamento. Em lista, com `key` estável por conta, o travamento durava
   * a sessão inteira naquela linha.
   */
  const [falhou, setFalhou] = useState(false);
  useEffect(() => setFalhou(false), [username, stamp]);
  const src = falhou ? null : avatarUrl(username, stamp ?? null);

  if (src) {
    return (
      <img
        className={cx('avatar', className)}
        src={src}
        alt=""
        /* `alt` vazio e `aria-hidden`: o nome da pessoa está sempre ao lado, e
           um leitor de tela que anunciasse "foto de Ana" antes de "Ana" leria
           a mesma informação duas vezes. */
        aria-hidden
        loading="lazy"
        decoding="async"
        onError={() => setFalhou(true)}
      />
    );
  }

  return (
    <span className={cx('avatar', className)} aria-hidden>
      {initials(name || username)}
    </span>
  );
}

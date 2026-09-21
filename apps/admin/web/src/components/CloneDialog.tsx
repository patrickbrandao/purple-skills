import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { CopyPlus } from 'lucide-react';
import {
  ApiError,
  canCreate,
  canEdit,
  canManage,
  cloneCatalog,
  cloneMcp,
  cloneSkill,
  type CloneBody,
  type EffectiveAccess,
  type Role,
} from '../api.js';
import { slugDaCopia, slugEmDigitacao, slugify } from '../slug.js';
import { Button, Field, Modal } from './ui.js';
import { useToast } from './Toast.js';

/* ============================================================
   Clonar skill, catálogo e MCP virtual (`docs/16-clonagem.md`).

   Duas superfícies e um diálogo só: o cabeçalho da ficha e a linha da lista
   mostram o `CloneButton`; o `CloneDialog` mora na **página**, nunca dentro do
   card nem da célula. O card da lista é um `<a>`, e a janela renderizada lá
   dentro faria cada clique no formulário navegar para a ficha do original.
   ============================================================ */

export type CloneKind = 'skill' | 'catalog' | 'mcp';

/** O mínimo que o botão e o diálogo precisam do objeto clonado. */
export type Clonavel = { slug: string; name: string; access: EffectiveAccess };

type Tipo = {
  /** Como o painel chama o objeto na tela — o mesmo nome dos rótulos da trilha. */
  rotulo: string;
  titulo: string;
  /** O que a cópia leva e o que ela não leva (`docs/16-clonagem.md` §3). */
  leva: string;
  feito: (nome: string) => string;
  clonar: (slug: string, body: CloneBody) => Promise<{ slug: string; name: string }>;
  ficha: (slug: string) => string;
};

const TIPOS: Record<CloneKind, Tipo> = {
  skill: {
    rotulo: 'skill',
    titulo: 'Clonar skill',
    leva: 'A cópia leva as propriedades, os arquivos e as tags. Não leva catálogo, servidor nem acesso concedido: nasce privada e sem vínculo, e é sua.',
    feito: (nome) => `Skill "${nome}" criada como cópia.`,
    clonar: cloneSkill,
    ficha: (slug) => `/skills/${slug}`,
  },
  catalog: {
    rotulo: 'catálogo',
    titulo: 'Clonar catálogo',
    leva: 'A cópia leva os mesmos membros, com a participação de cada um. Não leva os servidores vinculados nem os acessos concedidos: nasce privada, e é sua.',
    feito: (nome) => `Catálogo "${nome}" criado como cópia.`,
    clonar: cloneCatalog,
    ficha: (slug) => `/catalogs/${slug}`,
  },
  mcp: {
    rotulo: 'servidor',
    titulo: 'Clonar servidor',
    leva: 'A cópia leva os vínculos, os catálogos, o canvas e os acessos concedidos. Não leva as chaves nem o posto de MCP padrão: nasce fechada, e é sua.',
    feito: (nome) => `Servidor "${nome}" criado como cópia.`,
    clonar: cloneMcp,
    ficha: (slug) => `/mcps/${slug}`,
  },
};

/**
 * Quem pode clonar: `edit` na skill e no catálogo, `manage` no vMCP — e, em
 * todos, o papel da sessão tem de poder criar. Clonar **cria um objeto novo**,
 * então não basta poder mexer no original: um `membro` não ganha um caminho
 * para criar skills por aqui.
 */
export const podeClonar = (kind: CloneKind, access: EffectiveAccess, role: Role): boolean =>
  canCreate(role) && (kind === 'mcp' ? canManage(access) : canEdit(access));

/**
 * O corpo da chamada: só o que a pessoa **mudou**.
 *
 * Campo intocado não vai. É a regra que faz a clonagem nunca esbarrar em 409
 * por conta própria: sem `slug`, quem desempata é o servidor, que conhece os
 * slugs já usados; a sugestão do campo é um palpite do cliente e pode estar
 * ocupada. Com o nome é o mesmo: igual ao do original, fica de fora.
 */
export function corpoDaClonagem(origem: { slug: string; name: string }, campos: { name: string; slug: string }): CloneBody {
  const name = campos.name.trim();
  const slug = campos.slug.trim();
  return {
    ...(name && name !== origem.name ? { name } : {}),
    ...(slug && slug !== slugDaCopia(origem.slug) ? { slug } : {}),
  };
}

/**
 * O botão de clonar, nas duas superfícies. Some para quem não pode clonar —
 * é o que a linha da lista já faz com Remover, e o que o cabeçalho da ficha já
 * faz com Editar.
 *
 * Não abre nada sozinho: quem guarda o alvo e monta o `CloneDialog` é a
 * página.
 */
export function CloneButton({
  kind,
  object,
  role,
  shape = 'botao',
  onClone,
}: {
  kind: CloneKind;
  object: Clonavel;
  role: Role;
  /** `botao` no cabeçalho da ficha; `linha` no card e na tabela. */
  shape?: 'botao' | 'linha';
  onClone: () => void;
}) {
  if (!podeClonar(kind, object.access, role)) return null;

  const titulo = `Clonar ${TIPOS[kind].rotulo}`;

  // `preventDefault`: no card da lista este botão está dentro de um `<a>`, e
  // sem isso o clique abriria a ficha do original em vez do diálogo.
  const clique = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    onClone();
  };

  if (shape === 'linha') {
    return (
      <button type="button" className="row-action" onClick={clique} title={titulo}>
        <CopyPlus />
      </button>
    );
  }

  return (
    <Button variant="ghost" onClick={clique}>
      <CopyPlus /> Clonar
    </Button>
  );
}

/**
 * O diálogo: Nome e Slug, pré-preenchidos com o do original e a sugestão `-2`.
 * Montado é aberto — a página o monta com o alvo e o desmonta ao fechar.
 *
 * Confirmar leva para a ficha da cópia. O 409 é o único erro que fica: ele é
 * do campo Slug (alguém digitou um que já existe), então volta ali, com a
 * janela aberta e o que foi escrito no lugar.
 */
export function CloneDialog({ kind, origem, onClose }: { kind: CloneKind; origem: Clonavel; onClose: () => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const tipo = TIPOS[kind];
  const [name, setName] = useState(origem.name);
  const [slug, setSlug] = useState(() => slugDaCopia(origem.slug));
  const [busy, setBusy] = useState(false);
  const [erroSlug, setErroSlug] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setErroSlug(null);
    try {
      const copia = await tipo.clonar(origem.slug, corpoDaClonagem(origem, { name, slug }));
      toast.success(tipo.feito(copia.name));
      onClose();
      navigate(tipo.ficha(copia.slug));
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setErroSlug(err.message);
        setBusy(false);
        return;
      }
      toast.error((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal open title={`${tipo.titulo} "${origem.name}"`} onClose={onClose}>
      <form onSubmit={submit} className="mt-3 grid gap-4">
        <Field label="Nome" hint="Como a cópia aparece no painel. Vem igual ao do original: o nome não precisa ser único.">
          <input className="field" value={name} onChange={(event) => setName(event.target.value)} autoFocus />
        </Field>

        <Field
          label="Slug"
          hint={
            erroSlug ? (
              <span style={{ color: 'var(--danger)' }}>{erroSlug}</span>
            ) : (
              'Identifica a cópia na URL e nas ferramentas. Sem mexer aqui, quem escolhe um slug livre é o servidor.'
            )
          }
        >
          <input
            className="field field-mono"
            value={slug}
            // Slugifica enquanto se digita, como os outros campos de slug do
            // painel: o servidor recusa com 400 o slug explícito inválido.
            onChange={(event) => {
              setSlug(slugEmDigitacao(event.target.value));
              setErroSlug(null);
            }}
            onBlur={(event) => {
              const limpo = slugify(event.target.value);
              if (limpo !== slug) setSlug(limpo);
            }}
            aria-invalid={erroSlug ? true : undefined}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
          />
        </Field>

        <p className="hint mb-0">{tipo.leva}</p>

        <div className="actions">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button type="submit" disabled={busy || !name.trim()}>
            {busy ? 'Clonando…' : 'Clonar'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

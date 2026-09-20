import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { Link } from 'react-router-dom';
import { Check, Copy } from 'lucide-react';
import type { SkillMcpRef } from '../api.js';

/* ============================================================
   Primitivos do painel. Tudo é classe de CSS (base.css/shell.css);
   estes componentes só juntam as classes e cuidam do comportamento.
   ============================================================ */

export function Button({
  children,
  variant = 'primary',
  size,
  className = '',
  ...props
}: {
  children: ReactNode;
  variant?: 'primary' | 'ghost' | 'quiet' | 'danger';
  size?: 'sm' | 'lg';
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const classes = ['btn', `btn-${variant}`, size ? `btn-${size}` : '', className]
    .filter(Boolean)
    .join(' ');
  return (
    <button type="button" {...props} className={classes}>
      {children}
    </button>
  );
}

export function Panel({
  children,
  className = '',
  title,
  icon,
  actions,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
  icon?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className={`panel ${className}`.trim()}>
      {title && (
        <div className="panel-head mb-3">
          <h2 className="!mb-0">
            {icon}
            {title}
          </h2>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Field({
  label,
  hint,
  children,
  className = '',
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`block ${className}`.trim()}>
      <span className="label">{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

export type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'accent' | 'info' | 'outline';

export function Badge({
  tone = 'neutral',
  mono,
  title,
  children,
  className = '',
}: {
  tone?: Tone;
  mono?: boolean;
  title?: string;
  children: ReactNode;
  className?: string;
}) {
  const classes = ['badge', tone === 'neutral' ? '' : tone, mono ? 'mono' : '', className]
    .filter(Boolean)
    .join(' ');
  return (
    <span className={classes} title={title}>
      {children}
    </span>
  );
}

export function Status({
  tone,
  pulse,
  children,
  title,
}: {
  tone: 'ok' | 'off' | 'warn' | 'danger';
  pulse?: boolean;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={`status ${tone}`} title={title}>
      <span className={`dot${pulse ? ' pulse' : ''}`} />
      {children}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className = '',
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`empty ${className}`.trim()}>
      {icon}
      <p className="t">{title}</p>
      {description && <p className="d">{description}</p>}
      {action}
    </div>
  );
}

/**
 * A linha única de uma tabela sem itens: o cabeçalho continua no lugar e a
 * mensagem fica no meio. Ação de criar não entra aqui — ela já está na barra
 * da página ou do painel.
 */
export function EmptyRow({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan}>
        <p className="list-empty">{children}</p>
      </td>
    </tr>
  );
}

/** Esqueleto com a forma do conteúdo que vai chegar. */
export function Skel({
  h = 16,
  w,
  className = '',
  style,
}: {
  h?: number | string;
  w?: number | string;
  className?: string;
  style?: React.CSSProperties;
}) {
  return <div className={`skel ${className}`.trim()} style={{ height: h, width: w, ...style }} aria-hidden />;
}

export function CopyButton({
  text,
  label,
  size = 'sm',
  variant = 'ghost',
  title,
}: {
  text: string;
  label?: string;
  size?: 'sm' | 'lg';
  variant?: 'ghost' | 'quiet';
  title?: string;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      window.prompt('Copie:', text);
    }
  };
  if (!label) {
    return (
      <button type="button" className="row-action" title={copied ? 'Copiado' : 'Copiar'} onClick={() => void copy()}>
        {copied ? <Check /> : <Copy />}
      </button>
    );
  }
  return (
    <Button variant={variant} size={size === 'sm' ? 'sm' : undefined} onClick={() => void copy()} title={title} aria-live="polite">
      {copied ? <Check /> : <Copy />} {copied ? 'Copiado' : label}
    </Button>
  );
}

/* ---- abas ---- */
export type TabItem = { key: string; label: string; count?: number; icon?: ReactNode; to?: string };

export function Tabs({
  items,
  value,
  onChange,
  className = '',
}: {
  items: TabItem[];
  value: string;
  onChange?: (key: string) => void;
  className?: string;
}) {
  // Numa tela estreita a barra rola para o lado: a guia ativa fica à vista.
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = bar.current;
    const active = el?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!el || !active) return;
    const box = el.getBoundingClientRect();
    const tab = active.getBoundingClientRect();
    if (tab.left < box.left) el.scrollLeft += tab.left - box.left - 16;
    else if (tab.right > box.right) el.scrollLeft += tab.right - box.right + 16;
  }, [value]);

  return (
    <div ref={bar} className={`tabs ${className}`.trim()} role="tablist">
      {items.map((item) =>
        item.to ? (
          <Link key={item.key} to={item.to} role="tab" aria-selected={value === item.key} className={value === item.key ? 'active' : ''}>
            {item.icon}
            {item.label}
            {item.count !== undefined && <span className="count">{item.count}</span>}
          </Link>
        ) : (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={value === item.key}
            className={value === item.key ? 'active' : ''}
            onClick={() => onChange?.(item.key)}
          >
            {item.icon}
            {item.label}
            {item.count !== undefined && <span className="count">{item.count}</span>}
          </button>
        ),
      )}
    </div>
  );
}

/* ---- menu flutuante (popover) ---- */
export function useClickOutside(ref: RefObject<HTMLElement | null>, onOutside: () => void, active = true) {
  useEffect(() => {
    if (!active) return;
    const handler = (event: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onOutside();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onOutside();
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('touchstart', handler);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('touchstart', handler);
      document.removeEventListener('keydown', escape);
    };
  }, [ref, onOutside, active]);
}

const MenuContext = createContext<{ close: () => void }>({ close: () => {} });

export function Menu({
  trigger,
  align = 'left',
  children,
  className = '',
  up,
}: {
  trigger: (props: { onClick: () => void; 'aria-expanded': boolean; 'aria-haspopup': 'menu' }) => ReactNode;
  align?: 'left' | 'right';
  children: ReactNode;
  className?: string;
  /** Abre para cima (rodapé da sidebar). */
  up?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useClickOutside(ref, close, open);

  return (
    <div className={`menu-anchor ${className}`.trim()} ref={ref}>
      {trigger({ onClick: () => setOpen((o) => !o), 'aria-expanded': open, 'aria-haspopup': 'menu' })}
      {open && (
        <div
          className={`menu ${align === 'right' ? 'right' : ''}`.trim()}
          role="menu"
          style={up ? { bottom: 'calc(100% + 6px)' } : { top: 'calc(100% + 6px)' }}
        >
          <MenuContext.Provider value={{ close }}>{children}</MenuContext.Provider>
        </div>
      )}
    </div>
  );
}

export function MenuItem({
  children,
  icon,
  onSelect,
  to,
  href,
  danger,
  disabled,
}: {
  children: ReactNode;
  icon?: ReactNode;
  onSelect?: () => void;
  to?: string;
  href?: string;
  danger?: boolean;
  disabled?: boolean;
}) {
  const { close } = useContext(MenuContext);
  const className = `mi${danger ? ' danger' : ''}`;
  const handle = () => {
    close();
    onSelect?.();
  };
  if (to) {
    return (
      <Link to={to} className={className} role="menuitem" onClick={handle}>
        {icon}
        {children}
      </Link>
    );
  }
  if (href) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={className} role="menuitem" onClick={handle}>
        {icon}
        {children}
      </a>
    );
  }
  return (
    <button type="button" className={className} role="menuitem" onClick={handle} disabled={disabled}>
      {icon}
      {children}
    </button>
  );
}

export const MenuSeparator = () => <div className="sep" role="separator" />;
export const MenuHeading = ({ children }: { children: ReactNode }) => <div className="hd">{children}</div>;

/* ---- foco das janelas modais ---- */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Quem tinha o foco fora da janela: é a ele que o foco volta ao fechar. */
function openerOutside(card: HTMLElement | null): HTMLElement | null {
  const active = document.activeElement as HTMLElement | null;
  if (!active || active === document.body || card?.contains(active)) return null;
  return active;
}

/**
 * O que uma janela modal precisa e o CSS não dá: foco inicial dentro dela,
 * `Tab` circulando por dentro e o foco devolvido a quem abriu ao fechar. Sem
 * isso, quem usa teclado ou leitor de tela tabula a página inteira até
 * alcançar a janela, sai dela sem perceber e, ao fechar, cai no `body`. Um
 * `autoFocus` no conteúdo tem prioridade: a janela só leva o foco quando
 * ninguém lá dentro o pediu.
 */
function useModalFocus(open: boolean) {
  const card = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    let opener = openerOutside(card.current);
    // A paleta ⌘K devolve o foco a quem a abriu num `setTimeout(0)` ao fechar,
    // e é ela que abre parte destas janelas (a de adicionar skill ao
    // servidor): o foco inicial daqui só fica de pé se vier depois disso — e é
    // depois, também, que se sabe a quem devolvê-lo.
    const timer = setTimeout(() => {
      const el = card.current;
      if (!el) return;
      opener ??= openerOutside(el);
      if (!el.contains(document.activeElement)) (el.querySelector<HTMLElement>(FOCUSABLE) ?? el).focus();
    }, 0);
    return () => {
      clearTimeout(timer);
      // Quem abriu pode ter saído da tela junto com a ação (a linha que se
      // apagou, o nó que se tirou): aí não há a quem devolver o foco.
      if (opener?.isConnected) opener.focus();
    };
  }, [open]);

  const trapTab = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return;
    const el = card.current;
    if (!el) return;
    const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((item) => item.offsetParent !== null);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    // Só nas bordas: no meio da janela o `Tab` é o do navegador. A própria
    // janela conta como borda de cima porque é ela que recebe o foco inicial
    // quando não há nada focável dentro.
    if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && (active === first || active === el)) {
      event.preventDefault();
      last.focus();
    }
  }, []);

  return { card, trapTab };
}

/* ---- confirmação (no lugar do window.confirm) ---- */
type ConfirmOptions = {
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
};

const ConfirmContext = createContext<(options: ConfirmOptions) => Promise<boolean>>(async () => true);

export const useConfirm = () => useContext(ConfirmContext);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<{ options: ConfirmOptions; resolve: (ok: boolean) => void } | null>(null);
  const { card, trapTab } = useModalFocus(pending !== null);

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setPending({ options, resolve });
      }),
    [],
  );

  const settle = (ok: boolean) => {
    pending?.resolve(ok);
    setPending(null);
  };

  useEffect(() => {
    if (!pending) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') settle(false);
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && (
        <>
          <div className="overlay" onClick={() => settle(false)} />
          <div
            ref={card}
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
            tabIndex={-1}
            onKeyDown={trapTab}
          >
            <h2 id="confirm-title">{pending.options.title}</h2>
            {pending.options.description && <p className="d">{pending.options.description}</p>}
            <div className="actions">
              <Button variant="ghost" onClick={() => settle(false)} autoFocus>
                {pending.options.cancelLabel ?? 'Cancelar'}
              </Button>
              <Button variant={pending.options.danger ? 'danger' : 'primary'} onClick={() => settle(true)}>
                {pending.options.confirmLabel ?? 'Confirmar'}
              </Button>
            </div>
          </div>
        </>
      )}
    </ConfirmContext.Provider>
  );
}

/* ---- modal genérico ---- */
export function Modal({
  open,
  title,
  onClose,
  children,
  wide,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  // O `<h2>` já existia; o `aria-labelledby` é o que faz o leitor de tela
  // anunciar o título ao entrar na janela.
  const titleId = useId();
  const { card, trapTab } = useModalFocus(open);

  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <>
      <div className="overlay" onClick={onClose} />
      <div
        ref={card}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={trapTab}
        style={wide ? { width: 'min(640px, calc(100vw - 2rem))' } : undefined}
      >
        <h2 id={titleId}>{title}</h2>
        {children}
      </div>
    </>
  );
}

/* ---- onde a skill está ---- */

/**
 * O site mostra a skill quando ela está ligada **e** é pública, ou está em
 * algum vMCP aberto e ligado, ou participa de catálogo público e ligado
 * (`docs/12-acesso-granular.md` §7 — revoga a regra do `09` §4.1, que era só o
 * vínculo aberto, de quando `is_public` não existia). É a mesma conta do
 * `pageUrl` dos dois MCPs; o painel tinha ficado com a antiga, e dizia "não é
 * exibida no site" de uma skill pública recém-desvinculada.
 *
 * O terceiro ramo fica sem sinal: `skill.catalogs` traz o estado do catálogo e
 * o da participação, não o `is_public` dele. Enquanto o banco não expuser um
 * `onSite` derivado de `OPEN_EXPOSURE`, essa skill segue sem o selo — errar
 * para menos é melhor que oferecer um "ver no site" que dá 404 —, e os textos
 * abaixo dizem "salvo por um catálogo público" em vez de negar o que não veem.
 */
export const noSite = (skill: { isActive: boolean; isPublic: boolean; mcps: SkillMcpRef[] }): boolean =>
  skill.isActive && (skill.isPublic || skill.mcps.some((mcp) => mcp.isOpen && mcp.isActive));

/**
 * Onde a skill está, em selos: "desligada", "sem vínculo" (flutuante), "em N
 * servidores" e, quando ela é pública ou algum servidor é aberto e ligado, "no
 * site". Só leitura.
 */
export function McpChips({
  skill,
  compact,
}: {
  skill: { isActive: boolean; isPublic: boolean; mcps: SkillMcpRef[] };
  compact?: boolean;
}) {
  const desligada = !skill.isActive && (
    <Badge tone="danger" title="Desligada: some de todo servidor e do site até ser religada">
      desligada
    </Badge>
  );
  if (skill.mcps.length === 0) {
    return (
      <span className="mcp-chips">
        {desligada}
        <Badge
          tone="outline"
          title={
            skill.isPublic
              ? 'Não está em nenhum servidor MCP: nenhum a serve — mas, marcada pública, continua no site'
              : 'Não está em nenhum servidor MCP: nenhum a serve, e no site ela só aparece por um catálogo público'
          }
        >
          sem vínculo
        </Badge>
        {noSite(skill) && (
          <Badge tone="ok" title="Marcada pública: aparece no site mesmo sem vínculo">
            no site
          </Badge>
        )}
      </span>
    );
  }
  const abertos = skill.mcps.filter((mcp) => mcp.isOpen && mcp.isActive).length;
  const names = skill.mcps.map((mcp) => `${mcp.name}${mcp.direct ? '' : ' (via catálogo)'}`).join(', ');
  if (desligada) {
    return (
      <span className="mcp-chips">
        {desligada}
        <Badge tone="outline" title={`Vinculada a: ${names} — mas desligada, não aparece em nenhum`}>
          {compact ? skill.mcps.length : `em ${skill.mcps.length} servidor${skill.mcps.length === 1 ? '' : 'es'}`}
        </Badge>
      </span>
    );
  }
  return (
    <span className="mcp-chips">
      <Badge tone="accent" title={`Publicada em: ${names}`}>
        {compact ? skill.mcps.length : `em ${skill.mcps.length} servidor${skill.mcps.length === 1 ? '' : 'es'}`}
      </Badge>
      {noSite(skill) ? (
        <Badge
          tone="ok"
          title={
            abertos > 0
              ? `${abertos} deles aberto(s) e ligado(s): a skill aparece no site`
              : 'Marcada pública: aparece no site mesmo sem servidor aberto'
          }
        >
          no site
        </Badge>
      ) : (
        <Badge
          tone="outline"
          title="Não é pública e só está em servidores fechados ou desligados: não aparece no site, salvo por um catálogo público"
        >
          fora do site
        </Badge>
      )}
    </span>
  );
}

/** Estado de um vMCP em selos: padrão, aberto/chave, desligado. */
export function McpStateBadges({
  mcp,
  withActive = true,
}: {
  mcp: { isActive: boolean; isOpen: boolean; isDefault: boolean };
  withActive?: boolean;
}) {
  return (
    <>
      {mcp.isDefault && (
        <Badge tone="accent" title="Responde também em /mcp, o MCP público desta instalação">
          padrão
        </Badge>
      )}
      {mcp.isOpen ? (
        <Badge tone="warn" title="Sem chave: qualquer cliente conecta, e o site o lista">
          aberto
        </Badge>
      ) : (
        <Badge tone="outline" title="Exige uma chave psv_ deste servidor">
          chave
        </Badge>
      )}
      {withActive && !mcp.isActive && (
        <Badge tone="danger" title="Desligado: tudo sob o endereço dele responde 404">
          desligado
        </Badge>
      )}
    </>
  );
}

/** Debounce simples para campos de busca. */
export function useDebounced<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/** Guarda um valor em localStorage; falhas de storage viram sessão só. */
export function useStored<T>(key: string, initial: T): [T, (value: T | ((current: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (next: T | ((current: T) => T)) => {
      setValue((current) => {
        const resolved = typeof next === 'function' ? (next as (c: T) => T)(current) : next;
        try {
          localStorage.setItem(key, JSON.stringify(resolved));
        } catch {
          // storage bloqueado: vale só nesta sessão
        }
        return resolved;
      });
    },
    [key],
  );
  return [value, set];
}

type PollingDocument = Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'>;

/**
 * O ciclo do `usePolling`, fora do React para ter teste: chama `fn` na hora e a
 * cada `ms` enquanto a aba estiver visível, e devolve o que desliga tudo.
 * Esconder a aba para o relógio; voltar chama na hora e rearma.
 *
 * Com `immediate: false`, **só a primeira** chamada é pulada: é de quem já
 * busca na montagem e não quer a mesma consulta duas vezes. Voltar à aba
 * continua atualizando na hora — senão a tela ficaria até `ms` com dado velho.
 */
export function startPolling(
  fn: () => void | Promise<void>,
  ms: number,
  { immediate = true, doc = document }: { immediate?: boolean; doc?: PollingDocument } = {},
): () => void {
  let timer: ReturnType<typeof setInterval> | undefined;
  let skip = !immediate;
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };
  const start = () => {
    stop();
    if (skip) skip = false;
    else void fn();
    timer = setInterval(() => void fn(), ms);
  };
  const visibility = () => (doc.hidden ? stop() : start());
  start();
  doc.addEventListener('visibilitychange', visibility);
  return () => {
    stop();
    doc.removeEventListener('visibilitychange', visibility);
  };
}

/** Repete `fn` a cada `ms` enquanto a aba estiver visível; as opções são as de `startPolling`. */
export function usePolling(
  fn: () => void | Promise<void>,
  ms: number,
  enabled = true,
  { immediate = true }: { immediate?: boolean } = {},
) {
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => {
    if (!enabled) return;
    return startPolling(() => latest.current(), ms, { immediate });
  }, [ms, enabled, immediate]);
}

export const useMounted = () => {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
};

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

export const useStable = <T,>(value: T) => useMemo(() => value, [value]);

/**
 * O alvo do teclado é um campo de digitação? Só campos de texto, `textarea` e
 * `contenteditable` capturam letras; uma caixa de marcar ou um botão não —
 * senão `Esc` e os atalhos morreriam depois de clicar numa caixa.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  if (el.tagName === 'INPUT') {
    const type = (el as HTMLInputElement).type;
    return !['checkbox', 'radio', 'button', 'submit', 'range', 'file'].includes(type);
  }
  return false;
}

/* ---- acorde "g + tecla" ---- */

/** Janela do acorde: passado isso, o `g` não arma mais nada. */
const CHORD_MS = 800;
let chordAt = 0;
let chordKey: KeyboardEvent | null = null;

/** O `g` foi apertado: arma o acorde de navegação (`App.tsx`). */
export function armChord(): void {
  chordAt = Date.now();
}

/**
 * Esta tecla é a segunda metade de um acorde `g + tecla`? Quem pergunta
 * primeiro consome o acorde, mas a resposta segue `true` para o **mesmo**
 * evento: a navegação e os atalhos de uma letra só (os do palco, por exemplo)
 * escutam o mesmo `keydown` em `document`, em ordem que muda a cada
 * remontagem, e os dois precisam concordar sobre de quem é a tecla — senão
 * `g c` navega para Catálogos **e** abre "adicionar catálogo" no servidor.
 */
export function isChordKey(event: KeyboardEvent): boolean {
  if (chordKey === event) return true;
  chordKey = null; // não segura o evento (nem o alvo dele) além do necessário
  if (Date.now() - chordAt > CHORD_MS) return false;
  chordAt = 0;
  chordKey = event;
  return true;
}

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
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

export function CopyButton({ text, label, size = 'sm' }: { text: string; label?: string; size?: 'sm' | 'lg' }) {
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
    <Button variant="ghost" size={size === 'sm' ? 'sm' : undefined} onClick={() => void copy()}>
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
  return (
    <div className={`tabs ${className}`.trim()} role="tablist">
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
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
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
      <div className="modal" role="dialog" aria-modal="true" style={wide ? { width: 'min(640px, calc(100vw - 2rem))' } : undefined}>
        <h2>{title}</h2>
        {children}
      </div>
    </>
  );
}

/* ---- onde a skill está ---- */

/** O site mostra a skill quando ela está ligada e em algum vMCP aberto e ligado. */
export const noSite = (skill: { isActive: boolean; mcps: SkillMcpRef[] }): boolean =>
  skill.isActive && skill.mcps.some((mcp) => mcp.isOpen && mcp.isActive);

/**
 * Onde a skill está, em selos: "desligada", "sem vínculo" (flutuante), "em N
 * servidores" e, quando algum é aberto e ligado, "no site". Só leitura.
 */
export function McpChips({ skill, compact }: { skill: { isActive: boolean; mcps: SkillMcpRef[] }; compact?: boolean }) {
  const desligada = !skill.isActive && (
    <Badge tone="danger" title="Desligada: some de todo servidor e do site até ser religada">
      desligada
    </Badge>
  );
  if (skill.mcps.length === 0) {
    return (
      <span className="mcp-chips">
        {desligada}
        <Badge tone="outline" title="Não está em nenhum servidor MCP: não é exibida no site nem em servidor algum">
          sem vínculo
        </Badge>
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
      {abertos > 0 ? (
        <Badge tone="ok" title={`${abertos} deles aberto(s) e ligado(s): a skill aparece no site`}>
          no site
        </Badge>
      ) : (
        <Badge tone="outline" title="Só em servidores fechados ou desligados: não aparece no site">
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

/** Repete `fn` a cada `ms` enquanto a aba estiver visível. */
export function usePolling(fn: () => void | Promise<void>, ms: number, enabled = true) {
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      stop();
      void latest.current();
      timer = setInterval(() => void latest.current(), ms);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = undefined;
    };
    const visibility = () => (document.hidden ? stop() : start());
    start();
    document.addEventListener('visibilitychange', visibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [ms, enabled]);
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

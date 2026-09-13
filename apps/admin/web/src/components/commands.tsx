import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { SkillSummary } from '../api.js';

/**
 * Registro de comandos: toda ação do painel existe primeiro como comando e
 * só depois como botão. Cada tela registra os seus ao montar e remove ao
 * desmontar; a paleta (⌘K) lista o que está registrado agora.
 */

export type CommandGroup = 'Criar' | 'Ir para' | 'Recurso' | 'Conta' | 'Perigo';

export const GROUP_ORDER: CommandGroup[] = ['Criar', 'Ir para', 'Recurso', 'Conta', 'Perigo'];

export type Command = {
  id: string;
  label: string;
  group: CommandGroup;
  icon?: ReactNode;
  /** Sinônimos que a pessoa pode digitar. */
  keywords?: string[];
  shortcut?: string;
  /** Motivo, quando desabilitado: aparece esmaecido em vez de sumir. */
  disabled?: string | false;
  danger?: boolean;
  run: () => void | Promise<void>;
};

export type PaletteRequest =
  | { page: 'root' }
  | {
      page: 'pick-skill';
      title: string;
      /** Slugs que não devem aparecer (já vinculadas). */
      exclude?: ReadonlySet<string>;
      onPick: (skill: SkillSummary) => void;
    };

type Registry = Map<number, Command[]>;

type CommandApi = {
  commands: Command[];
  request: PaletteRequest | null;
  open: (request?: PaletteRequest) => void;
  close: () => void;
  register: (commands: Command[]) => () => void;
};

const CommandContext = createContext<CommandApi>({
  commands: [],
  request: null,
  open: () => {},
  close: () => {},
  register: () => () => {},
});

let nextRegistration = 1;

export function CommandProvider({ children }: { children: ReactNode }) {
  const [registry, setRegistry] = useState<Registry>(() => new Map());
  const [request, setRequest] = useState<PaletteRequest | null>(null);

  const register = useCallback((commands: Command[]) => {
    const id = nextRegistration++;
    setRegistry((current) => new Map(current).set(id, commands));
    return () => {
      setRegistry((current) => {
        const next = new Map(current);
        next.delete(id);
        return next;
      });
    };
  }, []);

  const open = useCallback((next: PaletteRequest = { page: 'root' }) => setRequest(next), []);
  const close = useCallback(() => setRequest(null), []);

  // ⌘K / Ctrl+K abre (ou fecha) a paleta em qualquer tela.
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setRequest((current) => (current ? null : { page: 'root' }));
      }
    };
    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, []);

  const commands = useMemo(() => [...registry.values()].flat(), [registry]);
  const api = useMemo<CommandApi>(
    () => ({ commands, request, open, close, register }),
    [commands, request, open, close, register],
  );

  return <CommandContext.Provider value={api}>{children}</CommandContext.Provider>;
}

/**
 * Registra comandos enquanto o componente estiver montado. `deps` decide
 * quando reescrever a lista; sem o cleanup, ações de telas fechadas ficariam
 * na paleta e falhariam ao executar.
 */
export function useRegisterCommands(commands: Command[], deps: unknown[]) {
  const { register } = useContext(CommandContext);
  const latest = useRef(commands);
  latest.current = commands;
  useEffect(() => register(latest.current), [register, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
}

export function usePalette() {
  const { open, close, request } = useContext(CommandContext);
  return { open, close, isOpen: request !== null };
}

export function useCommandRegistry() {
  return useContext(CommandContext);
}

/**
 * Casamento aproximado: cada caractere da busca aparece em ordem no texto;
 * pontua mais quando casa no início de palavra. `includes` não serve — quem
 * digita "novo srv" espera "Novo servidor".
 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const t = text.toLowerCase();
  if (t.includes(q)) return 3 + (t.startsWith(q) ? 1 : 0);
  let ti = 0;
  let score = 0;
  for (const ch of q) {
    if (ch === ' ') continue;
    const at = t.indexOf(ch, ti);
    if (at === -1) return 0;
    score += at === 0 || t[at - 1] === ' ' || t[at - 1] === '-' ? 2 : 1;
    ti = at + 1;
  }
  return score / (q.length * 2 + 1);
}

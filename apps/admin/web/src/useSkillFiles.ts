import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { useLocation } from 'react-router-dom';
import {
  createFile,
  deleteFile,
  getFile,
  getSkill,
  setFile as putFile,
  uploadFiles,
  uploadZip,
  type SkillDetail,
  type SkillFileMeta,
} from './api.js';
import { useToast } from './components/Toast.js';
import { useConfirm } from './components/ui.js';
import {
  isInside,
  isSkillMdPath,
  joinPath,
  keepParent,
  parentDir,
  uploadCollisions,
  withoutDir,
  type EntryKind,
} from './explorer.js';

/* ============================================================
   ESTADO DA GUIA ARQUIVOS
   Mora na página do editor, não na guia: ir a Skill ou a
   Propriedades e voltar mantém o arquivo aberto, os rascunhos,
   as pastas novas e o que está recolhido.

   O SKILL.md não passa por aqui: o corpo dele é estado do
   formulário da página e é gravado pelo Salvar do cabeçalho.
   ============================================================ */

/** O conteúdo de um arquivo de texto aberto; `original` é o que está gravado. */
export type FileDoc =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; original: string; content: string };

/** O campo de nome aberto na árvore: o que criar e em que pasta (`''` é a raiz). */
export type Creating = { id: number; kind: EntryKind; parent: string };

export const isDirtyDoc = (doc: FileDoc | undefined): boolean =>
  doc?.status === 'ready' && doc.content !== doc.original;

const key = (path: string) => path.toLowerCase();
const NO_FILES: SkillFileMeta[] = [];

function without<T>(set: ReadonlySet<T>, item: T): ReadonlySet<T> {
  if (!set.has(item)) return set;
  const next = new Set(set);
  next.delete(item);
  return next;
}

/** Lista curta para caber numa confirmação. */
function sample(paths: readonly string[]): string {
  const shown = paths.slice(0, 4).join(', ');
  return paths.length > 4 ? `${shown} e mais ${paths.length - 4}` : shown;
}

type Options = {
  skill: SkillDetail | null;
  canWrite: boolean;
  /** Troca a lista de arquivos da skill da página sem tocar no formulário. */
  onFiles: (update: (files: SkillFileMeta[]) => SkillFileMeta[]) => void;
  /** Recarrega a skill inteira — o formulário junto, descartando o que não foi salvo. */
  onReloadAll: () => Promise<void>;
  /** O formulário da página (descrição, SKILL.md, propriedades) tem alteração pendente. */
  formDirty: boolean;
};

export function useSkillFiles({ skill, canWrite, onFiles, onReloadAll, formDirty }: Options) {
  const toast = useToast();
  const confirm = useConfirm();
  const slug = skill?.slug ?? '';
  const files = skill?.files ?? NO_FILES;

  const [selected, setSelected] = useState<string | null>(null);
  const [selectedDir, setSelectedDir] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [virtualDirs, setVirtualDirs] = useState<ReadonlySet<string>>(() => new Set());
  const [creating, setCreating] = useState<Creating | null>(null);
  const [docs, setDocs] = useState<ReadonlyMap<string, FileDoc>>(() => new Map());
  const [saving, setSaving] = useState<ReadonlySet<string>>(() => new Set());
  /** O arquivo que acabou de ser criado: o editor dele abre com o cursor. */
  const [fresh, setFresh] = useState<string | null>(null);

  // A rota do editor não desmonta ao trocar de skill: o estado recomeça.
  const [owner, setOwner] = useState(skill?.uuid);
  if (owner !== skill?.uuid) {
    setOwner(skill?.uuid);
    setSelected(null);
    setSelectedDir(null);
    setFresh(null);
    setCollapsed(new Set());
    setVirtualDirs(new Set());
    setCreating(null);
    setDocs(new Map());
  }

  // As ações assíncronas leem o estado de agora, não o da renderização que as criou.
  const latest = useRef({ docs, files, selected, saving });
  latest.current = { docs, files, selected, saving };

  const dirtyPaths = useMemo(
    () => new Set([...docs].filter(([, doc]) => isDirtyDoc(doc)).map(([path]) => path)),
    [docs],
  );

  /** A pasta onde "Novo arquivo", "Nova pasta" e "Enviar" agem sem pasta explícita. */
  const targetDir = selectedDir ?? (selected ? parentDir(selected) : '');

  const putDoc = useCallback((path: string, doc: FileDoc | null) => {
    setDocs((current) => {
      if (!doc && !current.has(path)) return current;
      const next = new Map(current);
      if (doc) next.set(path, doc);
      else next.delete(path);
      return next;
    });
  }, []);

  const metaOf = useCallback(
    (path: string) => latest.current.files.find((file) => key(file.relativePath) === key(path)),
    [],
  );

  /**
   * Lê o arquivo do servidor. Um rascunho com alteração nunca é trocado pela
   * leitura; um sem alteração é revalidado, para não editar sobre cópia velha.
   */
  const load = useCallback(
    async (path: string) => {
      setDocs((current) => (current.get(path)?.status === 'ready' ? current : new Map(current).set(path, { status: 'loading' })));
      try {
        const file = await getFile(slug, path);
        setDocs((current) => {
          if (isDirtyDoc(current.get(path))) return current;
          const doc: FileDoc =
            file.content === null
              ? { status: 'error', message: 'É um arquivo binário: não abre no editor de texto.' }
              : { status: 'ready', original: file.content, content: file.content };
          return new Map(current).set(path, doc);
        });
      } catch (err) {
        setDocs((current) =>
          isDirtyDoc(current.get(path)) ? current : new Map(current).set(path, { status: 'error', message: (err as Error).message }),
        );
      }
    },
    [slug],
  );

  /**
   * Depois de a lista mudar, o arquivo aberto segue a grafia gravada — um
   * envio com outra caixa renomeia a linha — e é relido; um rascunho pendente
   * só é trocado com `replaced` (o envio que o sobrescreveu foi confirmado).
   */
  const follow = useCallback(
    (next: readonly SkillFileMeta[], replaced = false) => {
      const shown = latest.current.selected;
      if (!shown || isSkillMdPath(shown)) return;
      const stored = next.find((file) => key(file.relativePath) === key(shown))?.relativePath ?? null;
      if (stored === null) {
        putDoc(shown, { status: 'error', message: 'O arquivo não existe mais nesta skill.' });
        return;
      }
      if (stored !== shown) {
        setSelected(stored);
        putDoc(shown, null);
      }
      if (replaced || !isDirtyDoc(latest.current.docs.get(stored))) void load(stored);
    },
    [putDoc, load],
  );

  /** Lê o arquivo se ninguém leu ainda — a guia chama ao mostrar um arquivo sem conteúdo. */
  const ensure = useCallback(
    (path: string) => {
      if (!latest.current.docs.has(path)) void load(path);
    },
    [load],
  );

  // ------------------------------------------------------------ navegação ---

  const close = useCallback(() => setSelected(null), []);

  const selectDir = useCallback((dir: string) => setSelectedDir(dir), []);

  const toggle = useCallback(
    (dir: string) =>
      setCollapsed((current) => {
        const next = new Set(current);
        if (!next.delete(dir)) next.add(dir);
        return next;
      }),
    [],
  );

  /** Abre a pasta e todas as de cima dela, até a raiz. */
  const reveal = useCallback(
    (dir: string) =>
      setCollapsed((current) => {
        const next = new Set(current);
        let changed = false;
        for (let at = dir; ; at = parentDir(at)) {
          if (next.delete(at)) changed = true;
          if (!at) break;
        }
        return changed ? next : current;
      }),
    [],
  );

  const collapseAll = useCallback((dirs: readonly string[]) => setCollapsed(new Set(dirs)), []);

  /** Abre o arquivo — e as pastas acima dele, para a árvore mostrá-lo. */
  const open = useCallback(
    (path: string) => {
      setSelected(path);
      setSelectedDir(null);
      setFresh(null);
      reveal(parentDir(path));
      if (isSkillMdPath(path)) return;
      if (metaOf(path)?.isText === false) return;
      if (!isDirtyDoc(latest.current.docs.get(path))) void load(path);
    },
    [load, metaOf, reveal],
  );

  // ----------------------------------------------------------------- criar ---

  const createSeq = useRef(0);

  const startCreate = useCallback(
    (kind: EntryKind, parent?: string) => {
      if (!canWrite) return;
      const where = parent ?? targetDir;
      reveal(where);
      createSeq.current += 1;
      setCreating({ id: createSeq.current, kind, parent: where });
    },
    [canWrite, targetDir, reveal],
  );

  /** Fecha o campo `id` — e só ele: outro pode ter sido aberto enquanto este gravava. */
  const finishCreate = useCallback(
    (id: number) => setCreating((current) => (current?.id === id ? null : current)),
    [],
  );

  const cancelCreate = finishCreate;

  /** Cria o que o campo `id` pediu; `false` mantém o campo aberto para corrigir. */
  const create = useCallback(
    async (id: number, kind: EntryKind, path: string): Promise<boolean> => {
      if (!canWrite) return false;
      if (kind === 'dir') {
        // Pasta não vai ao servidor: ela passa a existir com o primeiro arquivo.
        setVirtualDirs((current) => new Set([...current, path]));
        finishCreate(id);
        setSelectedDir(path);
        reveal(path);
        return true;
      }
      try {
        const meta = await createFile(slug, path);
        onFiles((current) => [...current.filter((file) => key(file.relativePath) !== key(meta.relativePath)), meta]);
        finishCreate(id);
        reveal(parentDir(meta.relativePath));
        setSelected(meta.relativePath);
        setSelectedDir(null);
        if (meta.isText) {
          putDoc(meta.relativePath, { status: 'ready', original: '', content: '' });
          setFresh(meta.relativePath);
          toast.success(`${meta.relativePath} criado.`);
        } else {
          toast.success(`${meta.relativePath} criado. Pela extensão é binário: não abre no editor de texto.`);
        }
        return true;
      } catch (err) {
        toast.error((err as Error).message);
        return false;
      }
    },
    [canWrite, slug, onFiles, finishCreate, reveal, putDoc, toast],
  );

  // ---------------------------------------------------------------- editar ---

  const edit = useCallback((path: string, content: string) => {
    setDocs((current) => {
      const doc = current.get(path);
      if (doc?.status !== 'ready' || doc.content === content) return current;
      return new Map(current).set(path, { ...doc, content });
    });
  }, []);

  const save = useCallback(
    async (path: string) => {
      const doc = latest.current.docs.get(path);
      if (!canWrite || doc?.status !== 'ready' || latest.current.saving.has(path)) return;
      const content = doc.content;
      setSaving((current) => new Set([...current, path]));
      try {
        const meta = await putFile(slug, path, content);
        setDocs((current) => {
          const now = current.get(path);
          // O que foi digitado durante a gravação continua pendente.
          return now?.status === 'ready' ? new Map(current).set(path, { ...now, original: content }) : current;
        });
        onFiles((current) => {
          const at = current.findIndex((file) => key(file.relativePath) === key(meta.relativePath));
          if (at === -1) return [...current, meta];
          const next = [...current];
          next[at] = meta;
          return next;
        });
        toast.success(`${path} salvo.`);
      } catch (err) {
        toast.error((err as Error).message);
      } finally {
        setSaving((current) => without(current, path));
      }
    },
    [canWrite, slug, onFiles, toast],
  );

  /** Volta ao que está gravado, relendo do servidor. */
  const revert = useCallback(
    async (path: string) => {
      if (isDirtyDoc(latest.current.docs.get(path))) {
        const ok = await confirm({
          title: `Descartar as alterações em "${path}"?`,
          description: 'O arquivo volta ao conteúdo gravado.',
          confirmLabel: 'Descartar',
          danger: true,
        });
        if (!ok) return;
      }
      putDoc(path, { status: 'loading' });
      await load(path);
    },
    [confirm, putDoc, load],
  );

  // --------------------------------------------------------------- remover ---

  const remove = useCallback(
    async (path: string) => {
      if (!canWrite || isSkillMdPath(path)) return;
      const ok = await confirm({
        title: `Remover o arquivo "${path}"?`,
        description: isDirtyDoc(latest.current.docs.get(path)) ? 'As alterações não salvas dele se perdem junto.' : undefined,
        confirmLabel: 'Remover',
        danger: true,
      });
      if (!ok) return;
      try {
        await deleteFile(slug, path);
        const remaining = latest.current.files.filter((file) => key(file.relativePath) !== key(path));
        onFiles((current) => current.filter((file) => key(file.relativePath) !== key(path)));
        setVirtualDirs((current) => keepParent(current, path, remaining));
        putDoc(path, null);
        if (latest.current.selected === path) {
          setSelected(null);
          setSelectedDir(parentDir(path));
        }
        toast.success(`${path} removido.`);
      } catch (err) {
        toast.error((err as Error).message);
      }
    },
    [canWrite, confirm, slug, onFiles, putDoc, toast],
  );

  /** Tira da árvore uma pasta nova que continua vazia — ela nunca foi ao servidor. */
  const removeDir = useCallback((dir: string) => {
    setVirtualDirs((current) => withoutDir(current, dir));
    setSelectedDir((current) => (current !== null && isInside(current, dir) ? parentDir(dir) : current));
    setCreating((current) => (current && isInside(current.parent, dir) ? null : current));
  }, []);

  // ---------------------------------------------------------------- enviar ---

  const upload = useCallback(
    async (list: readonly File[], dir: string) => {
      if (!canWrite || list.length === 0) return;
      const clashes = uploadCollisions(
        dir,
        list.map((file) => file.name),
        latest.current.files,
      );
      const touchesSkillMd = clashes.some(isSkillMdPath);

      if (clashes.length > 0) {
        const lost = clashes.filter((path) => isDirtyDoc(latest.current.docs.get(path)));
        const notes = [`O envio sobrescreve ${sample(clashes)}.`];
        if (touchesSkillMd) {
          notes.push('O SKILL.md enviado troca o corpo do prompt; os metadados continuam os das propriedades.');
          if (formDirty) notes.push('A skill é recarregada em seguida, e as alterações não salvas do formulário se perdem.');
        }
        if (lost.length > 0) notes.push(`As alterações não salvas em ${sample(lost)} se perdem.`);
        const ok = await confirm({
          title: clashes.length === 1 ? `Substituir "${clashes[0]}"?` : `Substituir ${clashes.length} arquivos?`,
          description: notes.join(' '),
          confirmLabel: 'Substituir',
          danger: lost.length > 0 || (touchesSkillMd && formDirty),
        });
        if (!ok) return;
      }

      try {
        const { files: next } = await uploadFiles(slug, [...list], dir);
        onFiles(() => next);
        setDocs((docsNow) => {
          const trimmed = new Map(docsNow);
          for (const path of clashes) trimmed.delete(path);
          return trimmed;
        });
        reveal(dir);
        toast.success(
          list.length === 1 ? `${joinPath(dir, list[0]!.name)} enviado.` : `${list.length} arquivos enviados${dir ? ` para ${dir}` : ''}.`,
        );
        if (touchesSkillMd) await onReloadAll();
        const shown = latest.current.selected;
        if (shown && clashes.some((path) => key(path) === key(shown))) follow(next, true);
      } catch (err) {
        toast.error((err as Error).message);
      }
    },
    [canWrite, formDirty, confirm, slug, onFiles, reveal, toast, onReloadAll, follow],
  );

  const importZip = useCallback(
    async (file: File, replace: boolean) => {
      if (!canWrite) return;
      const pending = [...latest.current.docs.values()].some((doc) => isDirtyDoc(doc));
      if (replace || pending || formDirty) {
        const notes = [
          replace
            ? 'Os arquivos que não estiverem no .zip são removidos. O SKILL.md fica — com o corpo do .zip, se ele trouxer um.'
            : 'Os arquivos do .zip sobrescrevem os de mesmo caminho, e um SKILL.md no .zip troca o corpo do prompt.',
        ];
        if (pending || formDirty) {
          notes.push('A skill é recarregada em seguida: as alterações não salvas, nos arquivos e no formulário, se perdem.');
        }
        const ok = await confirm({
          title: replace ? `Substituir toda a árvore por ${file.name}?` : `Importar ${file.name}?`,
          description: notes.join(' '),
          confirmLabel: replace ? 'Substituir a árvore' : 'Importar',
          danger: true,
        });
        if (!ok) return;
      }
      try {
        await uploadZip(slug, file, replace);
        setDocs(new Map());
        setSelected((current) => (current && isSkillMdPath(current) ? current : null));
        await onReloadAll();
        toast.success(replace ? 'Árvore de arquivos substituída pelo .zip.' : 'Arquivos importados do .zip.');
      } catch (err) {
        toast.error((err as Error).message);
      }
    },
    [canWrite, formDirty, confirm, slug, onReloadAll, toast],
  );

  /** Relê a lista de arquivos do servidor, sem mexer no formulário nem nos rascunhos. */
  const refresh = useCallback(async () => {
    try {
      const detail = await getSkill(slug);
      onFiles(() => detail.files);
      follow(detail.files);
      toast.success('Árvore recarregada.');
    } catch (err) {
      toast.error((err as Error).message);
    }
  }, [slug, onFiles, follow, toast]);

  // --------------------------------------------- seletores de arquivo (ocultos) ---

  const uploadInput = useRef<HTMLInputElement>(null);
  const zipInput = useRef<HTMLInputElement>(null);
  const uploadTarget = useRef('');
  const zipReplace = useRef(false);

  const pickUpload = useCallback(
    (dir?: string) => {
      uploadTarget.current = dir ?? targetDir;
      uploadInput.current?.click();
    },
    [targetDir],
  );

  const pickZip = useCallback((replace: boolean) => {
    zipReplace.current = replace;
    zipInput.current?.click();
  }, []);

  const onUploadPicked = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const list = Array.from(event.target.files ?? []);
      event.target.value = '';
      void upload(list, uploadTarget.current);
    },
    [upload],
  );

  const onZipPicked = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (file) void importZip(file, zipReplace.current);
    },
    [importZip],
  );

  return {
    files,
    selected,
    selectedDir,
    targetDir,
    collapsed,
    virtualDirs,
    creating,
    docs,
    saving,
    fresh,
    dirtyPaths,
    open,
    ensure,
    close,
    selectDir,
    toggle,
    reveal,
    collapseAll,
    startCreate,
    cancelCreate,
    create,
    edit,
    save,
    revert,
    remove,
    removeDir,
    upload,
    importZip,
    refresh,
    pickUpload,
    pickZip,
    uploadInput,
    zipInput,
    onUploadPicked,
    onZipPicked,
  };
}

export type SkillFiles = ReturnType<typeof useSkillFiles>;

/**
 * O arquivo que a outra ficha manda abrir: Editar e Visualizar, na guia
 * Arquivos, levam o arquivo aberto no `state` do link.
 */
export type OpenFileState = { openFile: string };

export const openFileState = (ws: SkillFiles): OpenFileState | undefined =>
  ws.selected ? { openFile: ws.selected } : undefined;

/** Abre o arquivo do `state` da navegação, uma vez por skill, assim que ela carrega. */
export function useOpenFileFromState(ws: SkillFiles, uuid: string | undefined) {
  const { state } = useLocation();
  const { open } = ws;
  const done = useRef<string | null>(null);
  useEffect(() => {
    const wanted = (state as Partial<OpenFileState> | null)?.openFile;
    if (!uuid || typeof wanted !== 'string' || done.current === uuid) return;
    done.current = uuid;
    open(wanted);
  }, [uuid, state, open]);
}

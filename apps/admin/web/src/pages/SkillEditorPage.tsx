import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  ExternalLink,
  Eye,
  FilePlus,
  FileText,
  FolderPlus,
  FolderTree,
  Library,
  Save,
  SlidersHorizontal,
  Trash2,
  Undo2,
  Upload,
  Users,
} from 'lucide-react';
import {
  ApiError,
  addCatalogSkill,
  canEdit,
  canManage,
  canOwn,
  deleteSkill,
  getSkill,
  isNotFound,
  linkSkillToMcp,
  removeCatalogSkill,
  setCatalogSkillActive,
  share,
  unlinkSkillFromMcp,
  unshare,
  updateSkill,
  type Session,
  type SessionUser,
  type SkillDetail,
  type SkillFileMeta,
} from '../api.js';
import { AccessTab } from '../components/AccessPanel.js';
import { Button, McpChips, Panel, Skel, Tabs, noSite, useConfirm, useMounted } from '../components/ui.js';
import { FileTree } from '../components/FileTree.js';
import { FilePickers, SkillFilesTab } from '../components/SkillFiles.js';
import { Markdown } from '../components/Markdown.js';
import { SkillIcon } from '../components/SkillIcon.js';
import { SkillMetaForm, type SkillMetaValues } from '../components/SkillMetaForm.js';
import { SkillCatalogsTab, SkillMcpsPanel } from '../components/SkillMcps.js';
import { buildFrontmatter, parseTags, stripFrontmatter } from '../frontmatter.js';
import { isSkillMdPath } from '../explorer.js';
import {
  EMPTY_DRAFTS,
  describeChange,
  planChanges,
  pruneDrafts,
  type AccessDraft,
  type CatalogDraft,
  type LinkDraft,
  type PlannedChange,
  type SkillDrafts,
} from '../skillDrafts.js';
import { openFileState, useOpenFileFromState, useSkillFiles } from '../useSkillFiles.js';
import { useToast } from '../components/Toast.js';
import { useRegisterCommands, type Command } from '../components/commands.js';
import { DescriptionBox } from './SkillViewPage.js';

type Tab = 'skill' | 'files' | 'catalogs' | 'properties' | 'access';
type DocPane = 'render' | 'source';

const TABS: readonly Tab[] = ['files', 'catalogs', 'properties', 'access'];

const VAZIO = '_Esta skill ainda não tem conteúdo em SKILL.md._';

/** Quantas pendências a faixa acima das guias lista antes do "e mais". */
const PENDING_SHOWN = 6;

/** Os rascunhos valem para uma skill: trocar de skill os descarta. */
type OwnedDrafts = { uuid: string | null; drafts: SkillDrafts };

/** Envia uma pendência ao servidor, com o slug de agora (o formulário pode tê-lo trocado). */
async function applyChange(slug: string, change: PlannedChange): Promise<void> {
  switch (change.type) {
    case 'public':
      await updateSkill(slug, { isPublic: change.value });
      return;
    case 'link':
      await linkSkillToMcp(slug, change.slug, change.flags);
      return;
    case 'unlink':
      await unlinkSkillFromMcp(slug, change.slug);
      return;
    case 'catalog-add':
      await addCatalogSkill(change.slug, slug);
      if (!change.active) await setCatalogSkillActive(change.slug, slug, false);
      return;
    case 'catalog-active':
      await setCatalogSkillActive(change.slug, slug, change.active);
      return;
    case 'catalog-remove':
      await removeCatalogSkill(change.slug, slug);
      return;
    case 'grant':
      await share('skill', slug, change.username, change.level);
      return;
    case 'revoke':
      await unshare('skill', slug, change.username);
      return;
    case 'owner':
      // `ownerUserUuid` aceita o username (`admin/src/access.ts`, `ownerFrom`), e
      // é o username que a busca de contas devolve — o `uuid` saiu dela
      // (`tasks/025`). Pelo username, o servidor ainda confere conta ativa.
      await updateSkill(slug, { ownerUserUuid: change.user.username });
      return;
  }
}

/**
 * A ficha da skill em edição (`docs/13-fichas-e-acessos.md`): Skill (a
 * descrição e o SKILL.md), Arquivos (a árvore com o editor de cada arquivo),
 * Catálogos (a participação), Propriedades (metadados e onde está publicada)
 * e Acesso (dono, visibilidade e concessões). O registro de leituras fica só
 * na leitura, na guia Auditoria — `/edit/audit` leva para lá.
 *
 * O Salvar do cabeçalho está sempre ativo e grava **tudo** o que está
 * pendente (decisão 21): os arquivos alterados, a descrição, o SKILL.md, os
 * metadados e o estado, as portas por servidor, a participação nos catálogos,
 * a visibilidade, as concessões e, por último, o dono. Nada disso vai ao
 * servidor antes; o que falhar continua pendente. Sem pendência, o Salvar
 * relê a skill do servidor. Na guia Arquivos, ⌘S grava só o arquivo aberto.
 *
 * Conteúdo e metadados são `edit`; slug, estado, visibilidade e concessões
 * são `manage`; dono e apagar são do dono (`docs/12-acesso-granular.md`
 * §3.2); as portas são `edit` no servidor e a participação, `edit` no
 * catálogo. Quem só administra um servidor entra aqui para publicar a skill
 * nele: vê os campos travados e as portas do seu servidor livres.
 */
export function SkillEditorPage({ session, user }: { session: Session; user: SessionUser }) {
  const { slug = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const confirm = useConfirm();

  const [skill, setSkill] = useState<SkillDetail | null>(null);
  const podeEscrever = skill ? canEdit(skill.access) : false;
  const podeAdministrar = skill ? canManage(skill.access) : false;
  const podeApagar = skill ? canOwn(skill.access) : false;
  const [saving, setSaving] = useState(false);
  const [meta, setMeta] = useState<SkillMetaValues>({ name: '', slug: '', description: '', tags: '', icon: '' });
  const [isActive, setIsActive] = useState(true);
  const [skillMd, setSkillMd] = useState('');
  const [owned, setOwned] = useState<OwnedDrafts>({ uuid: null, drafts: EMPTY_DRAFTS });
  const drafts = owned.drafts;

  const tail = location.pathname.slice(`/skills/${slug}/edit`.length).split('/')[1] ?? '';
  const tab: Tab = TABS.find((item) => item === tail) ?? 'skill';

  /**
   * Põe a skill gravada na página. `keepForm` preserva o formulário (um
   * Salvar que não conseguiu gravá-lo); os rascunhos ficam só no que ainda
   * muda alguma coisa, e somem se a skill é outra.
   */
  const hydrate = useCallback((detail: SkillDetail, keepForm = false) => {
    setSkill(detail);
    if (!keepForm) {
      setMeta({ name: detail.name, slug: detail.slug, description: detail.description, tags: detail.tags.join(', '), icon: detail.icon ?? '' });
      setIsActive(detail.isActive);
      setSkillMd(stripFrontmatter(detail.skillMd));
    }
    setOwned((current) => ({
      uuid: detail.uuid,
      drafts: current.uuid === detail.uuid ? pruneDrafts(detail, current.drafts) : EMPTY_DRAFTS,
    }));
  }, []);

  // Fora de um data router, `navigate` muda a cada troca de caminho: se o
  // `reload` dependesse dele, cada troca de guia buscaria a skill de novo e
  // repovoaria o formulário, jogando fora o que ainda não foi salvo.
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const skillRef = useRef(skill);
  skillRef.current = skill;
  const mounted = useMounted();

  /**
   * Relê a skill do endereço. `wanted` diz se a resposta ainda interessa: a
   * carga da ficha passa a flag do próprio efeito, para a skill anterior não
   * chegar por último — nem o erro dela levar para a lista quem já saiu daqui.
   *
   * Sem a skill deste endereço na tela não há o que mostrar, e a lista é a
   * saída. Com ela — a releitura depois de um import, ou o endereço novo de um
   * slug trocado pelo Salvar — sair desmontaria o editor e levaria junto o que
   * está pendente: só quando a skill ficou fora de alcance (`isNotFound`).
   */
  const reload = useCallback(
    async (wanted: () => boolean = () => true) => {
      try {
        const fresh = await getSkill(slug);
        if (wanted()) hydrate(fresh);
      } catch (err) {
        if (!wanted()) return;
        toast.error((err as Error).message);
        if (skillRef.current?.slug !== slug || isNotFound(err)) navigateRef.current('/skills');
      }
    },
    [slug, hydrate, toast],
  );

  useEffect(() => {
    let active = true;
    void reload(() => active);
    return () => {
      active = false;
    };
  }, [reload]);

  /**
   * Operações de arquivo trocam só a lista: recarregar a skill inteira
   * repovoaria o formulário e jogaria fora o que ainda não foi salvo.
   */
  const onFiles = useCallback((update: (files: SkillFileMeta[]) => SkillFileMeta[]) => {
    setSkill((current) => {
      if (!current) return current;
      const files = update(current.files);
      return files === current.files ? current : { ...current, files, fileCount: files.length };
    });
  }, []);

  const patchMeta = useCallback((patch: Partial<SkillMetaValues>) => setMeta((current) => ({ ...current, ...patch })), []);

  const setDrafts = useCallback(
    (patch: Partial<SkillDrafts>) => setOwned((current) => ({ ...current, drafts: { ...current.drafts, ...patch } })),
    [],
  );
  const onLinkDrafts = useCallback((links: Record<string, LinkDraft>) => setDrafts({ links }), [setDrafts]);
  const onCatalogDrafts = useCallback((catalogs: Record<string, CatalogDraft>) => setDrafts({ catalogs }), [setDrafts]);
  const onAccessDraft = useCallback((access: AccessDraft) => setDrafts({ access }), [setDrafts]);

  // O SKILL.md muda com o corpo e com os campos que viram o frontmatter.
  const skillMdDirty =
    skill !== null &&
    (skillMd !== stripFrontmatter(skill.skillMd) ||
      meta.name !== skill.name ||
      meta.slug !== skill.slug ||
      meta.description !== skill.description ||
      meta.tags !== skill.tags.join(', '));

  /** O formulário: descrição, SKILL.md, metadados e o estado. */
  const formDirty =
    skill !== null && (skillMdDirty || meta.icon.trim() !== (skill.icon ?? '') || isActive !== skill.isActive);

  const changes = useMemo(() => (skill ? planChanges(skill, drafts) : []), [skill, drafts]);

  const files = useSkillFiles({ skill, canWrite: podeEscrever, onFiles, onReloadAll: reload, formDirty });
  const { save: saveFile, remove: removeFile, startCreate, pickUpload, dirtyPaths } = files;
  useOpenFileFromState(files, skill?.uuid);
  // O SKILL.md aberto em Arquivos é o formulário, não um arquivo à parte.
  const dirtyFiles = useMemo(() => [...dirtyPaths].filter((path) => !isSkillMdPath(path)), [dirtyPaths]);

  /** Tudo o que o Salvar vai enviar, em frases, na ordem em que envia. */
  const pendingList = useMemo(
    () => [
      ...dirtyFiles.map((path) => `gravar o arquivo ${path}`),
      ...(formDirty ? ['gravar a descrição, o SKILL.md e as propriedades'] : []),
      ...changes.map(describeChange),
    ],
    [dirtyFiles, formDirty, changes],
  );
  const pendingCount = pendingList.length;

  const frontmatter = useMemo(
    () =>
      buildFrontmatter({
        slug: meta.slug || skill?.slug || '',
        name: meta.name,
        description: meta.description,
        tags: parseTags(meta.tags),
      }),
    [meta.slug, meta.name, meta.description, meta.tags, skill?.slug],
  );

  // O Salvar lê o estado da hora do clique, não o da última renderização.
  const latest = useRef({ skill, meta, isActive, skillMd, drafts, formDirty, dirtyFiles, changes });
  latest.current = { skill, meta, isActive, skillMd, drafts, formDirty, dirtyFiles, changes };
  const savingRef = useRef(false);

  const save = useCallback(async () => {
    const now = latest.current;
    const current = now.skill;
    if (!current || savingRef.current) return;

    if (!now.formDirty && now.changes.length === 0 && now.dirtyFiles.length === 0) {
      // Nada pendente: o botão continua valendo, e relê o que está gravado.
      savingRef.current = true;
      setSaving(true);
      try {
        const fresh = await getSkill(current.slug);
        hydrate(fresh);
        toast.success('Nada pendente: a skill está igual à gravada no servidor.');
      } catch (err) {
        toast.error((err as Error).message);
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
      return;
    }

    const transfer = now.changes.find((change) => change.type === 'owner');
    if (transfer && transfer.type === 'owner') {
      const ok = await confirm({
        title: `Transferir "${current.name}" para ${transfer.user.name}?`,
        description:
          user.role === 'admin'
            ? `@${transfer.user.username} passa a ser o dono, com todos os poderes sobre esta skill. A transferência é gravada por último.`
            : `@${transfer.user.username} passa a ser o dono, e você deixa de ser. Só um administrador ou o novo dono pode devolver. A transferência é gravada por último.`,
        confirmLabel: 'Salvar e transferir',
        danger: user.role !== 'admin',
      });
      if (!ok) return;
    }

    savingRef.current = true;
    setSaving(true);
    const failures: string[] = [];
    let slugNow = current.slug;
    let formFailed = false;

    // 1. Os arquivos, com o slug que o editor de arquivos conhece. O motivo de
    // cada falha já saiu no aviso do editor de arquivos; aqui entra a conta,
    // para o "Alterações salvas." não sair por cima dele.
    for (const path of now.dirtyFiles) {
      if (!(await saveFile(path))) failures.push(`gravar o arquivo ${path}`);
    }

    // 2. O formulário, levando junto a visibilidade quando ela mudou.
    const publicChange = now.changes.find((change) => change.type === 'public');
    const withForm = now.formDirty && podeEscrever;
    if (withForm) {
      const prompt = stripFrontmatter(now.skillMd);
      try {
        const updated = await updateSkill(current.slug, {
          // Cada campo só vai quando mudou de fato. `updateSkill` grava só o
          // que recebe: reenviar o valor lido no carregamento desfazia, sem
          // erro nenhum, o nome, a descrição ou as tags de quem salvou no meio
          // — a mesma razão que já valia para `icon`, `slug` e o SKILL.md.
          name: now.meta.name !== current.name ? now.meta.name : undefined,
          slug: now.meta.slug !== current.slug ? now.meta.slug : undefined,
          description: now.meta.description !== current.description ? now.meta.description : undefined,
          icon: now.meta.icon.trim() !== (current.icon ?? '') ? now.meta.icon.trim() || null : undefined,
          tags: now.meta.tags !== current.tags.join(', ') ? parseTags(now.meta.tags) : undefined,
          isActive: now.isActive !== current.isActive ? now.isActive : undefined,
          isPublic: publicChange?.type === 'public' ? publicChange.value : undefined,
          skillMd: prompt !== current.skillMd ? prompt : undefined,
        });
        slugNow = updated.slug;
      } catch (err) {
        formFailed = true;
        failures.push(`descrição, SKILL.md e propriedades: ${(err as Error).message}`);
      }
    }

    // 3. O resto, na ordem do plano; a visibilidade já foi com o formulário.
    for (const change of now.changes) {
      if (change.type === 'public' && withForm) continue;
      try {
        await applyChange(slugNow, change);
      } catch (err) {
        failures.push(`${describeChange(change)}: ${(err as Error).message}`);
      }
    }

    // 4. Relê o que ficou gravado; o que não foi continua pendente. Quem saiu
    // do editor no meio do Salvar não é trazido de volta nem levado à lista.
    const withSlug = (next: string) => location.pathname.replace(`/skills/${current.slug}/`, `/skills/${next}/`);
    const go = (to: string, options?: { replace: boolean }) => {
      if (mounted.current) navigateRef.current(to, options);
    };
    let confirmed = true;
    try {
      const fresh = await getSkill(slugNow);
      hydrate(fresh, formFailed);
      if (fresh.slug !== current.slug) go(withSlug(fresh.slug), { replace: true });
    } catch (err) {
      const message = (err as Error).message;
      if (isNotFound(err)) {
        // A skill ficou fora de alcance: transferir tira da conta o acesso a
        // ela, ou alguém a removeu no meio da edição. Não há o que manter na
        // tela — e a ficha de leitura responderia o mesmo 404.
        toast.error(message);
        go('/skills');
      } else {
        // Sessão vencida (401), 5xx ou rede: **fica**. Sair desmonta o editor
        // (`/skills/:slug/edit/*` e `/skills/:slug/*` são rotas de elementos
        // diferentes) e leva junto tudo o que ainda não foi gravado — e era o
        // que acontecia, em qualquer erro, no clique de Salvar. A página não
        // reconfere a sessão sozinha: dá para entrar de novo em outra aba.
        confirmed = false;
        toast.error(
          err instanceof ApiError && err.status === 401
            ? `A sessão caiu (${message}). Nada foi descartado: entre de novo em outra aba e clique em Salvar.`
            : `Não deu para reler a skill (${message}). Nada foi descartado: o que já foi gravado pode seguir listado como pendente — salve de novo para conferir.`,
        );
        // O slug trocado já vale no servidor, e é só o que a resposta do PATCH
        // dá para aproveitar (as listas dela não são recortadas por quem lê):
        // sem ele a próxima tentativa iria toda para um endereço que sumiu.
        if (slugNow !== current.slug) {
          setSkill((shown) => (shown?.uuid === current.uuid ? { ...shown, slug: slugNow } : shown));
          go(withSlug(slugNow), { replace: true });
        }
      }
    }

    if (failures.length > 0) {
      const [first, ...rest] = failures;
      toast.error(
        `${failures.length === 1 ? 'Uma alteração não foi gravada' : `${failures.length} alterações não foram gravadas`} e continua pendente — ${first}${rest.length > 0 ? ` (e mais ${rest.length})` : ''}`,
      );
    } else if (confirmed) {
      toast.success('Alterações salvas.');
    }
    savingRef.current = false;
    setSaving(false);
  }, [confirm, hydrate, location.pathname, podeEscrever, saveFile, toast, user.role]);

  async function discard() {
    if (!skill) return;
    const ok = await confirm({
      title: 'Descartar as alterações pendentes?',
      description: 'O formulário, as portas, os catálogos e o acesso voltam ao que está gravado. Arquivos alterados continuam na guia Arquivos, onde se descartam um a um.',
      confirmLabel: 'Descartar',
      danger: true,
    });
    if (!ok) return;
    setOwned({ uuid: skill.uuid, drafts: EMPTY_DRAFTS });
    hydrate(skill);
  }

  const editBase = `/skills/${skill?.slug ?? slug}/edit`;
  const filesPath = `${editBase}/files`;

  /** O arquivo que ⌘S grava na guia Arquivos; o SKILL.md é do formulário. */
  const openFile = tab === 'files' && files.selected && !isSkillMdPath(files.selected) ? files.selected : null;
  const openFileDirty = openFile !== null && dirtyPaths.has(openFile);

  const toFiles = useCallback(() => {
    if (!location.pathname.endsWith('/files')) navigate(filesPath);
  }, [location.pathname, navigate, filesPath]);

  const commands: Command[] = [];
  if (skill) {
    commands.push({
      id: 'skill-save',
      label: pendingCount > 0 ? `Salvar alterações (${pendingCount})` : 'Salvar (reler do servidor)',
      group: 'Recurso',
      icon: <Save />,
      shortcut: openFile ? undefined : '⌘ S',
      run: save,
    });
  }
  if (skill && podeEscrever) {
    if (openFile) {
      commands.push({
        id: 'file-save',
        label: `Salvar ${openFile}`,
        group: 'Recurso',
        icon: <Save />,
        shortcut: '⌘ S',
        disabled: openFileDirty ? false : 'nada a salvar',
        // `saveFile` devolve se gravou; a paleta não espera resposta.
        run: () => void saveFile(openFile),
      });
    }
    commands.push(
      { id: 'file-new', label: 'Novo arquivo', group: 'Recurso', icon: <FilePlus />, keywords: ['criar', 'arquivo', 'vazio'], run: () => { toFiles(); startCreate('file'); } },
      { id: 'dir-new', label: 'Nova pasta', group: 'Recurso', icon: <FolderPlus />, keywords: ['criar', 'pasta', 'diretório'], run: () => { toFiles(); startCreate('dir'); } },
      { id: 'files-upload', label: 'Enviar arquivos', group: 'Recurso', icon: <Upload />, keywords: ['upload', 'anexar'], run: () => { toFiles(); pickUpload(); } },
    );
    if (openFile) {
      commands.push({ id: 'file-delete', label: `Remover ${openFile}`, group: 'Perigo', icon: <Trash2 />, danger: true, run: () => removeFile(openFile) });
    }
  }
  if (skill && tab !== 'files') {
    commands.push({ id: 'files-tab', label: 'Arquivos da skill', group: 'Ir para', icon: <FolderTree />, keywords: ['arvore', 'editar arquivo'], run: () => navigate(filesPath) });
  }
  if (skill && tab !== 'catalogs') {
    commands.push({ id: 'catalogs-tab', label: 'Catálogos da skill', group: 'Ir para', icon: <Library />, keywords: ['catalogo', 'participação'], run: () => navigate(`${editBase}/catalogs`) });
  }
  if (skill && tab !== 'access') {
    commands.push({ id: 'access-tab', label: 'Acesso à skill', group: 'Ir para', icon: <Users />, keywords: ['dono', 'compartilhar', 'público'], run: () => navigate(`${editBase}/access`) });
  }
  useRegisterCommands(commands, [
    skill?.slug,
    podeEscrever,
    pendingCount,
    save,
    openFile,
    openFileDirty,
    tab,
    toFiles,
    saveFile,
    removeFile,
    startCreate,
    pickUpload,
    filesPath,
    editBase,
  ]);

  // ⌘S salva; o navegador não abre o "salvar página".
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 's' || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      if (openFile) {
        if (openFileDirty && podeEscrever) void saveFile(openFile);
      } else {
        void save();
      }
    };
    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, [save, podeEscrever, openFile, openFileDirty, saveFile]);

  // Recarregar ou fechar a aba com algo pendente pede confirmação ao navegador.
  const pending = pendingCount > 0;
  useEffect(() => {
    if (!pending) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [pending]);

  async function removeSkill() {
    if (!skill) return;
    const ok = await confirm({
      title: `Remover a skill "${skill.name}"?`,
      description: 'Todos os arquivos dela e os vínculos com servidores somem. Não dá para desfazer.',
      confirmLabel: 'Remover',
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteSkill(skill.slug);
      toast.success('Skill removida.');
      navigate('/skills');
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  if (!skill) {
    return (
      <div className="page wide">
        <Skel h={20} w={120} className="mb-3" />
        <Skel h={40} w={360} className="mb-6" />
        <Skel h={420} />
      </div>
    );
  }

  const base = `/skills/${skill.slug}`;

  return (
    <div className={`page wide${tab === 'files' ? ' workbench' : ''}`}>
      <div className="page-head">
        <div className="min-w-0">
          <Link to={base} className="back-link">
            <ArrowLeft /> {skill.name}
          </Link>
          <div className="flex items-center gap-3">
            <SkillIcon icon={meta.icon.trim() || null} name={meta.name || skill.name} slug={skill.slug} size="lg" />
            <div className="min-w-0">
              <h1 className="truncate">{meta.name || skill.name}</h1>
              <p className="sub mono flex flex-wrap items-center gap-x-3">
                <span>{skill.slug}</span>
                <span>· editando</span>
                <McpChips skill={skill} compact />
              </p>
            </div>
          </div>
        </div>

        <div className="page-actions">
          {noSite(skill) && (
            <a href={`${session.siteBaseUrl}/skills/${skill.slug}`} target="_blank" rel="noreferrer" className="btn btn-quiet btn-sm">
              <ExternalLink /> ver no site
            </a>
          )}
          {/* A leitura tem as mesmas guias: Visualizar fica na guia e, em Arquivos, no arquivo aberto. */}
          <Link
            to={tab === 'skill' ? base : `${base}/${tab}`}
            state={tab === 'files' ? openFileState(files) : undefined}
            className="btn btn-ghost"
          >
            <Eye /> Visualizar
          </Link>
          <Button
            onClick={() => void save()}
            disabled={saving}
            aria-busy={saving}
            title={pendingCount > 0 ? `Grava: ${pendingList.join('; ')}` : 'Nada pendente — clicar relê a skill do servidor'}
          >
            <Save /> {saving ? 'Salvando…' : 'Salvar'}
            {pendingCount > 0 && !saving && <span className="btn-count">{pendingCount}</span>}
          </Button>
        </div>
      </div>

      {!podeEscrever && (
        <p className="notice warn mb-4">
          Você não edita o conteúdo desta skill: os campos aparecem travados. O que você administra — os servidores em que
          ela pode ser publicada e os catálogos que você edita — está em Propriedades e em Catálogos.
        </p>
      )}

      {pendingCount > 0 && (
        <div className="alert warn pending-bar mb-4" role="status">
          <AlertTriangle />
          <div className="min-w-0 flex-1">
            <strong>{pendingCount === 1 ? '1 alteração pendente' : `${pendingCount} alterações pendentes`}</strong> — nada disso foi
            gravado ainda; vai para o servidor quando você clicar em Salvar (⌘S).
            <ul>
              {pendingList.slice(0, PENDING_SHOWN).map((item, index) => (
                <li key={index}>{item}</li>
              ))}
              {pendingCount > PENDING_SHOWN && <li>e mais {pendingCount - PENDING_SHOWN}</li>}
            </ul>
          </div>
          <Button variant="ghost" size="sm" onClick={() => void discard()} disabled={saving}>
            <Undo2 /> Descartar
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={saving}>
            <Save /> {saving ? 'Salvando…' : 'Salvar'}
          </Button>
        </div>
      )}

      <Tabs
        value={tab}
        items={[
          { key: 'skill', label: 'Skill', icon: <FileText />, to: editBase },
          { key: 'files', label: 'Arquivos', icon: <FolderTree />, to: filesPath, count: skill.files.length },
          { key: 'catalogs', label: 'Catálogos', icon: <Library />, to: `${editBase}/catalogs`, count: skill.catalogs.length },
          { key: 'properties', label: 'Propriedades', icon: <SlidersHorizontal />, to: `${editBase}/properties` },
          { key: 'access', label: 'Acesso', icon: <Users />, to: `${editBase}/access` },
        ]}
      />

      <Routes>
        <Route
          index
          element={
            <SkillTab
              skill={skill}
              description={meta.description}
              onDescription={(description) => patchMeta({ description })}
              skillMd={skillMd}
              onSkillMd={setSkillMd}
              frontmatter={frontmatter}
              canWrite={podeEscrever}
              filesPath={filesPath}
              onOpenFile={(path) => {
                files.open(path);
                navigate(filesPath);
              }}
            />
          }
        />
        <Route
          path="files"
          element={
            <SkillFilesTab
              ws={files}
              slug={skill.slug}
              canWrite={podeEscrever}
              skillMd={{
                body: skillMd,
                onBody: setSkillMd,
                frontmatter,
                dirty: skillMdDirty,
                formDirty,
                saving,
                onSave: () => void save(),
              }}
            />
          }
        />
        <Route
          path="catalogs"
          element={<SkillCatalogsTab skill={skill} user={user} drafts={drafts.catalogs} onDrafts={onCatalogDrafts} />}
        />
        <Route
          path="properties"
          element={
            <PropertiesTab
              skill={skill}
              meta={meta}
              onMeta={patchMeta}
              isActive={isActive}
              onActive={setIsActive}
              canWrite={podeEscrever}
              canManage={podeAdministrar}
              canDelete={podeApagar}
              links={drafts.links}
              onLinks={onLinkDrafts}
              onRemove={removeSkill}
            />
          }
        />
        <Route
          path="access"
          element={
            <AccessTab
              kind="skill"
              object={skill}
              user={user}
              mode="draft"
              draft={drafts.access}
              onDraft={onAccessDraft}
              publicHint="Não a publica em servidor nenhum: onde ela aparece continua sendo o vínculo."
            />
          }
        />
        {/* O registro de leituras mora na ficha de leitura; um link antigo para cá vai para lá. */}
        <Route path="audit" element={<Navigate to={`${base}/audit`} replace />} />
        <Route path="accesses" element={<Navigate to={`${base}/audit`} replace />} />
        <Route path="*" element={<Navigate to={editBase} replace />} />
      </Routes>

      <FilePickers ws={files} />
    </div>
  );
}

// ------------------------------------------------------------ guia Skill ---

/**
 * A descrição e o SKILL.md (renderizado ou cru, e aqui o cru é editável), com
 * a árvore ao lado como na leitura. Escolher um arquivo o abre na guia
 * Arquivos, que é onde se cria, envia, importa e remove.
 */
function SkillTab({
  skill,
  description,
  onDescription,
  skillMd,
  onSkillMd,
  frontmatter,
  canWrite,
  filesPath,
  onOpenFile,
}: {
  skill: SkillDetail;
  description: string;
  onDescription: (value: string) => void;
  skillMd: string;
  onSkillMd: (value: string) => void;
  frontmatter: string;
  canWrite: boolean;
  filesPath: string;
  onOpenFile: (path: string) => void;
}) {
  const [pane, setPane] = useState<DocPane>('source');

  return (
    <>
      <DescriptionBox description={description}>
        <textarea
          className="field"
          value={description}
          onChange={(event) => onDescription(event.target.value)}
          rows={3}
          disabled={!canWrite}
          placeholder="O que esta skill faz e quando usá-la — é por ela que o agente decide acionar a skill."
        />
      </DescriptionBox>

      <div className="skill-read">
        <div className="doc-box">
          <div className="doc-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={pane === 'render'} className={pane === 'render' ? 'active' : ''} onClick={() => setPane('render')}>
              Skill
            </button>
            <button type="button" role="tab" aria-selected={pane === 'source'} className={pane === 'source' ? 'active' : ''} onClick={() => setPane('source')}>
              SKILL.md
            </button>
          </div>

          {pane === 'render' ? (
            <div className="doc-body">
              <Markdown>{skillMd || VAZIO}</Markdown>
            </div>
          ) : (
            <div className="doc-edit">
              <pre className="doc-frontmatter">
                <span className="t">Primeiras linhas do SKILL.md, geradas da descrição e das propriedades</span>
                {frontmatter}
              </pre>
              <textarea
                value={skillMd}
                onChange={(event) => onSkillMd(event.target.value)}
                rows={26}
                spellCheck={false}
                disabled={!canWrite}
                className="field field-mono resize-y"
                placeholder={'# Título\n\n## Quando usar\n\nDescreva o gatilho da skill.'}
              />
            </div>
          )}
        </div>

        <Panel
          className="aside-sticky"
          title="Arquivos"
          icon={<FolderTree />}
          actions={
            <Link to={filesPath} className="link-action">
              Abrir a guia
            </Link>
          }
        >
          <FileTree
            slug={skill.slug}
            files={skill.files}
            selected={pane === 'source' ? 'SKILL.md' : null}
            onPick={(path) => (isSkillMdPath(path) ? setPane('source') : onOpenFile(path))}
          />
          <p className="panel-hint mt-3 mb-0">
            Clique num arquivo para abri-lo na guia <Link to={filesPath} className="link">Arquivos</Link>, onde também se
            criam arquivos e pastas e se enviam arquivos de texto.
          </p>
        </Panel>
      </div>
    </>
  );
}

// ---------------------------------------------------- guia Propriedades ---

/**
 * Metadados e estado, e as portas por servidor — tudo pendente até o Salvar
 * do cabeçalho — e, para o dono, a zona de perigo (esta sim, na hora).
 */
function PropertiesTab({
  skill,
  meta,
  onMeta,
  isActive,
  onActive,
  canWrite,
  canManage: manages,
  canDelete,
  links,
  onLinks,
  onRemove,
}: {
  skill: SkillDetail;
  meta: SkillMetaValues;
  onMeta: (patch: Partial<SkillMetaValues>) => void;
  isActive: boolean;
  onActive: (value: boolean) => void;
  canWrite: boolean;
  canManage: boolean;
  canDelete: boolean;
  links: Record<string, LinkDraft>;
  onLinks: (next: Record<string, LinkDraft>) => void;
  onRemove: () => Promise<void>;
}) {
  return (
    <div className="grid gap-4">
      <div className="grid gap-4 2xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Panel title="Propriedades" icon={<SlidersHorizontal />}>
          <SkillMetaForm values={meta} onChange={onMeta} hideDescription disabled={!canWrite} />
          <label className="check mt-4" title="Desligada, a skill some de todo servidor e do site — direto ou por catálogo — sem perder vínculo nenhum.">
            <input type="checkbox" checked={isActive} onChange={(event) => onActive(event.target.checked)} disabled={!manages} />
            Skill ligada: desligada, não é entregue por servidor nenhum nem aparece no site (os vínculos e os catálogos ficam)
          </label>
          {!manages && canWrite && (
            <p className="hint mt-1">Slug e estado são de quem administra a skill; você edita o conteúdo e os demais metadados.</p>
          )}
          <p className="panel-hint mt-3 mb-0">Estes campos são gravados pelo botão Salvar, junto com a descrição e o SKILL.md.</p>
        </Panel>

        <SkillMcpsPanel skill={skill} drafts={links} onDrafts={onLinks} />
      </div>

      {canDelete && (
        <Panel title="Zona de perigo" icon={<Trash2 />}>
          <p className="panel-hint">
            Remover apaga a skill, todos os arquivos dela e os vínculos com servidores e catálogos, na hora e sem passar
            pelo Salvar. Não dá para desfazer.
          </p>
          <Button variant="danger" onClick={() => void onRemove()}>
            <Trash2 /> Remover skill
          </Button>
        </Panel>
      )}
    </div>
  );
}

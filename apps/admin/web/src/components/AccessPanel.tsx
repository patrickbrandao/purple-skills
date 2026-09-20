import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Crown, Globe, Lock, Search, ShieldCheck, Trash2, Undo2, UserRound, Users } from 'lucide-react';
import {
  ACCESS_HINT,
  ACCESS_LABEL,
  ACCESS_LEVELS,
  ROLE_LABEL,
  canManage,
  canOwn,
  formatDateTime,
  lookupUsers,
  share,
  unshare,
  type AccessKind,
  type AccessLevel,
  type Accessible,
  type EffectiveAccess,
  type Grant,
  type Role,
  type SessionUser,
  type UserLookup,
} from '../api.js';
import type { AccessDraft } from '../skillDrafts.js';
import { Badge, Button, EmptyRow, Panel, cx, useClickOutside, useConfirm, useDebounced } from './ui.js';
import { initials } from './SkillIcon.js';
import { useToast } from './Toast.js';

const KIND_LABEL: Record<AccessKind, string> = { skill: 'skill', catalog: 'catálogo', mcp: 'servidor' };

/**
 * O selo de origem do acesso nas listas (`docs/12-acesso-granular.md`
 * decisão 19): dono, o nível concedido, ou "público"/"aberto" quando a
 * sessão só chega por aí. Admin é dono de tudo e não precisa de selo.
 */
export function AccessBadge({
  object,
  user,
  publicLabel = 'pública',
}: {
  object: Accessible & { isPublic?: boolean; isOpen?: boolean };
  user: SessionUser;
  publicLabel?: string;
}) {
  if (user.role === 'admin') return null;
  const access = object.access;
  if (access === 'owner') {
    return (
      <Badge tone="accent" title="Você é o dono: faz tudo, inclusive apagar e transferir">
        <Crown style={{ width: 11, height: 11 }} /> dono
      </Badge>
    );
  }
  if (access === 'manage' || access === 'edit') {
    return (
      <Badge tone="info" title={`Concedido a você: ${ACCESS_LABEL[access]}`}>
        <ShieldCheck style={{ width: 11, height: 11 }} /> {ACCESS_LABEL[access]}
      </Badge>
    );
  }
  if (object.isPublic || object.isOpen) {
    return (
      <Badge tone="outline" title="Legível por qualquer conta">
        <Globe style={{ width: 11, height: 11 }} /> {publicLabel}
      </Badge>
    );
  }
  return (
    <Badge tone="outline" title="Você só lê: por concessão ou por um contêiner que vê">
      <Lock style={{ width: 11, height: 11 }} /> leitura
    </Badge>
  );
}

/** A frase de acesso da sessão, para o cabeçalho de uma página. */
export function accessSentence(access: EffectiveAccess): string {
  if (access === 'owner') return 'você é o dono';
  if (access === null) return 'sem acesso';
  return `seu acesso: ${ACCESS_LABEL[access]}`;
}

/**
 * A sessão é a dona do objeto? Pelo **e-mail**: o uuid de conta não sai mais do
 * servidor — `ownerUserUuid` chega como apelido do e-mail (relatório 011 da
 * auditoria de 2026-09-19) —, e comparar com `user.uuid` nunca casaria: o "você"
 * sumiria. A sessão de bootstrap não é conta (`uuid` nulo, e-mail vazio) e não é
 * dona de nada.
 */
export function ownedBy(object: Pick<Accessible, 'ownerEmail'>, user: Pick<SessionUser, 'uuid' | 'email'>): boolean {
  return object.ownerEmail !== null && user.uuid !== null && object.ownerEmail.toLowerCase() === user.email.toLowerCase();
}

// -------------------------------------------------------------- busca ------

/**
 * Escolhe uma conta pelo nome ou e-mail (decisão 13): a busca é do servidor,
 * só contas ativas, a partir de dois caracteres.
 *
 * A conta escolhida é identificada pelo **e-mail** — o `uuid` saiu da busca
 * (`tasks/025`) e `exclude` é um conjunto de e-mails.
 */
export function UserPicker({
  value,
  onChange,
  exclude,
  placeholder = 'Nome ou e-mail da conta',
  autoFocus,
}: {
  value: UserLookup | null;
  onChange: (user: UserLookup | null) => void;
  /** E-mails a esconder da lista: quem já tem concessão, o dono. */
  exclude?: Set<string>;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [query, setQuery] = useState('');
  const dq = useDebounced(query, 250);
  const [options, setOptions] = useState<UserLookup[]>([]);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useClickOutside(box, () => setOpen(false), open);

  useEffect(() => {
    if (dq.trim().length < 2) {
      setOptions([]);
      return;
    }
    let active = true;
    lookupUsers(dq.trim())
      .then((data) => active && setOptions(data.items.filter((item) => !exclude?.has(item.email))))
      .catch(() => active && setOptions([]));
    return () => {
      active = false;
    };
  }, [dq, exclude]);

  if (value) {
    return (
      <div className="flex items-center gap-2">
        <span className="skill-icon sm" aria-hidden>
          <span className="mono">{initials(value.name || value.email)}</span>
        </span>
        <span className="min-w-0 flex-1">
          <span className="row-title truncate">{value.name}</span>
          <span className="row-sub truncate">
            {value.email} · {ROLE_LABEL[value.role]}
          </span>
        </span>
        <Button variant="quiet" size="sm" onClick={() => onChange(null)}>
          trocar
        </Button>
      </div>
    );
  }

  return (
    <div ref={box} className="relative">
      <label className="search-bar">
        <Search />
        <input
          className="field"
          value={query}
          autoFocus={autoFocus}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder={placeholder}
          aria-label={placeholder}
        />
      </label>
      {open && query.trim().length >= 2 && (
        <div className="menu" style={{ position: 'absolute', left: 0, right: 0, top: '100%', marginTop: 4, zIndex: 20 }}>
          {options.map((item) => (
            <button
              key={item.email}
              type="button"
              className="mi"
              onClick={() => {
                onChange(item);
                setQuery('');
                setOpen(false);
              }}
            >
              <span className="min-w-0">
                <span className="row-title truncate">{item.name}</span>
                <span className="row-sub truncate">
                  {item.email} · {ROLE_LABEL[item.role]}
                </span>
              </span>
            </button>
          ))}
          {options.length === 0 && <div className="hd">Nenhuma conta ativa com esse nome</div>}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------- a guia ------

type AccessObject = Accessible & {
  slug: string;
  name: string;
  grants: Grant[];
  isPublic?: boolean;
};

/**
 * Como a guia grava: `read` não grava (a ficha de leitura); `live` grava cada
 * ação na hora (catálogo e servidor); `draft` só descreve o que se quer, e o
 * Salvar da página envia (a edição da skill — `docs/13` decisão 21).
 */
export type AccessMode<T> =
  | { mode: 'read' }
  | {
      mode: 'live';
      /** Aplica `isPublic` ou `ownerUserUuid` no objeto e devolve o estado novo. */
      onPatch: (body: { isPublic?: boolean; ownerUserUuid?: string }) => Promise<T>;
      onChanged: (updated: T) => void;
    }
  | { mode: 'draft'; draft: AccessDraft; onDraft: (next: AccessDraft) => void };

type RowState = 'saved' | 'new' | 'changed' | 'revoked';

type Row = {
  /** A conta, pelo e-mail: é a chave do rascunho e o que as rotas recebem (`tasks/025`). */
  email: string;
  name: string;
  role: Role;
  level: AccessLevel;
  saved: Grant | null;
  state: RowState;
};

/** As concessões gravadas com o rascunho por cima: as novas no fim. */
function rowsOf(grants: Grant[], draft: AccessDraft | null): Row[] {
  const rows: Row[] = grants.map((grant) => {
    const wanted = draft?.grants[grant.email];
    if (!wanted) return { ...grant, saved: grant, state: 'saved' };
    if (wanted.level === null) return { ...grant, saved: grant, state: 'revoked' };
    return { ...grant, level: wanted.level, saved: grant, state: wanted.level === grant.level ? 'saved' : 'changed' };
  });
  const savedEmails = new Set(grants.map((grant) => grant.email));
  for (const wanted of Object.values(draft?.grants ?? {})) {
    if (savedEmails.has(wanted.email) || wanted.level === null) continue;
    rows.push({ ...wanted, level: wanted.level, saved: null, state: 'new' });
  }
  return rows;
}

/**
 * A linha é de uma conta **desativada**? A concessão dela continua na lista,
 * inerte, e volta a valer se a conta for reativada (`docs/12` §2) — quem
 * administra precisa ver isso para decidir revogar (relatório 039 da auditoria
 * de 2026-09-19). Só concessão gravada pode ser: a busca só oferece conta ativa.
 */
export const isInactiveGrant = (row: { saved: Pick<Grant, 'isActive'> | null }): boolean => row.saved?.isActive === false;

const INACTIVE_HINT =
  'Conta desativada: a concessão não vale enquanto a conta não entra, e volta a valer se ela for reativada. ' +
  'Revogar tira a linha de vez; o nível só muda com a conta ativa.';

const PENDING_LABEL: Record<Exclude<RowState, 'saved'>, string> = {
  new: 'nova, ao salvar',
  changed: 'nível muda ao salvar',
  revoked: 'revogada ao salvar',
};

/**
 * A guia "Acesso" de uma skill, catálogo ou servidor
 * (`docs/12-acesso-granular.md` §5.1, numa tela própria desde a decisão 21 do
 * `13`): à esquerda, quem tem acesso — o dono e as concessões, com o
 * "Compartilhar com"; à direita, o dono (com transferir), a visibilidade e o
 * que cada nível permite. Quem tem só `view` ou `edit` vê o dono e a
 * visibilidade; a lista de contas é de quem tem `manage`.
 */
export function AccessTab<T extends AccessObject>({
  kind,
  object,
  user,
  publicHint,
  privateCount,
  visibility,
  ...how
}: {
  kind: AccessKind;
  object: T;
  user: SessionUser;
  /** O que "público" significa neste tipo, para a caixa. */
  publicHint?: string;
  /** Quantas skills privadas ficariam públicas ao marcar (o aviso da decisão 15). */
  privateCount?: number;
  /** A seção Visibilidade inteira, no lugar da caixa "Público" (o servidor, que tem "aberto"). */
  visibility?: ReactNode;
} & AccessMode<T>) {
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const [target, setTarget] = useState<UserLookup | null>(null);
  const [level, setLevel] = useState<AccessLevel>('view');
  const [newOwner, setNewOwner] = useState<UserLookup | null>(null);

  const draft = how.mode === 'draft' ? how.draft : null;
  const writable = how.mode !== 'read';
  const manages = canManage(object.access);
  const owns = canOwn(object.access) && writable;
  const edits = manages && writable;
  const what = KIND_LABEL[kind];
  const isAdminView = user.role === 'admin';

  const rows = rowsOf(object.grants, draft);
  const isPublic = draft?.isPublic ?? object.isPublic;
  const publicPending = draft?.isPublic !== undefined && draft.isPublic !== object.isPublic;
  // O dono se compara pelo e-mail (`tasks/025`): o `uuid` não vem mais da
  // busca de contas, e comparar os dois dava sempre "dono diferente".
  const pendingOwner = draft?.owner && draft.owner.email !== object.ownerEmail ? draft.owner : null;

  const setDraft = (patch: Partial<AccessDraft>) => {
    if (how.mode === 'draft') how.onDraft({ ...how.draft, ...patch });
  };

  /** Troca o rascunho de uma conta; voltar ao gravado apaga a entrada. */
  const draftGrant = (row: Pick<Row, 'email' | 'name' | 'role'>, next: AccessLevel | null, saved: Grant | null) => {
    if (!draft) return;
    const { [row.email]: _old, ...others } = draft.grants;
    const unchanged = saved ? next === saved.level : next === null;
    setDraft({
      grants: unchanged ? others : { ...others, [row.email]: { email: row.email, name: row.name, role: row.role, level: next } },
    });
  };

  async function live<R>(action: () => Promise<R>): Promise<R | undefined> {
    setBusy(true);
    try {
      return await action();
    } catch (err) {
      toast.error((err as Error).message);
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  async function setPublic(next: boolean) {
    if (how.mode === 'draft') {
      setDraft({ isPublic: next === object.isPublic ? undefined : next });
      return;
    }
    if (how.mode !== 'live') return;
    const updated = await live(() => how.onPatch({ isPublic: next }));
    if (!updated) return;
    how.onChanged(updated);
    toast.success(next ? `${object.name} agora é público.` : `${object.name} voltou a ser privado.`);
  }

  async function transfer(event: FormEvent) {
    event.preventDefault();
    if (!newOwner) return;
    if (how.mode === 'draft') {
      setDraft({ owner: newOwner.email === object.ownerEmail ? undefined : newOwner });
      setNewOwner(null);
      setTransferring(false);
      return;
    }
    if (how.mode !== 'live') return;
    const ok = await confirm({
      title: `Transferir "${object.name}" para ${newOwner.name}?`,
      description: isAdminView
        ? `${newOwner.email} passa a ser o dono, com todos os poderes sobre este ${what}.`
        : `${newOwner.email} passa a ser o dono, e você deixa de ser. Só um administrador ou o novo dono pode devolver.`,
      confirmLabel: 'Transferir',
      danger: !isAdminView,
    });
    if (!ok) return;
    // `ownerUserUuid` aceita o e-mail da conta (`admin/src/access.ts`,
    // `ownerFrom`); é por ele que a busca de contas identifica quem escolher.
    const updated = await live(() => how.onPatch({ ownerUserUuid: newOwner.email }));
    if (!updated) return;
    how.onChanged(updated);
    toast.success(`${object.name} agora é de ${newOwner.email}.`);
    setNewOwner(null);
    setTransferring(false);
  }

  async function grant(event: FormEvent) {
    event.preventDefault();
    if (!target) return;
    if (how.mode === 'draft') {
      draftGrant(target, level, object.grants.find((item) => item.email === target.email) ?? null);
      setTarget(null);
      setLevel('view');
      return;
    }
    if (how.mode !== 'live') return;
    const saved = await live(() => share(kind, object.slug, target.email, level));
    if (!saved) return;
    // A conta é o e-mail: o uuid dela não sai mais do servidor (ver `ownedBy`).
    how.onChanged({ ...object, grants: [...object.grants.filter((item) => item.email !== saved.email), saved] });
    toast.success(`${saved.email} agora pode ${ACCESS_LABEL[saved.level]}.`);
    setTarget(null);
    setLevel('view');
  }

  async function changeLevel(row: Row, next: AccessLevel) {
    if (how.mode === 'draft') {
      draftGrant(row, next, row.saved);
      return;
    }
    if (how.mode !== 'live' || next === row.level) return;
    const saved = await live(() => share(kind, object.slug, row.email, next));
    if (!saved) return;
    how.onChanged({ ...object, grants: object.grants.map((current) => (current.email === saved.email ? saved : current)) });
  }

  async function revoke(row: Row) {
    if (how.mode === 'draft') {
      draftGrant(row, null, row.saved);
      return;
    }
    if (how.mode !== 'live') return;
    const ok = await confirm({
      title: `Tirar o acesso de ${row.name}?`,
      description: `${row.email} deixa de ${ACCESS_LABEL[row.level]} este ${what}. Vínculos que a conta já fez ficam.`,
      confirmLabel: 'Revogar',
      danger: true,
    });
    if (!ok) return;
    const done = await live(() => unshare(kind, object.slug, row.email));
    if (!done) return;
    how.onChanged({ ...object, grants: object.grants.filter((current) => current.email !== row.email) });
    toast.success(`${row.email} perdeu o acesso.`);
  }

  /** Desfaz o rascunho de uma conta: volta ao gravado. */
  const undo = (row: Row) => row.saved ? draftGrant(row, row.saved.level, row.saved) : draftGrant(row, null, null);

  // A busca refaz a consulta quando o conjunto muda: ele só muda com as contas.
  // São e-mails, porque é assim que a busca identifica a conta (`tasks/025`) —
  // com `uuid` de um lado e e-mail do outro, nada era escondido.
  const excludedKey = [...rows.map((row) => row.email), object.ownerEmail ?? '', pendingOwner?.email ?? ''].join(' ');
  const excluded = useMemo(() => new Set(excludedKey.split(' ').filter(Boolean)), [excludedKey]);
  // Transferir para quem tem concessão vale: a concessão some com a transferência.
  const notOwners = useMemo(() => new Set(object.ownerEmail ? [object.ownerEmail] : []), [object.ownerEmail]);
  const activeCount = rows.filter((row) => row.state !== 'revoked').length;

  return (
    <div className="access-tab grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,360px)]">
      <Panel
        title="Quem tem acesso"
        icon={<Users />}
        actions={manages ? <span className="row-sub !mb-0">{activeCount === 1 ? '1 concessão' : `${activeCount} concessões`}</span> : undefined}
      >
        <p className="panel-hint">
          Além do dono, só as contas desta lista — e os administradores, que veem e mudam tudo.
          {draft && edits && ' Conceder, mudar o nível e revogar ficam pendentes até o botão Salvar.'}
        </p>

        {edits && (
          <form onSubmit={grant} className="access-share">
            <span className="label">Compartilhar com</span>
            <div className="access-share-row">
              <div className="min-w-0 flex-1">
                <UserPicker value={target} onChange={setTarget} exclude={excluded} />
              </div>
              <select className="field" style={{ maxWidth: 340 }} value={level} onChange={(event) => setLevel(event.target.value as AccessLevel)} aria-label="Nível">
                {ACCESS_LEVELS.map((item) => (
                  <option key={item} value={item}>
                    {ACCESS_LABEL[item]} — {ACCESS_HINT[item]}
                  </option>
                ))}
              </select>
              <Button type="submit" disabled={busy || !target}>
                Conceder
              </Button>
            </div>
          </form>
        )}

        <div className="table-wrap mt-3">
          <table className="data">
            <thead>
              <tr>
                <th>Conta</th>
                <th>Nível</th>
                <th className="hidden md:table-cell">Concedido</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <span className="flex items-center gap-2">
                    <Crown style={{ width: 14, height: 14, color: 'var(--accent-soft)' }} />
                    <span className="min-w-0">
                      <span className="row-title truncate">{object.ownerEmail ?? 'Sem dono'}</span>
                      <span className="row-sub truncate">
                        {object.ownerEmail === null
                          ? 'só os administradores mandam aqui'
                          : ownedBy(object, user)
                            ? 'você'
                            : 'o dono faz tudo, inclusive apagar e transferir'}
                      </span>
                    </span>
                  </span>
                </td>
                <td>
                  <Badge tone="accent">dono</Badge>
                </td>
                <td className="hidden md:table-cell" />
                <td className="num">
                  {pendingOwner && <Badge tone="warn">passa a {pendingOwner.email} ao salvar</Badge>}
                </td>
              </tr>
              {manages &&
                rows.map((row) => (
                  <tr key={row.email} className={cx(row.state !== 'saved' && 'is-pending', row.state === 'revoked' && 'is-removed')}>
                    <td>
                      <span className="flex items-center gap-2">
                        <UserRound style={{ width: 14, height: 14, color: 'var(--text-faint)' }} />
                        <span className="min-w-0">
                          <span className="row-title truncate">{row.name}</span>
                          {isInactiveGrant(row) ? (
                            <span className="row-sub flex flex-wrap items-center gap-1.5">
                              {row.email} · {ROLE_LABEL[row.role]}
                              <Badge tone="warn" title={INACTIVE_HINT}>
                                conta desativada
                              </Badge>
                            </span>
                          ) : (
                            <span className="row-sub truncate">
                              {row.email} · {ROLE_LABEL[row.role]}
                            </span>
                          )}
                        </span>
                      </span>
                    </td>
                    <td>
                      {/* O nível de conta desativada não muda: conceder e mudar o nível são a mesma
                          chamada, que exige conta ativa — um seletor aqui só renderia um erro (e, no
                          rascunho da skill, uma pendência que nenhum Salvar resolve). */}
                      {!edits || row.state === 'revoked' || isInactiveGrant(row) ? (
                        <Badge tone="info" title={ACCESS_HINT[row.level]}>
                          {ACCESS_LABEL[row.level]}
                        </Badge>
                      ) : (
                        <select
                          className="field"
                          style={{ minWidth: 130 }}
                          value={row.level}
                          disabled={busy}
                          onChange={(event) => void changeLevel(row, event.target.value as AccessLevel)}
                          aria-label={`Nível de ${row.email}`}
                        >
                          {ACCESS_LEVELS.map((option) => (
                            <option key={option} value={option}>
                              {ACCESS_LABEL[option]}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td className="hidden md:table-cell">
                      {row.saved ? (
                        <span className="row-sub whitespace-nowrap">
                          {formatDateTime(row.saved.createdAt)}
                          {row.saved.grantedByEmail && ` por ${row.saved.grantedByEmail}`}
                        </span>
                      ) : (
                        <span className="row-sub">—</span>
                      )}
                    </td>
                    <td className="num">
                      <span className="flex items-center justify-end gap-2">
                        {row.state !== 'saved' && <Badge tone="warn">{PENDING_LABEL[row.state]}</Badge>}
                        {edits && row.state !== 'saved' && (
                          <button type="button" className="row-action" title="Desfazer" onClick={() => undo(row)}>
                            <Undo2 />
                          </button>
                        )}
                        {edits && row.state !== 'revoked' && (
                          <button type="button" className="row-action danger" title="Revogar" disabled={busy} onClick={() => void revoke(row)}>
                            <Trash2 />
                          </button>
                        )}
                      </span>
                    </td>
                  </tr>
                ))}
              {manages && rows.length === 0 && <EmptyRow colSpan={4}>Nenhuma concessão: só o dono e os administradores</EmptyRow>}
            </tbody>
          </table>
        </div>

        {!manages && (
          <p className="panel-hint mt-3 mb-0">Quem mais tem acesso é visível só para quem administra este {what}.</p>
        )}
      </Panel>

      <div className="grid content-start gap-4">
        <Panel title="Dono" icon={<Crown />}>
          <dl className="kv">
            <dt>Dono</dt>
            <dd>
              {object.ownerEmail ?? 'nenhum (só administradores)'}
              {ownedBy(object, user) && ' — você'}
            </dd>
            <dt>Seu acesso</dt>
            <dd>{isAdminView ? 'administrador: tudo' : object.access ? ACCESS_LABEL[object.access] : '—'}</dd>
          </dl>

          {pendingOwner && (
            <div className="alert warn mt-3">
              <span className="min-w-0 flex-1">
                Passa a ser de <strong>{pendingOwner.email}</strong> quando você salvar.
                {!isAdminView && ' Você deixa de ser o dono.'}
              </span>
              <Button variant="quiet" size="sm" onClick={() => setDraft({ owner: undefined })}>
                <Undo2 /> desfazer
              </Button>
            </div>
          )}

          {owns && !transferring && !pendingOwner && (
            <Button variant="ghost" size="sm" className="mt-3" onClick={() => setTransferring(true)} disabled={busy}>
              Transferir para outra conta
            </Button>
          )}
          {transferring && (
            <form onSubmit={transfer} className="mt-3 grid gap-2">
              <UserPicker value={newOwner} onChange={setNewOwner} autoFocus placeholder="Quem passa a ser o dono" exclude={notOwners} />
              <div className="flex items-center gap-2">
                <Button type="submit" size="sm" disabled={busy || !newOwner}>
                  Transferir
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setTransferring(false);
                    setNewOwner(null);
                  }}
                >
                  Cancelar
                </Button>
              </div>
              {draft && <p className="hint !mt-0">A transferência vai junto com o Salvar, por último.</p>}
            </form>
          )}
        </Panel>

        <Panel title="Visibilidade" icon={<Globe />}>
          {visibility ??
            (object.isPublic !== undefined && (
              <>
                {edits ? (
                  <label className="check items-start" title={publicHint}>
                    <input type="checkbox" checked={Boolean(isPublic)} disabled={busy} onChange={(event) => void setPublic(event.target.checked)} />
                    <span>
                      Público: qualquer conta do painel e o site leem, sem concessão
                      {publicHint && <span className="hint">{publicHint}</span>}
                    </span>
                  </label>
                ) : (
                  <p className="mb-0">
                    {isPublic ? (
                      <>
                        <strong>Público</strong>: qualquer conta do painel e o site leem, sem concessão.
                      </>
                    ) : (
                      <>
                        <strong>Privado</strong>: só o dono, os administradores e as contas com concessão.
                      </>
                    )}
                    {publicHint && isPublic && <span className="hint">{publicHint}</span>}
                  </p>
                )}
                {publicPending && (
                  <p className="mt-2 mb-0">
                    <Badge tone="warn">{isPublic ? 'fica pública ao salvar' : 'volta a privada ao salvar'}</Badge>
                  </p>
                )}
                {!isPublic && edits && (privateCount ?? 0) > 0 && (
                  <p className="hint">
                    Ao marcar, {privateCount === 1 ? '1 skill privada fica pública' : `${privateCount} skills privadas ficam públicas`} por aqui.
                  </p>
                )}
                {writable && !manages && <p className="hint">Só quem administra este {what} muda a visibilidade.</p>}
              </>
            ))}
        </Panel>

        <Panel title="Níveis" icon={<ShieldCheck />}>
          <dl className="kv">
            {ACCESS_LEVELS.map((item) => (
              <FragmentLevel key={item} level={item} />
            ))}
            <dt>{ACCESS_LABEL.owner}</dt>
            <dd>Tudo, inclusive apagar e transferir. Os administradores são donos de tudo.</dd>
          </dl>
          <p className="panel-hint mt-3 mb-0">Os níveis são cumulativos: administrar inclui editar, e editar inclui visualizar.</p>
        </Panel>
      </div>
    </div>
  );
}

function FragmentLevel({ level }: { level: AccessLevel }) {
  return (
    <>
      <dt>{ACCESS_LABEL[level]}</dt>
      <dd>{ACCESS_HINT[level]}</dd>
    </>
  );
}

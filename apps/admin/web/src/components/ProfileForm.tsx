import { useEffect, useRef, useState } from 'react';
import { Globe, Image, Link2, Plus, Trash2, UserRound } from 'lucide-react';
import {
  type ProfileLink,
  type UserProfile,
  deleteMyAvatar,
  getMyProfile,
  saveMyProfile,
  uploadMyAvatar,
} from '../api.js';
import { Avatar } from './Avatar.js';
import { Button, Field, Panel, Skel } from './ui.js';
import { useToast } from './Toast.js';

/**
 * O formulário do **próprio** perfil (`docs/20-perfil.md`).
 *
 * Quem escreve é o dono, e não existe versão desta tela para editar o perfil de
 * outra pessoa: o admin só tem "limpar perfil", na ficha da conta. Por isso o
 * componente não recebe uma conta por parâmetro — ele sempre fala de `/api/me`.
 *
 * As duas guias de edição — "Perfil" e "Dados públicos" — são **um** componente
 * com `section`, e não dois: o perfil é uma leitura só e um salvamento só, e
 * partir o estado em dois formulários faria a segunda guia buscar de novo o que
 * a primeira já tinha. Quem monta (`AccountEditorPage`) mantém o componente no
 * lugar ao trocar de guia, então o que foi digitado e ainda não salvo continua
 * lá.
 */

const BIO_MAX = 500;
const LINKS_MAX = 8;

/** Uma linha do editor de links. `id` é só da tela: dá `key` estável a linha vazia. */
type LinhaDeLink = ProfileLink & { id: number };

let proximoId = 1;
const comId = (link: ProfileLink): LinhaDeLink => ({ ...link, id: proximoId++ });

export function ProfileForm({
  section,
  onSaved,
}: {
  /** Qual guia desenhar; o estado é o mesmo nas duas. */
  section: 'perfil' | 'publico';
  onSaved?: (profile: UserProfile) => void;
}) {
  const toast = useToast();
  const arquivo = useRef<HTMLInputElement>(null);

  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [name, setName] = useState('');
  const [bio, setBio] = useState('');
  const [websiteUrl, setWebsite] = useState('');
  const [links, setLinks] = useState<LinhaDeLink[]>([]);
  const [busy, setBusy] = useState(false);

  const hidratar = (fresh: UserProfile) => {
    setProfile(fresh);
    setName(fresh.name);
    setBio(fresh.bio);
    setWebsite(fresh.websiteUrl ?? '');
    setLinks(fresh.links.map(comId));
  };

  useEffect(() => {
    let ativo = true;
    getMyProfile()
      .then((fresh) => ativo && hidratar(fresh))
      .catch((err) => ativo && toast.error((err as Error).message));
    return () => {
      ativo = false;
    };
  }, [toast]);

  if (!profile) return <Skel h={420} />;

  const aplicar = (fresh: UserProfile) => {
    hidratar(fresh);
    onSaved?.(fresh);
  };

  async function salvar() {
    setBusy(true);
    try {
      // As linhas em branco somem no envio em vez de virarem erro: quem clicou
      // em "adicionar link" e desistiu não deve ser impedido de salvar o resto.
      const limpos = links
        .map(({ label, url }) => ({ label: label.trim(), url: url.trim() }))
        .filter((link) => link.label || link.url);

      aplicar(
        await saveMyProfile({
          name,
          bio,
          websiteUrl: websiteUrl.trim() || null,
          links: limpos,
        }),
      );
      toast.success('Perfil salvo.');
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /**
   * O interruptor do público grava **na hora**, sozinho, sem passar pelo
   * Salvar. Publicar ou despublicar é a ação mais consequente desta tela, e ela
   * não pode ficar pendurada num botão que a pessoa talvez não clique: quem
   * desliga o perfil quer que ele saia do ar agora.
   */
  async function alternarPublico(isPublic: boolean) {
    setBusy(true);
    try {
      aplicar(await saveMyProfile({ isPublic }));
      toast.success(isPublic ? 'Perfil publicado.' : 'Perfil despublicado.');
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function enviarFoto(file: File) {
    setBusy(true);
    try {
      aplicar(await uploadMyAvatar(file));
      toast.success('Foto atualizada.');
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
      // Sem isto, escolher o **mesmo** arquivo de novo (depois de um erro, por
      // exemplo) não dispara `change` e a tela parece travada.
      if (arquivo.current) arquivo.current.value = '';
    }
  }

  async function removerFoto() {
    setBusy(true);
    try {
      aplicar(await deleteMyAvatar());
      toast.success('Foto removida.');
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const bioRestante = BIO_MAX - bio.length;

  if (section === 'perfil') {
    return (
      <Panel title="Perfil" icon={<UserRound />}>
        <div className="grid gap-4">
          <div className="flex items-center gap-4">
            <Avatar
              username={profile.username}
              name={name || profile.name}
              stamp={profile.avatarUpdatedAt}
              className="xl"
            />
            <div className="grid gap-2">
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => arquivo.current?.click()}
                >
                  <Image /> {profile.hasAvatar ? 'Trocar foto' : 'Enviar foto'}
                </Button>
                {profile.hasAvatar && (
                  <Button variant="quiet" size="sm" disabled={busy} onClick={() => void removerFoto()}>
                    <Trash2 /> Remover
                  </Button>
                )}
              </div>
              <p className="hint">
                PNG, JPEG ou WebP, até 512 KB. A imagem entra como veio — ela é recortada em
                círculo pelo centro, então o que importa deve estar no meio.
              </p>
            </div>
          </div>

          <input
            ref={arquivo}
            type="file"
            className="hidden"
            accept="image/png,image/jpeg,image/webp"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void enviarFoto(file);
            }}
          />

          <Field label="Nome de exibição" hint="É como o seu nome aparece no painel e no site.">
            <input
              className="field"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={120}
            />
          </Field>

          <Field
            label="Usuário"
            hint="O seu identificador público. Só um administrador pode trocá-lo — e o antigo não volta a ficar livre."
          >
            <input className="field field-mono" value={`@${profile.username}`} disabled />
          </Field>

          <div className="actions">
            {/* O Salvar é o mesmo das duas guias: ele manda o perfil inteiro,
                porque o estado também é um só. Ter um botão em cada guia evita
                a armadilha de digitar o nome aqui e sair pela outra. */}
            <Button disabled={busy || bioRestante < 0} onClick={() => void salvar()}>
              {busy ? 'Salvando…' : 'Salvar perfil'}
            </Button>
          </div>
        </div>
      </Panel>
    );
  }

  return (
    <Panel title="Dados públicos" icon={<Globe />}>
      <p className="panel-hint">
        {profile.isPublic ? (
          <>
            O seu perfil está <strong>no ar</strong> em <code>/u/{profile.username}</code>: qualquer
            visitante vê o que está aqui, e os buscadores podem indexá-lo. O seu e-mail{' '}
            <strong>não</strong> aparece — ele nunca sai para outras contas.
          </>
        ) : (
          <>
            O seu perfil está <strong>fora do ar</strong>. Nada daqui aparece para visitantes; o
            que você escrever fica guardado até você publicar. O seu e-mail não aparece em
            nenhum dos dois casos.
          </>
        )}
      </p>

      <div className="grid gap-4">
        <Field
          label="Descrição"
          hint={`Texto simples, até ${BIO_MAX} caracteres. ${
            bioRestante < 0 ? `${-bioRestante} a mais do que cabe.` : `Restam ${bioRestante}.`
          }`}
        >
          <textarea
            className="field"
            rows={4}
            value={bio}
            onChange={(event) => setBio(event.target.value)}
            placeholder="O que você mantém por aqui."
          />
        </Field>

        <Field label="Site" hint="Um endereço http(s).">
          <input
            className="field"
            value={websiteUrl}
            onChange={(event) => setWebsite(event.target.value)}
            placeholder="https://exemplo.dev"
            inputMode="url"
          />
        </Field>

        <div className="grid gap-2">
          <span className="field-label">Links</span>
          {links.map((link, i) => (
            <div key={link.id} className="flex flex-wrap items-center gap-2">
              <input
                className="field"
                style={{ maxWidth: 180 }}
                value={link.label}
                maxLength={40}
                placeholder="GitHub"
                aria-label={`Rótulo do link ${i + 1}`}
                onChange={(event) =>
                  setLinks((atual) =>
                    atual.map((l) => (l.id === link.id ? { ...l, label: event.target.value } : l)),
                  )
                }
              />
              <input
                className="field min-w-0 flex-1"
                value={link.url}
                placeholder="https://github.com/voce"
                inputMode="url"
                aria-label={`Endereço do link ${i + 1}`}
                onChange={(event) =>
                  setLinks((atual) =>
                    atual.map((l) => (l.id === link.id ? { ...l, url: event.target.value } : l)),
                  )
                }
              />
              <Button
                variant="quiet"
                size="sm"
                aria-label={`Remover o link ${i + 1}`}
                onClick={() => setLinks((atual) => atual.filter((l) => l.id !== link.id))}
              >
                <Trash2 />
              </Button>
            </div>
          ))}
          {links.length < LINKS_MAX && (
            <div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setLinks((atual) => [...atual, comId({ label: '', url: '' })])}
              >
                <Plus /> Adicionar link
              </Button>
            </div>
          )}
          <p className="hint">
            Até {LINKS_MAX}. Os endereços conhecidos ganham o ícone da rede; o resto entra com um
            ícone genérico.
          </p>
        </div>

        <div className="actions">
          {/* O publicar grava sozinho — ver `alternarPublico`. Por isso ele é
              um botão à parte e não um campo do formulário. */}
          <Button
            variant={profile.isPublic ? 'quiet' : 'ghost'}
            disabled={busy}
            onClick={() => void alternarPublico(!profile.isPublic)}
          >
            <Link2 /> {profile.isPublic ? 'Tirar do ar' : 'Publicar perfil'}
          </Button>
          <Button disabled={busy || bioRestante < 0} onClick={() => void salvar()}>
            {busy ? 'Salvando…' : 'Salvar perfil'}
          </Button>
        </div>
      </div>
    </Panel>
  );
}

import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  fetchPublicProfile,
  profileAvatarUrl,
  type PublicProfile,
} from '../api.js';
import { SkillCard } from '../components/SkillCard.js';
import {
  ArrowLeftIcon,
  GlobeIcon,
  LayersIcon,
  LinkIcon,
  SOCIAL_ICON,
  UserIcon,
} from '../components/Icons.js';
import { socialNetworkOf } from '@purple-skills/shared/profile';
import { useMeta } from '../useMeta.js';

/**
 * A página pública de uma conta (`docs/20-perfil.md` §7).
 *
 * Perfil privado, conta desativada e username inexistente chegam aqui como o
 * **mesmo** 404, porque a rota do servidor responde igual aos três: distingui-los
 * seria dizer "esta conta existe, mas não quer ser vista", que é a informação
 * que o opt-in existe para não dar. Esta tela nem sabe qual dos casos ocorreu.
 */
export function ProfilePage() {
  const { username = '' } = useParams();
  const meta = useMeta();
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let ativo = true;
    setProfile(null);
    setError(null);
    window.scrollTo({ top: 0 });

    fetchPublicProfile(username)
      .then((data) => ativo && setProfile(data))
      .catch((err: Error) => ativo && setError(err.message));

    return () => {
      ativo = false;
    };
  }, [username]);

  useEffect(() => {
    const nome = meta?.name ?? 'Purple Skills';
    document.title = profile ? `${profile.name} (@${profile.username}) — ${nome}` : nome;
  }, [profile, meta]);

  if (error) {
    return (
      <section className="skill-page">
        <div className="wrap">
          <div className="empty" style={{ maxWidth: '30rem', margin: '40px auto' }}>
            <img className="wiz" src="/assets/images/icon-purple-right-279x400.png" alt="" />
            <h3>Perfil não encontrado</h3>
            <p>Esta pessoa não tem um perfil público por aqui.</p>
            <Link to="/#skills" className="btn btn-primary" style={{ marginTop: '18px' }}>
              <ArrowLeftIcon /> Ver as skills
            </Link>
          </div>
        </div>
      </section>
    );
  }

  if (!profile) {
    return (
      <section className="skill-page">
        <div className="wrap" style={{ display: 'grid', gap: '16px' }}>
          <div className="skel" style={{ height: '6rem', maxWidth: '28rem' }} />
          <div className="skel" style={{ height: '1.2rem', maxWidth: '40rem' }} />
          <div className="skel" style={{ height: '18rem' }} />
        </div>
      </section>
    );
  }

  const foto = profileAvatarUrl(profile.username, profile.avatarUpdatedAt);

  return (
    <section className="skill-page">
      <div className="wrap">
        <Link to="/#skills" className="back-link">
          <ArrowLeftIcon /> Skills
        </Link>

        <header className="profile-head">
          {foto ? (
            <img className="profile-photo" src={foto} alt="" />
          ) : (
            <span className="profile-photo is-mono" aria-hidden>
              <UserIcon />
            </span>
          )}
          <div className="min-w-0">
            <h1 className="display">{profile.name}</h1>
            <p className="profile-handle mono">@{profile.username}</p>
            {/* `white-space: pre-line` no CSS: a bio é texto puro, e as quebras
                que a pessoa escreveu são as únicas que aparecem (decisão 8). */}
            {profile.bio && <p className="profile-bio">{profile.bio}</p>}

            {(profile.websiteUrl || profile.links.length > 0) && (
              <div className="profile-links">
                {profile.websiteUrl && (
                  <a
                    href={profile.websiteUrl}
                    className="profile-link"
                    target="_blank"
                    /* `noopener` e `nofollow` porque o destino é escrito por
                       quem tem conta: sem eles, o perfil vira um lugar de
                       empurrar reputação para um endereço qualquer. */
                    rel="noreferrer noopener nofollow"
                  >
                    <GlobeIcon /> {hostDe(profile.websiteUrl)}
                  </a>
                )}
                {profile.links.map((link) => {
                  // O host conhecido escolhe o ícone; qualquer outro entra com
                  // o genérico (`docs/20-perfil.md` decisão 5). `socialNetworkOf`
                  // **não** valida nada — a lista de links é livre, e uma rede
                  // fora do mapa é resultado normal, não recusa.
                  const rede = socialNetworkOf(link.url);
                  const Icone = rede ? (SOCIAL_ICON[rede] ?? LinkIcon) : LinkIcon;
                  return (
                    <a
                      key={link.url}
                      href={link.url}
                      className="profile-link"
                      target="_blank"
                      rel="noreferrer noopener nofollow"
                    >
                      <Icone /> {link.label}
                    </a>
                  );
                })}
              </div>
            )}
          </div>
        </header>

        {profile.skills.length > 0 && (
          <>
            <h2 className="section-label">Skills públicas</h2>
            <div className="skill-grid">
              {profile.skills.map((skill) => (
                <SkillCard key={skill.uuid} skill={skill} />
              ))}
            </div>
          </>
        )}

        {profile.catalogs.length > 0 && (
          <>
            <h2 className="section-label">Catálogos públicos</h2>
            <div className="skill-grid">
              {profile.catalogs.map((catalog) => (
                <Link key={catalog.uuid} to={`/catalogs/${catalog.slug}`} className="skill-card">
                  <div className="sk-top">
                    <span className="sk-id">
                      <LayersIcon />
                      <span className="slug mono">{catalog.slug}</span>
                    </span>
                  </div>
                  <h3>{catalog.name}</h3>
                  {catalog.description && <p>{catalog.description}</p>}
                  <div className="sk-meta">
                    <span>
                      {catalog.skillCount} {catalog.skillCount === 1 ? 'skill' : 'skills'}
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          </>
        )}

        {profile.skills.length === 0 && profile.catalogs.length === 0 && (
          <p className="skill-head-note">
            Esta pessoa ainda não publicou nada por aqui.
          </p>
        )}
      </div>
    </section>
  );
}

/** O host, para o link do site não ficar com a URL inteira na tela. */
function hostDe(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

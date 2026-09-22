import type { ReactElement } from 'react';

type Props = { className?: string };

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
} as const;

export const SearchIcon = ({ className }: Props) => (
  <svg className={className} viewBox="0 0 24 24" {...stroke}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" strokeLinecap="round" />
  </svg>
);

export const DownloadIcon = ({ className }: Props) => (
  <svg className={className} viewBox="0 0 24 24" {...stroke}>
    <path d="M12 3v12m0 0 4-4m-4 4-4-4" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" strokeLinecap="round" />
  </svg>
);

export const LinkIcon = ({ className }: Props) => (
  <svg className={className} viewBox="0 0 24 24" {...stroke}>
    <path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1" strokeLinecap="round" />
    <path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1" strokeLinecap="round" />
  </svg>
);

export const CheckIcon = ({ className }: Props) => (
  <svg className={className} viewBox="0 0 24 24" {...stroke} strokeWidth={2.2}>
    <path d="m5 13 4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const EyeIcon = ({ className }: Props) => (
  <svg className={className} viewBox="0 0 24 24" {...stroke}>
    <path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6Z" />
    <circle cx="12" cy="12" r="2.5" />
  </svg>
);

/** A autoria da skill e do catálogo (`docs/19-username.md` decisão 11). */
export const UserIcon = ({ className }: Props) => (
  <svg className={className} viewBox="0 0 24 24" {...stroke}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" strokeLinejoin="round" />
  </svg>
);

export const FileIcon = ({ className }: Props) => (
  <svg className={className} viewBox="0 0 24 24" {...stroke}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" strokeLinejoin="round" />
    <path d="M14 3v5h5" strokeLinejoin="round" />
  </svg>
);

export const ArrowLeftIcon = ({ className }: Props) => (
  <svg className={className} viewBox="0 0 24 24" {...stroke}>
    <path d="M19 12H5m0 0 6-6m-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const ArrowRightIcon = ({ className }: Props) => (
  <svg className={className} viewBox="0 0 24 24" {...stroke} strokeWidth={2.4}>
    <path d="M5 12h13m0 0-6-6m6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const PlugIcon = ({ className }: Props) => (
  <svg className={className} viewBox="0 0 24 24" {...stroke}>
    <path d="M9 2v6M15 2v6" strokeLinecap="round" />
    <path d="M6 8h12v3a6 6 0 0 1-6 6 6 6 0 0 1-6-6z" strokeLinejoin="round" />
    <path d="M12 17v5" strokeLinecap="round" />
  </svg>
);

export const TagIcon = ({ className }: Props) => (
  <svg className={className} viewBox="0 0 24 24" {...stroke}>
    <path d="M3 12V4h8l9 9-8 8z" strokeLinejoin="round" />
    <circle cx="7.5" cy="7.5" r="1.4" />
  </svg>
);

export const ListIcon = ({ className }: Props) => (
  <svg className={className} viewBox="0 0 24 24" {...stroke}>
    <path d="M4 7h16M4 12h16M4 17h10" strokeLinecap="round" />
    <circle cx="19" cy="17" r="2" />
  </svg>
);

export const DatabaseIcon = ({ className }: Props) => (
  <svg className={className} viewBox="0 0 24 24" {...stroke}>
    <ellipse cx="12" cy="6" rx="8" ry="3" />
    <path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6" strokeLinecap="round" />
    <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" strokeLinecap="round" />
  </svg>
);

export const ShieldIcon = ({ className }: Props) => (
  <svg className={className} viewBox="0 0 24 24" {...stroke}>
    <path d="M12 3l8 3v6c0 5-3.4 8-8 9-4.6-1-8-4-8-9V6z" strokeLinejoin="round" />
    <path d="m9 12 2 2 4-4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const BoxIcon = ({ className }: Props) => (
  <svg className={className} viewBox="0 0 24 24" {...stroke}>
    <path d="m12 3 9 5-9 5-9-5z" strokeLinejoin="round" />
    <path d="m3 13 9 5 9-5" strokeLinejoin="round" />
  </svg>
);

export const GlobeIcon = ({ className }: Props) => (
  <svg className={className} viewBox="0 0 24 24" {...stroke}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3c2.6 2.4 4 5.6 4 9s-1.4 6.6-4 9c-2.6-2.4-4-5.6-4-9s1.4-6.6 4-9Z" strokeLinejoin="round" />
  </svg>
);

export const ServerIcon = ({ className }: Props) => (
  <svg className={className} viewBox="0 0 24 24" {...stroke}>
    <rect x="3" y="4" width="18" height="7" rx="2" />
    <rect x="3" y="13" width="18" height="7" rx="2" />
    <path d="M7 7.5h.01M7 16.5h.01" strokeLinecap="round" />
  </svg>
);

export const SunIcon = ({ className }: Props) => (
  <svg className={className} viewBox="0 0 24 24" {...stroke}>
    <circle cx="12" cy="12" r="4.5" />
    <path
      d="M12 2v2M12 20v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2 12h2M20 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"
      strokeLinecap="round"
    />
  </svg>
);

export const MoonIcon = ({ className }: Props) => (
  <svg className={className} viewBox="0 0 24 24" {...stroke}>
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" strokeLinejoin="round" />
  </svg>
);

export const GithubIcon = ({ className }: Props) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 .5C5.4.5 0 5.9 0 12.6c0 5.3 3.4 9.8 8.2 11.4.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.3-1.8-1.3-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0C17.3 5 18.3 5.3 18.3 5.3c.6 1.7.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 24 12.6C24 5.9 18.6.5 12 .5Z" />
  </svg>
);

/**
 * Os ícones das redes conhecidas do perfil (`docs/20-perfil.md` decisão 5).
 *
 * São **marcas simplificadas**, desenhadas para ler a 14px, e não os logotipos
 * oficiais: o que se quer é distinguir uma linha da outra no cartão, não
 * reproduzir identidade visual de terceiro. Quem não está aqui entra com o
 * `LinkIcon` genérico — acrescentar uma rede é acrescentar um `host` em
 * `packages/shared/src/profile.ts` e uma entrada neste mapa, sem tocar em regra
 * nenhuma.
 *
 * O GitHub reusa o `GithubIcon` que o rodapé já tem.
 */
const GitlabIcon = ({ className }: Props) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 22 8.6 11.5h6.8L12 22Zm-9.3-10.5h5.9L12 22 2.7 11.5Zm0 0L4.4 6l2.2 5.5H2.7Zm18.6 0h-5.9L12 22l9.3-10.5Zm0 0L19.6 6l-2.2 5.5h4Z" />
  </svg>
);

const LinkedinIcon = ({ className }: Props) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor">
    <path d="M4.98 3.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5ZM3 9h4v12H3V9Zm7 0h3.8v1.7h.05c.53-.95 1.83-1.95 3.75-1.95C21.4 8.75 22 11 22 14v7h-4v-6.2c0-1.5-.03-3.4-2.1-3.4-2.1 0-2.4 1.6-2.4 3.3V21h-4V9Z" />
  </svg>
);

const XIcon = ({ className }: Props) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor">
    <path d="M18.2 2h3.3l-7.2 8.3L23 22h-6.7l-5.2-6.9L5.1 22H1.8l7.7-8.9L1 2h6.8l4.7 6.3L18.2 2Zm-1.2 18h1.8L7.1 3.9H5.2L17 20Z" />
  </svg>
);

const MastodonIcon = ({ className }: Props) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 2c3.3 0 5.6.5 6.9 1.6 1.3 1 2 2.7 2.1 5v5c0 1.6-.5 2.9-1.5 3.8-1 .9-2.4 1.4-4 1.5l-3 .2v-2.2l2.7-.2c1-.1 1.7-.4 2.2-.8.4-.4.7-1 .7-1.8V9c0-1.5-.4-2.6-1.1-3.2-.7-.7-1.7-1-3-1h-.2c-1.5 0-2.6.5-3.3 1.4-.7-.9-1.8-1.4-3.3-1.4h-.2c-1.3 0-2.3.3-3 1C3.4 6.4 3 7.5 3 9v6.3H5.6V9.3c0-1 .5-1.5 1.4-1.5.9 0 1.4.6 1.4 1.7v3.3h2.5V9.5c0-1.1.4-1.7 1.4-1.7.9 0 1.4.5 1.4 1.5v6h2.6V9.3c0-1.5-.4-2.6-1.1-3.3" />
  </svg>
);

const BlueskyIcon = ({ className }: Props) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 10.8C10.9 8.6 7.9 4.6 5.2 3 2.6 1.4 1.6 1.7 1 2.6.3 3.6.7 8.5 1 9.4c.3 1 1.2 1.6 2.4 1.8-1.2.2-2.2.7-2.4 1.9-.3 1.4 1.7 5.3 3.4 6.3 1.4.8 3-.2 4-1.3.8-.9 1.2-1.8 1.6-2.7.4.9.8 1.8 1.6 2.7 1 1.1 2.6 2.1 4 1.3 1.7-1 3.7-4.9 3.4-6.3-.2-1.2-1.2-1.7-2.4-1.9 1.2-.2 2.1-.8 2.4-1.8.3-.9.7-5.8 0-6.8-.6-.9-1.6-1.2-4.2.4-2.7 1.6-5.7 5.6-6.8 7.8Z" />
  </svg>
);

const YoutubeIcon = ({ className }: Props) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor">
    <path d="M23 12s0-3.9-.5-5.7a3 3 0 0 0-2.1-2.1C18.6 3.7 12 3.7 12 3.7s-6.6 0-8.4.5a3 3 0 0 0-2.1 2.1C1 8.1 1 12 1 12s0 3.9.5 5.7a3 3 0 0 0 2.1 2.1c1.8.5 8.4.5 8.4.5s6.6 0 8.4-.5a3 3 0 0 0 2.1-2.1c.5-1.8.5-5.7.5-5.7ZM9.9 15.4V8.6l5.8 3.4-5.8 3.4Z" />
  </svg>
);

const InstagramIcon = ({ className }: Props) => (
  <svg className={className} viewBox="0 0 24 24" {...stroke}>
    <rect x="2.5" y="2.5" width="19" height="19" rx="5" />
    <circle cx="12" cy="12" r="4" />
    <circle cx="17.5" cy="6.5" r="1.1" fill="currentColor" stroke="none" />
  </svg>
);

/** Os ids são os de `socialNetworkOf`, em `packages/shared/src/profile.ts`. */
export const SOCIAL_ICON: Record<string, (props: Props) => ReactElement> = {
  github: GithubIcon,
  gitlab: GitlabIcon,
  linkedin: LinkedinIcon,
  x: XIcon,
  mastodon: MastodonIcon,
  bluesky: BlueskyIcon,
  youtube: YoutubeIcon,
  instagram: InstagramIcon,
};

export const ExternalLinkIcon = ({ className }: Props) => (
  <svg className={className} viewBox="0 0 24 24" {...stroke}>
    <path d="M14 4h6v6" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M20 4 11 13" strokeLinecap="round" />
    <path
      d="M18 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const ChevronRightIcon = ({ className }: Props) => (
  <svg className={className} viewBox="0 0 24 24" {...stroke} strokeWidth={2.4}>
    <path d="m9 5 7 7-7 7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const CopyIcon = ({ className }: Props) => (
  <svg className={className} viewBox="0 0 24 24" {...stroke}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M15 6.5V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h1.5" strokeLinecap="round" />
  </svg>
);

export const LayersIcon = ({ className }: Props) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m12 2 9 4.5-9 4.5-9-4.5L12 2Z" />
    <path d="m3 12 9 4.5 9-4.5" />
    <path d="m3 17 9 4.5 9-4.5" />
  </svg>
);

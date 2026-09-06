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

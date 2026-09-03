type Props = { className?: string };

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 2 } as const;

export const DashboardIcon = ({ className }: Props) => (
  <svg className={className} viewBox="0 0 24 24" {...stroke}>
    <rect x="3" y="3" width="7" height="8" rx="1.5" />
    <rect x="14" y="3" width="7" height="5" rx="1.5" />
    <rect x="14" y="11" width="7" height="10" rx="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" />
  </svg>
);

export const StackIcon = ({ className }: Props) => (
  <svg className={className} viewBox="0 0 24 24" {...stroke}>
    <path d="m12 3 9 5-9 5-9-5z" strokeLinejoin="round" />
    <path d="m3 13 9 5 9-5" strokeLinejoin="round" />
  </svg>
);

export const PlusIcon = ({ className }: Props) => (
  <svg className={className} viewBox="0 0 24 24" {...stroke}>
    <path d="M12 5v14M5 12h14" strokeLinecap="round" />
  </svg>
);

export const TrashIcon = ({ className }: Props) => (
  <svg className={className} viewBox="0 0 24 24" {...stroke}>
    <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" strokeLinecap="round" />
    <path d="m6 7 1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" strokeLinejoin="round" />
  </svg>
);

export const SaveIcon = ({ className }: Props) => (
  <svg className={className} viewBox="0 0 24 24" {...stroke}>
    <path d="M5 3h11l3 3v15H5z" strokeLinejoin="round" />
    <path d="M8 3v6h8V3M8 21v-6h8v6" strokeLinejoin="round" />
  </svg>
);

export const UploadIcon = ({ className }: Props) => (
  <svg className={className} viewBox="0 0 24 24" {...stroke}>
    <path d="M12 17V5m0 0-4 4m4-4 4 4" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" strokeLinecap="round" />
  </svg>
);

export const FileIcon = ({ className }: Props) => (
  <svg className={className} viewBox="0 0 24 24" {...stroke}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" strokeLinejoin="round" />
    <path d="M14 3v5h5" strokeLinejoin="round" />
  </svg>
);

export const LogoutIcon = ({ className }: Props) => (
  <svg className={className} viewBox="0 0 24 24" {...stroke}>
    <path d="M15 12H4m0 0 4-4m-4 4 4 4" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M12 4h6a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6" strokeLinecap="round" />
  </svg>
);

export const LockIcon = ({ className }: Props) => (
  <svg className={className} viewBox="0 0 24 24" {...stroke}>
    <rect x="4" y="10" width="16" height="11" rx="2" />
    <path d="M8 10V7a4 4 0 0 1 8 0v3" strokeLinecap="round" />
  </svg>
);

export const ExternalIcon = ({ className }: Props) => (
  <svg className={className} viewBox="0 0 24 24" {...stroke}>
    <path d="M14 4h6v6" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M20 4 11 13" strokeLinecap="round" />
    <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" strokeLinecap="round" />
  </svg>
);

export const HistoryIcon = ({ className }: Props) => (
  <svg className={className} viewBox="0 0 24 24" {...stroke}>
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M3 4v4h4" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M12 8v4l3 2" strokeLinecap="round" />
  </svg>
);

export const TrendIcon = ({ className }: Props) => (
  <svg className={className} viewBox="0 0 24 24" {...stroke}>
    <path d="M4 17l5-6 4 3 6-8" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M15 6h5v5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const SearchIcon = ({ className }: Props) => (
  <svg className={className} viewBox="0 0 24 24" {...stroke}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" strokeLinecap="round" />
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

export const ArrowLeftIcon = ({ className }: Props) => (
  <svg className={className} viewBox="0 0 24 24" {...stroke}>
    <path d="M19 12H5m0 0 6-6m-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

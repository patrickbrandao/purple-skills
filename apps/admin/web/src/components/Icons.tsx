type Props = { className?: string };
const base = 'h-4 w-4';
const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 2 } as const;

export const SparkIcon = ({ className = base }: Props) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 2.5 14 9l6.5 2-6.5 2-2 6.5-2-6.5L3.5 11 10 9z" />
  </svg>
);

export const DashboardIcon = ({ className = base }: Props) => (
  <svg className={className} viewBox="0 0 24 24" {...stroke}>
    <rect x="3" y="3" width="7" height="8" rx="1.5" />
    <rect x="14" y="3" width="7" height="5" rx="1.5" />
    <rect x="14" y="11" width="7" height="10" rx="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" />
  </svg>
);

export const StackIcon = ({ className = base }: Props) => (
  <svg className={className} viewBox="0 0 24 24" {...stroke}>
    <path d="m12 3 9 5-9 5-9-5z" strokeLinejoin="round" />
    <path d="m3 13 9 5 9-5" strokeLinejoin="round" />
  </svg>
);

export const PlusIcon = ({ className = base }: Props) => (
  <svg className={className} viewBox="0 0 24 24" {...stroke}>
    <path d="M12 5v14M5 12h14" strokeLinecap="round" />
  </svg>
);

export const TrashIcon = ({ className = base }: Props) => (
  <svg className={className} viewBox="0 0 24 24" {...stroke}>
    <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" strokeLinecap="round" />
    <path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" strokeLinejoin="round" />
  </svg>
);

export const SaveIcon = ({ className = base }: Props) => (
  <svg className={className} viewBox="0 0 24 24" {...stroke}>
    <path d="M5 3h11l3 3v15H5z" strokeLinejoin="round" />
    <path d="M8 3v6h8V3M8 21v-6h8v6" strokeLinejoin="round" />
  </svg>
);

export const UploadIcon = ({ className = base }: Props) => (
  <svg className={className} viewBox="0 0 24 24" {...stroke}>
    <path d="M12 17V5m0 0-4 4m4-4 4 4" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" strokeLinecap="round" />
  </svg>
);

export const FileIcon = ({ className = base }: Props) => (
  <svg className={className} viewBox="0 0 24 24" {...stroke}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" strokeLinejoin="round" />
    <path d="M14 3v5h5" strokeLinejoin="round" />
  </svg>
);

export const LogoutIcon = ({ className = base }: Props) => (
  <svg className={className} viewBox="0 0 24 24" {...stroke}>
    <path d="M15 12H4m0 0 4-4m-4 4 4 4" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M12 4h6a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6" strokeLinecap="round" />
  </svg>
);

export const EyeIcon = ({ className = base }: Props) => (
  <svg className={className} viewBox="0 0 24 24" {...stroke}>
    <path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6Z" />
    <circle cx="12" cy="12" r="2.5" />
  </svg>
);

export const LockIcon = ({ className = base }: Props) => (
  <svg className={className} viewBox="0 0 24 24" {...stroke}>
    <rect x="4" y="10" width="16" height="11" rx="2" />
    <path d="M8 10V7a4 4 0 0 1 8 0v3" strokeLinecap="round" />
  </svg>
);

export const ExternalIcon = ({ className = base }: Props) => (
  <svg className={className} viewBox="0 0 24 24" {...stroke}>
    <path d="M14 4h6v6" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M20 4 11 13" strokeLinecap="round" />
    <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" strokeLinecap="round" />
  </svg>
);

export const HistoryIcon = ({ className = base }: Props) => (
  <svg className={className} viewBox="0 0 24 24" {...stroke}>
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M3 4v4h4" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M12 8v4l3 2" strokeLinecap="round" />
  </svg>
);

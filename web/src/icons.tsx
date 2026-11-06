// Small stroke icon set (Lucide-style, 24x24 grid) so every button looks the same.
import type { ReactNode } from 'react'

function Svg({ children, size = 16, fill }: { children: ReactNode; size?: number; fill?: boolean }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

type P = { size?: number }

export const PlayIcon = ({ size }: P) => (
  <Svg size={size} fill>
    <path d="M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5z" />
  </Svg>
)

export const StopIcon = ({ size }: P) => (
  <Svg size={size} fill>
    <rect x="5" y="5" width="14" height="14" rx="2" />
  </Svg>
)

export const RestartIcon = ({ size }: P) => (
  <Svg size={size}>
    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
    <path d="M21 3v6h-6" />
  </Svg>
)

export const ReloadIcon = ({ size }: P) => (
  <Svg size={size}>
    <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
    <path d="M14 3v6h6" />
    <path d="M15.5 14.5a3.5 3.5 0 1 1-1-2.45" />
    <path d="M15.5 10.5v2h-2" />
  </Svg>
)

export const ClearIcon = ({ size }: P) => (
  <Svg size={size}>
    <path d="M7 21l-4.3-4.3a2.4 2.4 0 0 1 0-3.4l9.6-9.6a2.4 2.4 0 0 1 3.4 0l5.6 5.6a2.4 2.4 0 0 1 0 3.4L13 21" />
    <path d="M22 21H7" />
    <path d="M5 11l9 9" />
  </Svg>
)

export const TrashIcon = ({ size }: P) => (
  <Svg size={size}>
    <path d="M3 6h18" />
    <path d="M8 6V4h8v2" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    <path d="M10 11v6M14 11v6" />
  </Svg>
)

export const PlusIcon = ({ size }: P) => (
  <Svg size={size}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
)

export const EditIcon = ({ size }: P) => (
  <Svg size={size}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
  </Svg>
)

export const CloseIcon = ({ size }: P) => (
  <Svg size={size}>
    <path d="M18 6L6 18M6 6l12 12" />
  </Svg>
)

export const CheckIcon = ({ size }: P) => (
  <Svg size={size}>
    <path d="M20 6L9 17l-5-5" />
  </Svg>
)

export const WarnIcon = ({ size }: P) => (
  <Svg size={size}>
    <path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
    <path d="M12 9v4M12 17h.01" />
  </Svg>
)

export const ExternalIcon = ({ size }: P) => (
  <Svg size={size}>
    <path d="M15 3h6v6" />
    <path d="M10 14L21 3" />
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
  </Svg>
)

export const SearchIcon = ({ size }: P) => (
  <Svg size={size}>
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-4.3-4.3" />
  </Svg>
)

export const ServicesIcon = ({ size }: P) => (
  <Svg size={size}>
    <rect x="3" y="3" width="18" height="7" rx="2" />
    <rect x="3" y="14" width="18" height="7" rx="2" />
    <path d="M7 6.5h.01M7 17.5h.01M11 6.5h6M11 17.5h6" />
  </Svg>
)

export const RuntimesIcon = ({ size }: P) => (
  <Svg size={size}>
    <path d="M12 2.5l9 4.5-9 4.5-9-4.5z" />
    <path d="M3 12l9 4.5 9-4.5" />
    <path d="M3 17l9 4.5 9-4.5" />
  </Svg>
)

export const TerminalIcon = ({ size }: P) => (
  <Svg size={size}>
    <path d="M4 17l6-6-6-6" />
    <path d="M12 19h8" />
  </Svg>
)

// Runtime type icons
export const JavaIcon = ({ size }: P) => (
  <Svg size={size}>
    <path d="M4 10h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z" />
    <path d="M17 11h1.5a2.5 2.5 0 0 1 0 5H17" />
    <path d="M8 2.5c-.7 1 .7 2 0 3M12 2.5c-.7 1 .7 2 0 3" />
  </Svg>
)

export const NodeIcon = ({ size }: P) => (
  <Svg size={size}>
    <path d="M12 2.5l8.5 4.9v9.2L12 21.5l-8.5-4.9V7.4z" />
    <path d="M14.5 9.5c-.4-.8-1.3-1.2-2.4-1.2-1.4 0-2.3.7-2.3 1.7 0 2.4 4.9 1.3 4.9 3.9 0 1.1-1 1.8-2.6 1.8-1.2 0-2.2-.5-2.6-1.4" />
  </Svg>
)

export const ScriptIcon = ({ size }: P) => (
  <Svg size={size}>
    <rect x="2.5" y="4" width="19" height="16" rx="2" />
    <path d="M7 9.5l3 2.5-3 2.5M12.5 15h4.5" />
  </Svg>
)

export function RuntimeTypeIcon({ type, size = 16 }: { type: string; size?: number }) {
  const I = type === 'java' ? JavaIcon : type === 'node' ? NodeIcon : ScriptIcon
  return (
    <span className={`rt-icon rt-icon-${type}`} title={type}>
      <I size={size} />
    </span>
  )
}

export const FolderIcon = ({ size }: P) => (
  <Svg size={size}>
    <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.6l2 2.2h8.4A1.5 1.5 0 0 1 21 8.7v9.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z" />
  </Svg>
)

export const SpringIcon = ({ size }: P) => (
  <Svg size={size}>
    <path d="M20 4c-9 0-15 4.5-15 11a5 5 0 0 0 .6 2.4" />
    <path d="M20 4c.5 8-3 15-11 15a5.5 5.5 0 0 1-3.4-1.6C9 13 12.5 10.5 16 9" />
  </Svg>
)

export const JarIcon = ({ size }: P) => (
  <Svg size={size}>
    <path d="M7 3.5h10M8 3.5v2M16 3.5v2" />
    <path d="M6 5.5h12v2.5a2 2 0 0 1 0 0v10.5a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8z" />
    <path d="M9 12h6M9 15.5h6" />
  </Svg>
)

export const CodeIcon = ({ size }: P) => (
  <Svg size={size}>
    <path d="M8 7l-5 5 5 5M16 7l5 5-5 5M13.5 4.5l-3 15" />
  </Svg>
)

export const UpIcon = ({ size }: P) => (
  <Svg size={size}>
    <path d="M12 19V5M5 12l7-7 7 7" />
  </Svg>
)

export const HammerIcon = ({ size }: P) => (
  <Svg size={size}>
    <path d="M14.5 6.5l3 3M4 20l9-9M12 5.5l2.5-2.5 6.5 6.5-2.5 2.5z" />
  </Svg>
)

/** The Grid logo: a light-line grid in perspective. */
export const GridIcon = ({ size }: P) => (
  <Svg size={size}>
    <path d="M3 20h18M5 15h14M7.5 10.5h9M9.5 7h5" />
    <path d="M12 7v13M9.5 7L6 20M14.5 7L18 20M7.5 10.5L3 20M16.5 10.5L21 20" />
  </Svg>
)

export const ChevronIcon = ({ size }: P) => (
  <Svg size={size}>
    <path d="M9 6l6 6-6 6" />
  </Svg>
)

export const ChevronDownIcon = ({ size }: P) => (
  <Svg size={size}>
    <path d="M6 9l6 6 6-6" />
  </Svg>
)

export const ChevronUpIcon = ({ size }: P) => (
  <Svg size={size}>
    <path d="M18 15l-6-6-6 6" />
  </Svg>
)

export const SettingsIcon = ({ size }: P) => (
  <Svg size={size}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </Svg>
)

export const ChangesIcon = ({ size }: P) => (
  <Svg size={size}>
    <circle cx="6" cy="5.5" r="2.2" />
    <circle cx="6" cy="18.5" r="2.2" />
    <circle cx="18" cy="9" r="2.2" />
    <path d="M6 7.7v8.6M18 11.2c0 3.6-3 4.3-8.5 5" />
  </Svg>
)

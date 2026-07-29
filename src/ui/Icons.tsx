import { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function base(props: IconProps): IconProps {
  return {
    width: 15,
    height: 15,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.4,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    ...props,
  };
}

export function PlusIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M8 3.5v9M3.5 8h9" />
    </svg>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
    </svg>
  );
}

export function SplitIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M8 3v10" />
    </svg>
  );
}

export function MaximizeIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M6 2.5H2.5V6M10 2.5h3.5V6M6 13.5H2.5V10M10 13.5h3.5V10" />
    </svg>
  );
}

export function TerminalGlyphIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
      <path d="M4.5 6l2.5 2-2.5 2M8.5 10.5h3" />
    </svg>
  );
}

export function FolderIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M1.75 4.5c0-.55.45-1 1-1h3.2l1.3 1.5h6c.55 0 1 .45 1 1v6c0 .55-.45 1-1 1h-10.5c-.55 0-1-.45-1-1v-7.5Z" />
    </svg>
  );
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="m6 3.5 4.5 4.5L6 12.5" />
    </svg>
  );
}

export function MoreIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="3.5" cy="8" r="0.75" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="0.75" fill="currentColor" stroke="none" />
      <circle cx="12.5" cy="8" r="0.75" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function SidebarIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
      <path d="M6 2.5v11" />
    </svg>
  );
}

export function PencilIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M11.5 2.7l1.8 1.8-7 7L4 12.5l1-2.3z" />
      <path d="M10.3 3.9l1.8 1.8" />
    </svg>
  );
}

export function CopyIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="5.5" y="5.5" width="7" height="7" rx="1.5" />
      <path d="M10.5 5.5v-1a1.5 1.5 0 0 0-1.5-1.5H5A1.5 1.5 0 0 0 3.5 4.5V9A1.5 1.5 0 0 0 5 10.5h.5" />
    </svg>
  );
}

export function UndoIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M3.5 6.5h6a3 3 0 0 1 0 6H6" />
      <path d="M6 4L3.5 6.5L6 9" />
    </svg>
  );
}

export function DiffIcon(props: IconProps) {
  // «±» как у счётчика изменений в Warp: плюс сверху, минус снизу.
  return (
    <svg {...base(props)}>
      <path d="M8 2.8v5M5.5 5.3h5M5.5 11.8h5" />
    </svg>
  );
}

export function BellIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M8 2.5a3.8 3.8 0 0 0-3.8 3.8c0 3-1.2 4.2-1.2 4.2h10s-1.2-1.2-1.2-4.2A3.8 3.8 0 0 0 8 2.5zM6.7 13a1.4 1.4 0 0 0 2.6 0" />
    </svg>
  );
}

export function SlidersIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M3.5 2.5v11M8 2.5v11M12.5 2.5v11" />
      <circle cx="3.5" cy="10" r="1.6" fill="var(--mc-bg, #101216)" />
      <circle cx="8" cy="5.5" r="1.6" fill="var(--mc-bg, #101216)" />
      <circle cx="12.5" cy="9" r="1.6" fill="var(--mc-bg, #101216)" />
    </svg>
  );
}

export function GearIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M12.4 3.6L11 5M5 11l-1.4 1.4" />
    </svg>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.4 10.4 3.1 3.1" />
    </svg>
  );
}

export function PaletteIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M8 2a6 6 0 0 0 0 12c1 0 1.6-.6 1.6-1.4 0-.9-.8-1.2-.8-2 0-.6.5-1 1.1-1h1.2A3.4 3.4 0 0 0 14 6.2C13.5 3.8 11 2 8 2Z" />
      <circle cx="5.4" cy="6.4" r="0.85" fill="currentColor" stroke="none" />
      <circle cx="8" cy="4.9" r="0.85" fill="currentColor" stroke="none" />
      <circle cx="5" cy="9.6" r="0.85" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function AgentIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M8 1.6v1.8" />
      <rect x="2.8" y="3.4" width="10.4" height="8" rx="2.4" />
      <path d="M6 13.4h4" />
      <circle cx="6" cy="7.4" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="10" cy="7.4" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function UserIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="8" cy="5.6" r="2.6" />
      <path d="M3 13.4a5 5 0 0 1 10 0" />
    </svg>
  );
}

export function PlayIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M6 4.3 11 8l-5 3.7z" fill="currentColor" />
    </svg>
  );
}

export function NodesIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="4" cy="4.2" r="1.9" />
      <circle cx="12" cy="4.2" r="1.9" />
      <circle cx="8" cy="12" r="1.9" />
      <path d="M5.9 4.2h4.2M5.4 5.7l1.9 4.7M10.6 5.7 8.7 10.4" />
    </svg>
  );
}

export function PuzzleIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="2.2" y="2.2" width="5" height="5" rx="1.2" />
      <rect x="8.8" y="2.2" width="5" height="5" rx="1.2" />
      <rect x="2.2" y="8.8" width="5" height="5" rx="1.2" />
      <rect
        x="8.8"
        y="8.8"
        width="5"
        height="5"
        rx="1.2"
        strokeDasharray="2.2 2"
      />
    </svg>
  );
}

export function KeyboardIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="1.5" y="3.5" width="13" height="9" rx="1.8" />
      <path d="M4 6.2h.01M6.5 6.2h.01M9 6.2h.01M11.5 6.2h.01M4 8.6h.01M6.5 8.6h.01M9 8.6h.01M11.5 8.6h.01M5.2 10.8h5.6" />
    </svg>
  );
}

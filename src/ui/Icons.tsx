import { ComponentType, SVGProps } from "react";

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

// ---------------------------------------------------------------------------
// Марки агентов. Это не наши значки, а знаки компаний: они залиты, а не
// обведены, и нарисованы в своей сетке 24×24 — перерисовывать их «под наш
// стиль» нельзя, узнаваемость знака и есть его смысл.

function brand(props: IconProps): IconProps {
  return {
    width: 15,
    height: 15,
    viewBox: "0 0 24 24",
    fill: "currentColor",
    stroke: "none",
    ...props,
  };
}

export function ClaudeMarkIcon(props: IconProps) {
  return (
    <svg {...brand(props)}>
      <path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246-1.4146-2.1675-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" />
    </svg>
  );
}

// Знака OpenAI нет в открытых наборах марок, так что он собран по геометрии:
// шесть дуг одного радиуса, центры — по вершинам шестиугольника. Узел выходит
// того же строя, что оригинал, но это всё-таки пересказ, а не сам знак.
export function CodexMarkIcon(props: IconProps) {
  return (
    <svg
      {...brand({
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 2.8,
        strokeLinecap: "round",
        ...props,
      })}
    >
      <path d="M19.05 17.11A5.9 5.9 0 1 1 19.05 6.89" />
      <path d="M11.10 20.66A5.9 5.9 0 1 1 19.95 15.55" />
      <path d="M4.05 15.55A5.9 5.9 0 1 1 12.90 20.66" />
      <path d="M4.95 6.89A5.9 5.9 0 1 1 4.95 17.11" />
      <path d="M12.90 3.34A5.9 5.9 0 1 1 4.05 8.45" />
      <path d="M19.95 8.45A5.9 5.9 0 1 1 11.10 3.34" />
    </svg>
  );
}

export function CopilotMarkIcon(props: IconProps) {
  return (
    <svg {...brand(props)}>
      <path d="M23.922 16.997C23.061 18.492 18.063 22.02 12 22.02 5.937 22.02.939 18.492.078 16.997A.641.641 0 0 1 0 16.741v-2.869a.883.883 0 0 1 .053-.22c.372-.935 1.347-2.292 2.605-2.656.167-.429.414-1.055.644-1.517a10.098 10.098 0 0 1-.052-1.086c0-1.331.282-2.499 1.132-3.368.397-.406.89-.717 1.474-.952C7.255 2.937 9.248 1.98 11.978 1.98c2.731 0 4.767.957 6.166 2.093.584.235 1.077.546 1.474.952.85.869 1.132 2.037 1.132 3.368 0 .368-.014.733-.052 1.086.23.462.477 1.088.644 1.517 1.258.364 2.233 1.721 2.605 2.656a.841.841 0 0 1 .053.22v2.869a.641.641 0 0 1-.078.256Zm-11.75-5.992h-.344a4.359 4.359 0 0 1-.355.508c-.77.947-1.918 1.492-3.508 1.492-1.725 0-2.989-.359-3.782-1.259a2.137 2.137 0 0 1-.085-.104L4 11.746v6.585c1.435.779 4.514 2.179 8 2.179 3.486 0 6.565-1.4 8-2.179v-6.585l-.098-.104s-.033.045-.085.104c-.793.9-2.057 1.259-3.782 1.259-1.59 0-2.738-.545-3.508-1.492a4.359 4.359 0 0 1-.355-.508Zm2.328 3.25c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm-5 0c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm3.313-6.185c.136 1.057.403 1.913.878 2.497.442.544 1.134.938 2.344.938 1.573 0 2.292-.337 2.657-.751.384-.435.558-1.15.558-2.361 0-1.14-.243-1.847-.705-2.319-.477-.488-1.319-.862-2.824-1.025-1.487-.161-2.192.138-2.533.529-.269.307-.437.808-.438 1.578v.021c0 .265.021.562.063.893Zm-1.626 0c.042-.331.063-.628.063-.894v-.02c-.001-.77-.169-1.271-.438-1.578-.341-.391-1.046-.69-2.533-.529-1.505.163-2.347.537-2.824 1.025-.462.472-.705 1.179-.705 2.319 0 1.211.175 1.926.558 2.361.365.414 1.084.751 2.657.751 1.21 0 1.902-.394 2.344-.938.475-.584.742-1.44.878-2.497Z" />
    </svg>
  );
}

export function OpenCodeMarkIcon(props: IconProps) {
  return (
    <svg {...brand(props)}>
      <path d="M22 24H2V0h20zM17 4.8H7v14.4h10z" />
    </svg>
  );
}

// Марка по идентификатору агента из каталога. Отдельным списком, а не полем
// в AGENTS: каталог — это про запуск и resume, знаки компаний ему незачем.
// Незнакомый id (запись осталась от агента, поддержку которого убрали) марки
// не находит — вкладка обойдётся общим значком.
const AGENT_MARKS: Record<string, ComponentType<IconProps>> = {
  claude: ClaudeMarkIcon,
  codex: CodexMarkIcon,
  copilot: CopilotMarkIcon,
  opencode: OpenCodeMarkIcon,
};

export function getAgentMark(
  agentId: string | undefined,
): ComponentType<IconProps> | null {
  if (!agentId) {
    return null;
  }
  return AGENT_MARKS[agentId] ?? null;
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

export function NewFileIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M9 2H4.5v12H9" />
      <path d="M9 2l2.5 2.5V7" />
      {/* Плюс отдельно и в углу: лист без него — это «файл», а не «создать». */}
      <path d="M12 9.5v4M10 11.5h4" />
    </svg>
  );
}

export function NewFolderIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M2 12.5V4h4l1.2 1.5H10v2" />
      <path d="M2 12.5h6" />
      <path d="M12 9v4.5M9.75 11.25h4.5" />
    </svg>
  );
}

/// Свернуть всё: две стрелки навстречу друг другу.
export function CollapseIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M5 6.5L8 3.5l3 3" />
      <path d="M5 9.5l3 3 3-3" />
    </svg>
  );
}

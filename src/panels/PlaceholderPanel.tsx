import { useEffect, useRef, useState } from "react";
import { IDockviewPanelProps } from "dockview";

export function PlaceholderPanel(props: IDockviewPanelProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const element = rootRef.current;
    if (!element) {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0].contentRect;
      setSize({
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={rootRef} className="placeholder-panel">
      <span className="placeholder-title">{props.api.title}</span>
      <span className="placeholder-size">
        {size.width} × {size.height}
      </span>
      <span className="placeholder-hint">
        панель-заглушка — терминал появится на этапе 3
      </span>
    </div>
  );
}

import { useRef } from 'react';
import { usePreferences } from './i18n';

export const minimumPanelWidth = 170;
export const maximumPanelWidth = 560;

export function PanelSplitter({ side, width, onWidthChange }: {
  side: 'left' | 'right';
  width: number;
  onWidthChange(width: number): void;
}) {
  const { t } = usePreferences();
  const drag = useRef<{ pointer: number; x: number; width: number } | undefined>(undefined);
  const label = side === 'left' ? t('Ширина панели фильтров', 'Filters panel width') : t('Ширина панели сведений', 'Details panel width');
  const sign = side === 'left' ? 1 : -1;

  function update(next: number) {
    onWidthChange(Math.round(Math.max(minimumPanelWidth, Math.min(maximumPanelWidth, next))));
  }

  return <div className="panel-splitter" role="separator" tabIndex={0} title={label} aria-label={label}
    aria-orientation="vertical" aria-valuemin={minimumPanelWidth} aria-valuemax={maximumPanelWidth} aria-valuenow={width}
    onPointerDown={(event) => {
      if (event.button !== 0) return;
      const panel = side === 'left' ? event.currentTarget.previousElementSibling : event.currentTarget.nextElementSibling;
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { pointer: event.pointerId, x: event.clientX, width: panel?.getBoundingClientRect().width ?? width };
    }}
    onPointerMove={(event) => {
      if (drag.current?.pointer === event.pointerId) update(drag.current.width + sign * (event.clientX - drag.current.x));
    }}
    onLostPointerCapture={() => { drag.current = undefined; }}
    onKeyDown={(event) => {
      const delta = event.key === 'ArrowRight' ? sign : event.key === 'ArrowLeft' ? -sign : 0;
      if (!delta) return;
      event.preventDefault();
      update(width + delta * (event.shiftKey ? 50 : 10));
    }} />;
}

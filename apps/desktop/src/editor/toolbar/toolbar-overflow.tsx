import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { Ellipsis } from 'lucide-react';
import { toolbarFitCount, toolbarOverflowRange, type ToolbarItemMeasure } from './toolbar-fit';

export type OverflowMeasure = 'icon' | 'select' | { className: string; text: string };

export type OverflowSlot = {
  id: string;
  node: ReactNode;
  separator?: boolean;
  active?: boolean;
  measure?: OverflowMeasure;
};

function measureKey(slot: OverflowSlot): string {
  if (slot.separator) return 'sep';
  const measure = slot.measure ?? 'icon';
  if (measure === 'icon' || measure === 'select') return measure;
  return `${measure.className}\u0000${measure.text}`;
}

function MeasureGhost({ slot }: { slot: OverflowSlot }) {
  if (slot.separator) return <span className="editor-tool-sep" data-slot="sep" />;
  if (slot.measure === 'select') {
    return <span className="editor-tool-select" data-slot="" />;
  }
  if (slot.measure && typeof slot.measure === 'object') {
    return (
      <span className={slot.measure.className} data-slot="">
        {slot.measure.text}
      </span>
    );
  }
  return <span className="editor-tool" data-slot="" />;
}

function columnGap(el: HTMLElement): number {
  const raw = getComputedStyle(el).columnGap;
  const gap = Number.parseFloat(raw);
  return Number.isFinite(gap) ? gap : 0;
}

/** Walk past display:contents wrappers to the box that actually takes space. */
function boxOf(el: HTMLElement): HTMLElement {
  let current = el;
  while (getComputedStyle(current).display === 'contents') {
    const child = current.firstElementChild;
    if (!(child instanceof HTMLElement)) break;
    current = child;
  }
  return current;
}

function spaceOf(el: HTMLElement): number {
  const style = getComputedStyle(el);
  const margin =
    (Number.parseFloat(style.marginLeft) || 0) + (Number.parseFloat(style.marginRight) || 0);
  return el.getBoundingClientRect().width + margin;
}

function useToolbarFit(signature: string, slots: readonly OverflowSlot[]) {
  const barRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const widthCache = useRef(new Map<string, number>());
  const moreCache = useRef(0);
  const slotsRef = useRef(slots);
  slotsRef.current = slots;
  const [fit, setFit] = useState<number | null>(null);

  useLayoutEffect(() => {
    const bar = barRef.current;
    const measure = measureRef.current;
    if (!bar || !measure) return;

    const update = () => {
      const current = slotsRef.current;
      const ghosts = [...measure.querySelectorAll<HTMLElement>('[data-slot]')];
      const items: ToolbarItemMeasure[] = current.map((slot, index) => {
        const ghost = ghosts[index];
        const live = bar.querySelector<HTMLElement>(`[data-live="${slot.id}"]`);
        const liveWidth = live ? spaceOf(boxOf(live)) : 0;
        const ghostWidth = ghost ? spaceOf(boxOf(ghost)) : 0;
        const width = Math.max(liveWidth, ghostWidth, widthCache.current.get(slot.id) ?? 0);
        if (width > 0) widthCache.current.set(slot.id, width);
        return { width, separator: slot.separator };
      });
      const moreGhost = measure.querySelector<HTMLElement>('[data-more]');
      const moreLive = bar.querySelector<HTMLElement>('[data-more-live]');
      const moreWidth = Math.max(
        moreLive ? spaceOf(moreLive) : 0,
        moreGhost ? spaceOf(boxOf(moreGhost)) : 0,
        moreCache.current,
      );
      if (moreWidth > 0) moreCache.current = moreWidth;
      const next = toolbarFitCount(items, bar.clientWidth, moreWidth || 48, columnGap(bar));
      setFit((current) => (current === next ? current : next));
    };

    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(bar);
    observer.observe(measure);
    return () => observer.disconnect();
  }, [signature]);

  return { barRef, measureRef, fit };
}

function MoreButton({
  open,
  active,
  menuId,
  buttonRef,
  onToggle,
}: {
  open: boolean;
  active: boolean;
  menuId: string;
  buttonRef: RefObject<HTMLButtonElement | null>;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      ref={buttonRef}
      type="button"
      className={`editor-tool editor-toolbar-more-button${open || active ? ' is-active' : ''}`}
      aria-label={t('editor.more')}
      aria-haspopup="true"
      aria-expanded={open}
      aria-controls={menuId}
      data-more-live=""
      onMouseDown={(event) => {
        event.preventDefault();
        onToggle();
      }}
    >
      <Ellipsis aria-hidden="true" size={16} strokeWidth={1.75} />
    </button>
  );
}

export function OverflowToolbar({
  label,
  className,
  slots,
  onClose,
}: {
  label: string;
  className?: string;
  slots: readonly OverflowSlot[];
  onClose?: () => void;
}) {
  const { t } = useTranslation();
  const menuId = useId();
  const signature = slots.map((slot) => `${slot.id}:${measureKey(slot)}`).join('|');
  const { barRef, measureRef, fit } = useToolbarFit(signature, slots);
  const fitCount = fit == null ? slots.length : Math.min(fit, slots.length);
  const { start, end } = toolbarOverflowRange(slots, fitCount);
  const overflow = slots.slice(start, end);
  const showMore = overflow.length > 0;
  const overflowActive = overflow.some((slot) => slot.active);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const close = () => {
    setOpen(false);
    onCloseRef.current?.();
  };

  useEffect(() => {
    if (showMore || !open) return;
    setOpen(false);
    onCloseRef.current?.();
  }, [open, showMore]);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const place = () => {
      const anchor = buttonRef.current;
      const menu = menuRef.current;
      if (!anchor || !menu) return;
      const rect = anchor.getBoundingClientRect();
      const width = menu.offsetWidth;
      const height = menu.offsetHeight;
      let left = rect.right - width;
      const maxLeft = window.innerWidth - width - 8;
      if (left > maxLeft) left = Math.max(8, maxLeft);
      if (left < 8) left = 8;
      let top = rect.bottom + 6;
      if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
      setPos((current) =>
        current && current.top === top && current.left === left ? current : { top, left },
      );
    };
    place();
    const onScroll = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      place();
    };
    window.addEventListener('resize', place);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, signature, fitCount]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      if (
        target instanceof Element &&
        target.closest('.select-menu, .editor-color-pop, .editor-toolbar-more, .editor-prompt')
      ) {
        return;
      }
      close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (document.querySelector('.select-menu, .editor-color-pop, .editor-prompt')) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    document.addEventListener('mousedown', onPointer);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const barClass = className ? `editor-toolbar-inner ${className}` : 'editor-toolbar-inner';

  return (
    <div ref={barRef} className={barClass} role="toolbar" aria-label={label}>
      <div ref={measureRef} className="editor-toolbar-measure" aria-hidden="true" inert>
        {slots.map((slot) => (
          <MeasureGhost key={slot.id} slot={slot} />
        ))}
        <button type="button" className="editor-tool editor-toolbar-more-button" tabIndex={-1} data-more="">
          <Ellipsis aria-hidden="true" size={16} strokeWidth={1.75} />
        </button>
      </div>
      {slots.slice(0, fitCount).map((slot) => (
        <span key={slot.id} data-live={slot.id} className="editor-tool-live">
          {slot.node}
        </span>
      ))}
      {showMore ? (
        <MoreButton
          open={open}
          active={overflowActive}
          menuId={menuId}
          buttonRef={buttonRef}
          onToggle={() => {
            if (open) close();
            else setOpen(true);
          }}
        />
      ) : null}
      {open && showMore
        ? createPortal(
            <div
              ref={menuRef}
              id={menuId}
              className="editor-toolbar-more"
              role="group"
              aria-label={t('editor.moreOf', { label })}
              style={{
                top: pos?.top ?? 0,
                left: pos?.left ?? 0,
                visibility: pos ? 'visible' : 'hidden',
              }}
              onMouseDown={(event) => {
                if (event.target instanceof HTMLInputElement) return;
                event.preventDefault();
              }}
            >
              {overflow.map((slot) => (
                <span key={slot.id} className="editor-tool-live">
                  {slot.node}
                </span>
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

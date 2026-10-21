/**
 * 输入法组字期间的 Enter 只负责上屏，不能当成发送、提交或跳转。
 *
 * 浏览器顺序不一致：
 * - 规范：确认用的 keydown 带着 isComposing，随后才 compositionend。
 * - Safari 等会先把 compositionend 交给脚本，确认用的 keydown 上 isComposing 已是 false。
 * - 也有 keydown（keyCode 13、isComposing false）先到、compositionend 后到的情况。
 *
 * 所以同时看 isComposing、keyCode 229、自己记下的组字状态，
 * 以及 compositionend 前后极短时间内的那一次 Enter。
 * 看起来像普通 Enter 时，把动作推迟到当前事件循环结束，若这期间组字结束了就取消。
 */

export const IME_CONFIRM_WINDOW_MS = 50;

export type ImeEnterState = {
  composing: boolean;
  /** compositionend / compositioncancel 的 event.timeStamp。 */
  compositionEndedAt: number | null;
};

export type ImeEnterSnapshot = {
  key: string;
  keyCode: number;
  isComposing: boolean;
  timeStamp: number;
};

export function createImeEnterState(): ImeEnterState {
  return { composing: false, compositionEndedAt: null };
}

/** 这一下 Enter 属于输入法，调用方不要执行发送或提交。 */
export function imeBlocksEnter(event: ImeEnterSnapshot, state: ImeEnterState): boolean {
  if (event.key !== 'Enter') return false;
  if (event.isComposing || event.keyCode === 229) return true;
  if (state.composing) return true;
  const ended = state.compositionEndedAt;
  if (ended == null) return false;
  return Math.abs(event.timeStamp - ended) < IME_CONFIRM_WINDOW_MS;
}

export type ImeEnterSession = {
  state: ImeEnterState;
  schedule: (run: () => void) => void;
  start: () => void;
  end: (timeStamp: number) => void;
  blocks: (event: ImeEnterSnapshot) => boolean;
  /** 组字确认则不调用 action。普通 Enter 推迟到本轮事件结束再执行。 */
  runAfter: (event: ImeEnterSnapshot, action: () => void) => void;
};

export function createImeEnterSession(): ImeEnterSession {
  const state = createImeEnterState();
  const session: ImeEnterSession = {
    state,
    schedule: (run) => {
      setTimeout(run, 0);
    },
    start() {
      state.composing = true;
    },
    end(timeStamp: number) {
      state.composing = false;
      state.compositionEndedAt = timeStamp;
    },
    blocks(event) {
      return imeBlocksEnter(event, state);
    },
    runAfter(event, action) {
      if (event.key !== 'Enter' || session.blocks(event)) return;
      const stamp = event.timeStamp;
      session.schedule(() => {
        if (state.composing) return;
        const ended = state.compositionEndedAt;
        if (ended != null && Math.abs(stamp - ended) < IME_CONFIRM_WINDOW_MS) return;
        action();
      });
    },
  };
  return session;
}

const session = createImeEnterSession();

export function imeEnterSnapshot(event: {
  key: string;
  keyCode: number;
  isComposing: boolean;
  timeStamp: number;
}): ImeEnterSnapshot {
  return {
    key: event.key,
    keyCode: event.keyCode,
    isComposing: event.isComposing,
    timeStamp: event.timeStamp,
  };
}

export function imeBlocksEnterFromEvent(event: {
  key: string;
  keyCode: number;
  isComposing: boolean;
  timeStamp: number;
}): boolean {
  return session.blocks(imeEnterSnapshot(event));
}

export function runAfterImeEnter(
  event: { key: string; keyCode: number; isComposing: boolean; timeStamp: number },
  action: () => void,
): void {
  session.runAfter(imeEnterSnapshot(event), action);
}

const TEXT_INPUT_TYPES = new Set(['', 'text', 'search', 'email', 'password', 'url', 'tel', 'number']);

function isTextEntry(target: EventTarget | null): boolean {
  if (typeof HTMLTextAreaElement !== 'undefined' && target instanceof HTMLTextAreaElement) return true;
  if (typeof HTMLInputElement === 'undefined' || !(target instanceof HTMLInputElement)) return false;
  return TEXT_INPUT_TYPES.has(target.type);
}

function isContentEditable(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.isContentEditable;
}

const INSTALL_FLAG = '__strideImeEnterGuard';

/** 在 window 捕获阶段拦住组字确认键，盖住各页面自己的 Enter 处理。 */
export function installImeEnterGuard(): void {
  if (typeof window === 'undefined') return;
  const host = window as Window & { [INSTALL_FLAG]?: boolean };
  if (host[INSTALL_FLAG]) return;
  host[INSTALL_FLAG] = true;

  window.addEventListener('compositionstart', () => session.start(), true);
  const end = (event: Event) => session.end(event.timeStamp);
  window.addEventListener('compositionend', end, true);
  window.addEventListener('compositioncancel', end, true);

  window.addEventListener(
    'keydown',
    (event) => {
      const snap = imeEnterSnapshot(event);
      if (!session.blocks(snap)) return;
      event.stopImmediatePropagation();
      const owns = event.isComposing || event.keyCode === 229 || event.key === 'Process';
      const modified = event.shiftKey || event.metaKey || event.ctrlKey || event.altKey;
      if (owns || modified) return;
      // 输入框：阻止这次回车换行或隐式提交。组字尚未结束时也不放行，避免确认键把消息发出去。
      // 正文编辑器在组字还开着时不 preventDefault，免得候选上不了屏。
      if (isTextEntry(event.target) || (isContentEditable(event.target) && !session.state.composing)) {
        event.preventDefault();
      }
    },
    true,
  );

  window.addEventListener(
    'submit',
    (event) => {
      if (!session.state.composing) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true,
  );
}

/**
 * Web-app (PWA) plumbing: the service worker that makes the app work offline,
 * update notifications, and the browser's "install app" prompt.
 * Does nothing in the desktop app or during development.
 */
import { isTauri } from './lib/platform';

type Listener = () => void;

const listeners = new Set<Listener>();
const notify = () => listeners.forEach((l) => l());

export interface PwaState {
  /** A new version is downloaded and waiting. */
  updateReady: boolean;
  /** The browser offered to install the app. */
  canInstall: boolean;
  /** Running as an installed app (own window). */
  installed: boolean;
}

let state: PwaState = {
  updateReady: false,
  canInstall: false,
  installed: typeof window !== 'undefined' && window.matchMedia?.('(display-mode: standalone)').matches,
};
let applyUpdate: ((reload?: boolean) => Promise<void>) | null = null;

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}
let installEvent: InstallPromptEvent | null = null;

function set(patch: Partial<PwaState>) {
  state = { ...state, ...patch };
  notify();
}

export function getPwaState(): PwaState {
  return state;
}

export function subscribePwa(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function reloadForUpdate(): Promise<void> {
  await applyUpdate?.(true);
}

export async function promptInstall(): Promise<void> {
  if (!installEvent) return;
  await installEvent.prompt();
  const { outcome } = await installEvent.userChoice;
  installEvent = null;
  set({ canInstall: false, installed: outcome === 'accepted' || state.installed });
}

export function startPwa(): void {
  if (isTauri || typeof window === 'undefined') return;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installEvent = e as InstallPromptEvent;
    set({ canInstall: true });
  });
  window.addEventListener('appinstalled', () => {
    installEvent = null;
    set({ canInstall: false, installed: true });
  });

  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  void import('virtual:pwa-register').then(({ registerSW }) => {
    applyUpdate = registerSW({
      immediate: true,
      onNeedRefresh: () => set({ updateReady: true }),
      onRegisteredSW(_url, registration) {
        // Look for a new version every hour while the app is open.
        if (registration) setInterval(() => void registration.update(), 60 * 60 * 1000);
      },
    });
  });
}

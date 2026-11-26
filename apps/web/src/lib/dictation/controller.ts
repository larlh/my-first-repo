import { baseLanguage } from '@parlante/shared';
import type { DictationCapabilities, LanguageCode, ProviderRef } from '@parlante/shared';
import { browserEngineSupported, recognitionLocale, startBrowserEngine } from './browser-engine';
import type { SpeechRecognitionCtor } from './browser-engine';
import { chooseEngine, noEngineAtAll } from './engine-choice';
import { elementExclusion, insertDictated } from './insert';
import type { DictationElement } from './insert';
import { startLocalEngine } from './local-engine';
import type { TranscribeSegment } from './local-engine';
import { openMicrophone as defaultOpenMicrophone } from './microphone';
import type { OpenMicrophone } from './microphone';
import {
  DEFAULT_DICTATION_PREFERENCES,
  loadDictationPreferences,
  saveDictationPreferences,
} from './preferences';
import type { DictationPreferences } from './preferences';
import { toDictationError } from './types';
import type { DictationEngineId, DictationError, EngineCallbacks, EngineSession } from './types';

/* -------------------------------------------------------------------------------------------
 * One dictation at a time for the whole application.
 *
 * Every text field of the kit renders a microphone button bound to this controller. The
 * controller owns the microphone session, decides which engine runs it, writes the recognised
 * phrases into the field and publishes, per field, what the button and its status panel show.
 * It is a plain object (no React) so its rules can be tested on their own; `runtime.tsx`
 * connects it to the session, the API and the preferences.
 * ----------------------------------------------------------------------------------------- */

/** What the application provides once somebody is signed in. */
export interface DictationRuntimeDeps {
  /** Owner of the preferences. */
  userId: string;
  /** Language of the interface right now (default language of the speech). */
  uiLanguage: () => string;
  /** `capabilities.dictation`; `fresh` skips any cache. */
  loadCapabilities: (fresh: boolean) => Promise<DictationCapabilities>;
  /** `POST /api/dictation/transcribe`. */
  transcribe: TranscribeSegment;
  /** Test seams; default to the real browser APIs. */
  openMicrophone?: OpenMicrophone;
  Recognition?: SpeechRecognitionCtor;
}

export type DictationPhase = 'idle' | 'requesting' | 'listening' | 'transcribing';

/** What one field shows. */
export interface DictationFieldState {
  phase: DictationPhase;
  /** Engine of the current (or last) dictation in this field. */
  engine: DictationEngineId | null;
  /** Who transcribes (local engine); the browser engine has no `ProviderRef`. */
  provider: ProviderRef | null;
  /** Input level 0..1 while listening; null when the engine cannot measure it. */
  level: number | null;
  /** Provisional text of the phrase being spoken (browser engine). */
  interim: string;
  /** Phrases recorded and not yet written. */
  pending: number;
  error: DictationError | null;
  /** The notice of the browser engine must be accepted before it can start. */
  consentPrompt: boolean;
}

export type AnnouncementKind = 'listening' | 'stopped' | 'error';

export interface DictationAnnouncement {
  /** Grows with every announcement, so the same text can be announced twice. */
  serial: number;
  kind: AnnouncementKind;
  engine: DictationEngineId | null;
  error: DictationError | null;
}

export interface DictationGlobalState {
  /** Somebody is signed in and the runtime is connected: fields may offer dictation. */
  ready: boolean;
  preferences: DictationPreferences;
  /** Null until read (or when reading failed). */
  capabilities: DictationCapabilities | null;
  /** This browser has the Web Speech API. */
  browserSupported: boolean;
  /** Field that holds the microphone (or is about to). */
  activeFieldId: string | null;
  announcement: DictationAnnouncement | null;
}

export interface DictationTarget {
  /** Stable id of the control (one per field instance). */
  id: string;
  element: DictationElement;
  /** Language spoken into this field (`es`, `en-GB`…); default: the user's preference. */
  language?: string | undefined;
}

const IDLE_FIELD: DictationFieldState = Object.freeze({
  phase: 'idle',
  engine: null,
  provider: null,
  level: null,
  interim: '',
  pending: 0,
  error: null,
  consentPrompt: false,
});

interface Session {
  fieldId: string;
  element: DictationElement;
  engineId: DictationEngineId | null;
  engine: EngineSession | null;
  /** Stopped or replaced before the engine existed: abort it as soon as it does. */
  cancelled: boolean;
  /** Nothing else from this session may touch the field. */
  dead: boolean;
}

export class DictationController {
  private runtime: DictationRuntimeDeps | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly fields = new Map<string, DictationFieldState>();
  private global: DictationGlobalState = {
    ready: false,
    preferences: { ...DEFAULT_DICTATION_PREFERENCES },
    capabilities: null,
    browserSupported: false,
    activeFieldId: null,
    announcement: null,
  };
  /** Session that holds the microphone or is starting. */
  private live: Session | null = null;
  /** Sessions whose microphone is closed but still have phrases to write. */
  private readonly finishing = new Set<Session>();
  private serial = 0;
  private listening = false;

  /* ---------------------------------------------------------------- store */

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getGlobal = (): DictationGlobalState => this.global;

  getField = (id: string): DictationFieldState => this.fields.get(id) ?? IDLE_FIELD;

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }

  private setGlobal(patch: Partial<DictationGlobalState>): void {
    this.global = { ...this.global, ...patch };
    this.emit();
  }

  private patchField(id: string, patch: Partial<DictationFieldState>): void {
    const current = this.getField(id);
    let changed = false;
    for (const key of Object.keys(patch) as (keyof DictationFieldState)[]) {
      if (current[key] !== patch[key]) changed = true;
    }
    if (!changed) return;
    this.fields.set(id, { ...current, ...patch });
    this.emit();
  }

  private announce(
    kind: AnnouncementKind,
    engine: DictationEngineId | null,
    error: DictationError | null = null,
  ): void {
    this.serial += 1;
    this.setGlobal({ announcement: { serial: this.serial, kind, engine, error } });
  }

  /* -------------------------------------------------------------- runtime */

  /** Connect the application (called when a session exists). */
  connect(runtime: DictationRuntimeDeps): void {
    this.abortAll();
    this.runtime = runtime;
    this.fields.clear();
    this.setGlobal({
      ready: true,
      preferences: loadDictationPreferences(runtime.userId),
      capabilities: null,
      browserSupported: runtime.Recognition !== undefined || browserEngineSupported(),
      activeFieldId: null,
      announcement: null,
    });
  }

  /** Signed out (or unmounted): no field offers dictation any more. */
  disconnect(): void {
    this.abortAll();
    this.runtime = null;
    this.fields.clear();
    this.setGlobal({
      ready: false,
      preferences: { ...DEFAULT_DICTATION_PREFERENCES },
      capabilities: null,
      activeFieldId: null,
      announcement: null,
    });
  }

  /** The application read (or re-read) the capabilities. */
  setCapabilities(capabilities: DictationCapabilities | null): void {
    if (this.global.capabilities === capabilities) return;
    this.setGlobal({ capabilities });
  }

  /** Ask the server again (the model may have been installed meanwhile). */
  async refreshCapabilities(): Promise<DictationCapabilities | null> {
    const runtime = this.runtime;
    if (!runtime) return null;
    try {
      const capabilities = await runtime.loadCapabilities(true);
      if (this.runtime === runtime) this.setGlobal({ capabilities });
      return capabilities;
    } catch {
      return this.runtime === runtime ? this.global.capabilities : null;
    }
  }

  setPreferences(patch: Partial<DictationPreferences>): void {
    const runtime = this.runtime;
    if (!runtime) return;
    const preferences = { ...this.global.preferences, ...patch };
    saveDictationPreferences(runtime.userId, preferences);
    if (!preferences.showButtons) this.abortAll();
    this.setGlobal({ preferences });
  }

  /* ------------------------------------------------------------- sessions */

  /** Start dictating into a field, or stop if that field is the one dictating. */
  toggle(target: DictationTarget): void {
    if (this.live?.fieldId === target.id) this.stop();
    else void this.start(target);
  }

  async start(target: DictationTarget): Promise<void> {
    const runtime = this.runtime;
    if (!runtime || !this.global.preferences.showButtons) return;
    if (elementExclusion(target.element) !== null) return;

    // One field dictates at a time: starting here stops whoever had the microphone.
    if (this.live) this.stop();
    const session: Session = {
      fieldId: target.id,
      element: target.element,
      engineId: null,
      engine: null,
      cancelled: false,
      dead: false,
    };
    this.live = session;
    this.installListeners();
    this.fields.set(target.id, { ...IDLE_FIELD, phase: 'requesting' });
    this.setGlobal({ activeFieldId: target.id });

    // The capabilities are read live when the last answer said "not available": installing
    // the model does not need a restart, and the button must notice.
    let capabilities = this.global.capabilities;
    if (!capabilities || !capabilities.local.available) {
      capabilities = await this.refreshCapabilities();
    }
    if (session.cancelled || this.runtime !== runtime) return;

    const { preferences, browserSupported } = this.global;
    const local = capabilities?.local ?? null;
    const choice = chooseEngine({
      preference: preferences.engine,
      local,
      browserSupported,
      browserConsent: preferences.browserConsentAt !== null,
    });

    if (choice.engine === null) {
      if (choice.blocked === 'browser_needs_consent') {
        this.end(session, { consentPrompt: true });
        return;
      }
      const error: DictationError =
        choice.blocked === 'browser_unsupported'
          ? { code: 'browser_unsupported', engine: 'browser', offerLocal: choice.offerLocal }
          : noEngineAtAll({ local, browserSupported })
            ? { code: 'no_engine', reasonCode: choice.reasonCode }
            : {
                code: 'engine_unavailable',
                engine: 'local',
                reasonCode: choice.reasonCode,
                offerBrowser: choice.offerBrowser,
              };
      this.fail(session, error);
      return;
    }

    session.engineId = choice.engine;
    const spoken =
      target.language ??
      (preferences.language === 'ui' ? runtime.uiLanguage() : preferences.language);
    const callbacks = this.callbacksOf(session);

    try {
      if (choice.engine === 'local') {
        const base = baseLanguage(spoken);
        const hint: LanguageCode | undefined =
          base && capabilities?.local.languages.includes(base) ? base : undefined;
        this.patchField(session.fieldId, {
          engine: 'local',
          provider: capabilities?.local.provider ?? null,
        });
        const engine = await startLocalEngine(
          {
            openMicrophone: runtime.openMicrophone ?? defaultOpenMicrophone,
            transcribe: runtime.transcribe,
            language: hint,
            maxSegmentMs: capabilities?.maxSegmentMs ?? 30_000,
          },
          callbacks,
        );
        session.engine = engine;
      } else {
        this.patchField(session.fieldId, { engine: 'browser', provider: null });
        session.engine = startBrowserEngine(
          {
            Recognition: runtime.Recognition,
            locale: recognitionLocale(
              spoken,
              typeof navigator === 'undefined' ? [] : navigator.languages,
            ),
          },
          callbacks,
        );
      }
    } catch (error) {
      if (!session.dead && !session.cancelled) {
        this.fail(session, toDictationError(error, choice.engine));
      }
      return;
    }
    // Stopped while the browser was still asking for the microphone.
    if (session.cancelled) session.engine.abort();
  }

  /** Stop listening. What was already spoken is still transcribed and written. */
  stop(): void {
    const session = this.live;
    if (!session) return;
    this.live = null;
    this.removeListeners();
    if (!session.engine) {
      // Still asking for capabilities / permission.
      session.cancelled = true;
      session.dead = true;
      this.patchField(session.fieldId, { ...IDLE_FIELD });
      this.setGlobal({ activeFieldId: null });
      return;
    }
    this.finishing.add(session);
    this.patchField(session.fieldId, { phase: 'transcribing', level: null, interim: '' });
    this.setGlobal({ activeFieldId: null });
    session.engine.stop();
  }

  /** Forget a field (it unmounted): its sessions are dropped without writing anything else. */
  release(id: string): void {
    if (this.live?.fieldId === id) {
      const session = this.live;
      this.live = null;
      this.removeListeners();
      this.kill(session);
      this.global = { ...this.global, activeFieldId: null };
    }
    for (const session of [...this.finishing]) {
      if (session.fieldId === id) this.kill(session);
    }
    if (this.fields.delete(id)) this.emit();
  }

  /** Close the error / notice of a field. */
  dismiss(id: string): void {
    this.patchField(id, { error: null, consentPrompt: false });
  }

  /**
   * The person asked for the browser engine from a field (offered when the local one cannot
   * run). It only starts straight away when its notice was accepted before; otherwise the
   * notice is shown first and nothing changes until it is accepted.
   */
  requestBrowserEngine(target: DictationTarget): void {
    if (this.global.preferences.browserConsentAt === null) {
      this.patchField(target.id, { error: null, consentPrompt: true });
      return;
    }
    this.setPreferences({ engine: 'browser' });
    this.dismiss(target.id);
    void this.start(target);
  }

  /** The notice of the browser engine was accepted: remember it, select it and start. */
  acceptBrowserEngine(target: DictationTarget | null): void {
    this.setPreferences({ engine: 'browser', browserConsentAt: new Date().toISOString() });
    if (target) {
      this.dismiss(target.id);
      void this.start(target);
    }
  }

  /** Go back to the local engine (offered when the browser one does not exist here). */
  useLocalEngine(target: DictationTarget): void {
    this.setPreferences({ engine: 'auto' });
    this.dismiss(target.id);
    void this.start(target);
  }

  private kill(session: Session): void {
    session.cancelled = true;
    session.dead = true;
    this.finishing.delete(session);
    session.engine?.abort();
  }

  private abortAll(): void {
    if (this.live) {
      this.kill(this.live);
      this.live = null;
    }
    for (const session of [...this.finishing]) this.kill(session);
    this.removeListeners();
    let changed = false;
    for (const [id, state] of this.fields) {
      if (state.phase !== 'idle') {
        this.fields.set(id, { ...IDLE_FIELD, error: state.error });
        changed = true;
      }
    }
    if (this.global.activeFieldId !== null) {
      this.global = { ...this.global, activeFieldId: null };
      changed = true;
    }
    if (changed) this.emit();
  }

  /**
   * True unless a newer session is already dictating into the same field: then the field
   * shows that one, and the old session only finishes writing its phrases.
   */
  private shows(session: Session): boolean {
    return this.live === session || this.live?.fieldId !== session.fieldId;
  }

  /** The session is over without an engine error (blocked before starting, or finished). */
  private end(session: Session, patch: Partial<DictationFieldState> = {}): void {
    const shown = this.shows(session);
    session.dead = true;
    this.finishing.delete(session);
    if (this.live === session) {
      this.live = null;
      this.removeListeners();
      this.global = { ...this.global, activeFieldId: null };
    }
    if (!shown) return;
    this.fields.set(session.fieldId, {
      ...IDLE_FIELD,
      engine: session.engineId,
      provider: this.getField(session.fieldId).provider,
      ...patch,
    });
    this.emit();
  }

  private fail(session: Session, error: DictationError): void {
    if (session.dead) return;
    const shown = this.shows(session);
    session.engine?.abort();
    this.end(session, { error });
    if (shown) this.announce('error', session.engineId, error);
  }

  private callbacksOf(session: Session): EngineCallbacks {
    const alive = () => !session.dead;
    return {
      onListening: () => {
        if (!alive() || session.cancelled) return;
        this.patchField(session.fieldId, { phase: 'listening' });
        this.announce('listening', session.engineId);
      },
      onLevel: (level) => {
        if (alive() && this.live === session) this.patchField(session.fieldId, { level });
      },
      onInterim: (interim) => {
        if (alive() && this.live === session) this.patchField(session.fieldId, { interim });
      },
      onPending: (pending) => {
        if (alive() && this.shows(session)) this.patchField(session.fieldId, { pending });
      },
      onText: (text, provider) => {
        if (!alive()) return;
        const { element } = session;
        // The field went away or stopped accepting text while the phrase was on its way.
        if (!element.isConnected || elementExclusion(element) !== null) {
          const wasLive = this.live === session;
          this.kill(session);
          if (wasLive) {
            this.live = null;
            this.removeListeners();
          }
          this.fields.set(session.fieldId, { ...IDLE_FIELD });
          this.setGlobal({ activeFieldId: wasLive ? null : this.global.activeFieldId });
          return;
        }
        if (provider && this.shows(session)) this.patchField(session.fieldId, { provider });
        const result = insertDictated(element, text);
        if (result.truncated) {
          this.fail(session, {
            code: 'limit_reached',
            engine: session.engineId ?? undefined,
            maxLength: element.maxLength,
          });
        }
      },
      onError: (error) => {
        if (!alive()) return;
        this.fail(session, error);
      },
      onEnd: () => {
        if (!alive()) return;
        this.end(session);
        // Not when another field has taken over meanwhile: that one is "listening" now.
        if (!this.live) this.announce('stopped', session.engineId);
      },
    };
  }

  /* ------------------------------------------------- page-level safeguards */

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !this.live) return;
    // Escape stops the dictation and nothing else (it must not also close the dialog).
    event.preventDefault();
    event.stopPropagation();
    this.stop();
  };

  private readonly onVisibility = (): void => {
    if (document.visibilityState === 'hidden') this.stop();
  };

  private readonly onBlur = (): void => {
    // The permission prompt of the browser takes the focus too: only an open microphone
    // (a session that is already listening) is closed when the tab loses it.
    const live = this.live;
    if (live?.engine && this.getField(live.fieldId).phase === 'listening') this.stop();
  };

  private readonly onPageHide = (): void => {
    this.abortAll();
  };

  private installListeners(): void {
    if (this.listening || typeof window === 'undefined') return;
    this.listening = true;
    window.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('blur', this.onBlur);
    window.addEventListener('pagehide', this.onPageHide);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  private removeListeners(): void {
    if (!this.listening) return;
    this.listening = false;
    window.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('pagehide', this.onPageHide);
    document.removeEventListener('visibilitychange', this.onVisibility);
  }
}

/** The controller of the application. Tests create their own instances. */
export const dictation = new DictationController();

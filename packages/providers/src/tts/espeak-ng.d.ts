/**
 * Types for `@echogarden/espeak-ng-emscripten` (eSpeak NG compiled to WebAssembly; the package
 * ships no declarations). Only the surface the eSpeak provider uses.
 */
declare module '@echogarden/espeak-ng-emscripten' {
  export interface EspeakRawEvent {
    type:
      | 'list_terminated'
      | 'word'
      | 'sentence'
      | 'mark'
      | 'play'
      | 'end'
      | 'msg_terminated'
      | 'phoneme'
      | 'samplerate';
    /** 1-based code-point position in the text given to `synthesize`. */
    text_position: number;
    /** Length of the word in code points (word events). */
    word_length: number;
    /** Milliseconds from the start of the utterance. */
    audio_position: number;
    /** Phoneme events: IPA string. Word / sentence events: running number. */
    id: string | number | undefined;
  }

  export interface EspeakVoiceInfo {
    name: string;
    identifier: string;
    languages: { priority: number; name: string }[];
  }

  export interface EspeakWorker {
    get_samplerate(): number;
    list_voices(): EspeakVoiceInfo[];
    /** Voice name with an optional `+variant` suffix (`es`, `en-us+f2`). Returns 0 on success. */
    set_voice(name: string): number;
    /** Words per minute, 80..450 (175 = normal). */
    set_rate(wpm: number): void;
    /** 0..99 (50 = the voice's own pitch). */
    set_pitch(pitch: number): void;
    /** Intonation range 0..99 (50 = normal). */
    set_range(range: number): void;
    /**
     * Synchronous. The callback receives consecutive audio blocks (PCM16 mono) with the events
     * that fall inside them; return true to abort.
     */
    synthesize(
      text: string,
      callback: (audio: Int16Array, events: EspeakRawEvent[]) => boolean,
    ): void;
  }

  export interface EspeakModule {
    eSpeakNGWorker: new () => EspeakWorker;
  }

  const createEspeakModule: () => Promise<EspeakModule>;
  export default createEspeakModule;
}

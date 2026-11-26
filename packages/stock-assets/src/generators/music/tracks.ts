import {
  Bus,
  GLOCKEN,
  MARIMBA,
  Rng,
  SAMPLE_RATE,
  SOFT_BELL,
  bassVoice,
  biquad,
  boomVoice,
  clapVoice,
  delay,
  filterBus,
  keysVoice,
  kickVoice,
  malletVoice,
  master,
  midiToHz,
  noiseHit,
  padVoice,
  pluckVoice,
  pump,
  reverb,
  snareVoice,
  swell,
} from './synth';

/* -------------------------------------------------------------------------------------------
 * The stock music tracks, written as code. Each one is a short arrangement over a chord cycle
 * whose length is a whole number of bars, rendered as a seamless loop (see ./synth.ts).
 *
 * House rules for a bed that sits UNDER a voice: no lead that competes with speech, soft
 * attacks, little energy around 2–4 kHz, quiet percussion, and the same loudness for every
 * track (TARGET_LUFS) so `music.volume` means the same thing whichever track is chosen.
 * ----------------------------------------------------------------------------------------- */

export const TARGET_LUFS = -16;

/** Time grid of a loop: sample positions of bars and beats (4/4). */
export class Grid {
  /** Samples per beat / per bar / per loop. All integers. */
  readonly beat: number;
  readonly bar: number;
  readonly length: number;

  constructor(
    readonly bpm: number,
    readonly bars: number,
  ) {
    this.beat = (SAMPLE_RATE * 60) / bpm;
    this.bar = this.beat * 4;
    this.length = this.bar * bars;
    if (!Number.isInteger(this.bar)) {
      throw new Error(`${bpm} BPM does not give a whole number of samples per bar`);
    }
    if (this.length % 1024 !== 0) {
      // Whole AAC frames, so the encoded file needs no end padding (see ./encode.ts).
      throw new Error(`${bars} bars at ${bpm} BPM is not a multiple of 1024 samples`);
    }
  }

  /** Sample offset of `beat` (may be fractional) inside `bar`. */
  at(bar: number, beat = 0): number {
    return Math.round(bar * this.bar + beat * this.beat);
  }

  /** Seconds spanned by `beats`. */
  seconds(beats: number): number {
    return (beats * this.beat) / SAMPLE_RATE;
  }

  get durationMs(): number {
    return Math.round((this.length / SAMPLE_RATE) * 1000);
  }
}

export interface MusicTrackSpec {
  id: string;
  bpm: number;
  bars: number;
  seed: number;
  /** Optional overall low-pass applied when mastering. */
  lowpass?: number;
  /** Returns the un-mastered mix. */
  compose(grid: Grid, rng: Rng): Bus;
}

interface Chord {
  /** Bass note (MIDI). */
  bass: number;
  /** Chord tones, low to high (MIDI). */
  notes: readonly number[];
}

const hz = midiToHz;

/** Wet/dry helper: adds reverb (and its level) of `source` to `target`. */
function addReverb(target: Bus, source: Bus, level: number, size: number, damp = 0.5): void {
  target.mix(reverb(source, { size, damp }), level);
}

/* ============================== 1. Ambient dawn ============================== */

const ambientDawn: MusicTrackSpec = {
  id: 'music-ambient-dawn',
  bpm: 60,
  bars: 12,
  seed: 101,
  compose(g, rng) {
    // D major, two bars per chord: Dmaj9 – Bm11 – Gmaj9 – Asus4 – F#m7 – Gmaj9
    const chords: Chord[] = [
      { bass: 38, notes: [50, 57, 64, 66, 73] },
      { bass: 35, notes: [47, 54, 57, 62, 64] },
      { bass: 31, notes: [43, 50, 59, 66, 69] },
      { bass: 33, notes: [45, 52, 57, 62, 64] },
      { bass: 30, notes: [42, 49, 57, 64, 69] },
      { bass: 31, notes: [43, 50, 59, 62, 69] },
    ];
    const pad = new Bus(g.length);
    const sub = new Bus(g.length);
    const bells = new Bus(g.length);
    const slot = g.seconds(8);
    chords.forEach((chord, i) => {
      const start = g.at(i * 2);
      chord.notes.forEach((note, k) => {
        const voice = padVoice(hz(note), slot, {
          attack: 2.6,
          release: 3.4,
          cutoff: 950 + 160 * k,
          detune: 7 + k,
        });
        pad.add(voice, start, 0.1 + 0.012 * k, (k - 2) * 0.32);
      });
      sub.add(
        bassVoice(hz(chord.bass + 12), slot - 0.5, 1, { growl: 0.08, attack: 1.2, release: 2 }),
        start,
        0.07,
      );
    });
    swell(pad, 3, 0.18);

    // Sparse bell notes from D major pentatonic, on a half-beat grid.
    const scale = [74, 76, 78, 81, 83, 86];
    for (let bar = 0; bar < g.bars; bar += 1) {
      const count = bar % 2 === 0 ? 2 : 1;
      for (let k = 0; k < count; k += 1) {
        const beat = Math.floor(rng.range(0, 8)) / 2;
        const note = rng.pick(scale);
        bells.add(
          malletVoice(hz(note), 3.5, rng.range(0.5, 0.9), SOFT_BELL),
          g.at(bar, beat),
          0.075,
          rng.range(-0.6, 0.6),
        );
      }
    }
    bells.mix(delay(bells, { timeLeft: 0.75, timeRight: 1, feedback: 0.42, damp: 0.5 }), 0.5);

    const mix = new Bus(g.length);
    mix.mix(pad);
    mix.mix(sub);
    mix.mix(bells);
    const send = new Bus(g.length);
    send.mix(pad, 0.7);
    send.mix(bells, 1.2);
    addReverb(mix, send, 1.4, 0.88, 0.6);
    return mix;
  },
};

/* ============================== 2. Corporate rise ============================== */

const corporateRise: MusicTrackSpec = {
  id: 'music-corporate-rise',
  bpm: 100,
  bars: 16,
  seed: 202,
  compose(g, rng) {
    // C major, two bars per chord: Cadd9 – G/B – Am7 – Fmaj9
    const chords: (Chord & { pluck: number[] })[] = [
      { bass: 36, notes: [48, 55, 62, 64], pluck: [60, 62, 64, 67] },
      { bass: 35, notes: [47, 55, 62, 67], pluck: [59, 62, 67, 69] },
      { bass: 33, notes: [45, 55, 60, 64], pluck: [57, 60, 64, 67] },
      { bass: 41, notes: [45, 53, 60, 64], pluck: [57, 60, 65, 67] },
    ];
    const pad = new Bus(g.length);
    const plucks = new Bus(g.length);
    const keys = new Bus(g.length);
    const bass = new Bus(g.length);
    const drums = new Bus(g.length);
    const pattern = [0, 2, 1, 2, 0, 2, 3, 2];
    const accents = [1, 0.6, 0.75, 0.6, 0.9, 0.6, 0.78, 0.65];

    for (let bar = 0; bar < g.bars; bar += 1) {
      const chord = chords[Math.floor(bar / 2) % chords.length] as (typeof chords)[number];
      const second = bar >= 8;
      if (bar % 2 === 0) {
        chord.notes.forEach((note, k) => {
          pad.add(
            padVoice(hz(note), g.seconds(8) - 0.3, { attack: 0.5, release: 0.9, cutoff: 1500 }),
            g.at(bar),
            0.09,
            (k - 1.5) * 0.4,
          );
          keys.add(
            keysVoice(hz(note + 12), g.seconds(6), 0.7, { bright: 0.9, decay: 2.2 }),
            g.at(bar) + k * 500,
            0.1,
            (k - 1.5) * 0.25,
          );
        });
      }
      for (let step = 0; step < 8; step += 1) {
        const note = chord.pluck[pattern[step] as number] as number;
        const vel = (accents[step] as number) * rng.range(0.9, 1);
        plucks.add(
          pluckVoice(hz(note), 0.5, vel, rng, { sustain: 0.9, brightness: 0.5, mute: 0.1 }),
          g.at(bar, step / 2),
          0.2,
          step % 2 === 0 ? -0.3 : 0.3,
        );
        if (second && step % 2 === 1) {
          plucks.add(
            pluckVoice(hz(note + 12), 0.45, vel * 0.7, rng, {
              sustain: 0.7,
              brightness: 0.55,
              mute: 0.08,
            }),
            g.at(bar, step / 2),
            0.1,
            0.5,
          );
        }
        bass.add(
          bassVoice(hz(chord.bass), g.seconds(0.36), step % 2 === 0 ? 1 : 0.7, {
            growl: 0.45,
            decay: 0.5,
          }),
          g.at(bar, step / 2),
          0.11,
        );
        if (step % 2 === 1) {
          drums.add(
            noiseHit(0.5, rng, { kind: 'highpass', freq: 7500, decay: 0.022 }),
            g.at(bar, step / 2),
            0.06,
            0.2,
          );
        }
        if (second) {
          for (const off of [0, 0.25]) {
            drums.add(
              noiseHit(off === 0 ? 0.8 : 0.5, rng, {
                kind: 'bandpass',
                freq: 5200,
                q: 1.2,
                attack: 0.006,
                decay: 0.03,
              }),
              g.at(bar, step / 2 + off),
              0.045,
              -0.35,
            );
          }
        }
      }
      for (const beat of [0, 2]) drums.add(kickVoice(beat === 0 ? 1 : 0.8), g.at(bar, beat), 0.2);
      for (const beat of [1, 3]) {
        drums.add(snareVoice(0.7, rng, 210, 0.06), g.at(bar, beat), 0.09, 0.1);
      }
    }
    plucks.mix(
      delay(plucks, { timeLeft: g.seconds(0.75), timeRight: g.seconds(0.5), feedback: 0.28 }),
      0.22,
    );
    const mix = new Bus(g.length);
    for (const bus of [pad, plucks, keys, bass, drums]) mix.mix(bus);
    const send = new Bus(g.length);
    send.mix(pad, 0.6);
    send.mix(plucks, 0.5);
    send.mix(keys, 0.8);
    send.mix(drums, 0.15);
    addReverb(mix, send, 0.9, 0.55);
    return mix;
  },
};

/* ============================== 3. Lo-fi study ============================== */

const lofiStudy: MusicTrackSpec = {
  id: 'music-lofi-study',
  bpm: 80,
  bars: 16,
  seed: 303,
  lowpass: 6500,
  compose(g, rng) {
    // ii – V – I – vi in C: Dm9 – G13 – Cmaj9 – Am9
    const chords: Chord[] = [
      { bass: 38, notes: [53, 57, 60, 64] },
      { bass: 43, notes: [53, 57, 59, 64] },
      { bass: 36, notes: [52, 55, 59, 62] },
      { bass: 45, notes: [55, 59, 60, 64] },
    ];
    const keys = new Bus(g.length);
    const bass = new Bus(g.length);
    const drums = new Bus(g.length);
    const lead = new Bus(g.length);
    const swing = 0.09;
    const humanise = (): number => Math.round(rng.range(-0.004, 0.004) * SAMPLE_RATE);

    for (let bar = 0; bar < g.bars; bar += 1) {
      const chord = chords[bar % chords.length] as Chord;
      const cycle = Math.floor(bar / 4);
      for (const [beat, hold, vel] of [
        [0, 1.7, 0.8],
        [2.5 + swing, 1.3, 0.6],
      ] as const) {
        chord.notes.forEach((note, k) => {
          keys.add(
            keysVoice(hz(note), g.seconds(hold), vel * rng.range(0.85, 1), {
              bright: 1.6,
              decay: 1.5,
              tine: 0.05,
            }),
            g.at(bar, beat) + k * 620 + humanise(),
            0.14,
            (k - 1.5) * 0.3,
          );
        });
      }
      bass.add(
        bassVoice(hz(chord.bass), g.seconds(1.4), 1, { growl: 0.3, decay: 1.2 }),
        g.at(bar, 0),
        0.13,
      );
      bass.add(
        bassVoice(hz(chord.bass), g.seconds(0.9), 0.75, { growl: 0.3, decay: 0.9 }),
        g.at(bar, 2.5 + swing),
        0.13,
      );
      drums.add(kickVoice(1, { from: 100, to: 44, decay: 0.2 }), g.at(bar, 0) + humanise(), 0.22);
      drums.add(
        kickVoice(0.8, { from: 100, to: 44, decay: 0.2 }),
        g.at(bar, 2.5 + swing) + humanise(),
        0.22,
      );
      if (bar % 4 === 3) drums.add(kickVoice(0.6, { decay: 0.16 }), g.at(bar, 3.75), 0.2);
      for (const beat of [1, 3]) {
        drums.add(snareVoice(0.8, rng, 175, 0.1), g.at(bar, beat) + humanise() + 300, 0.1, 0.05);
      }
      for (let step = 0; step < 8; step += 1) {
        const beat = step / 2 + (step % 2 === 1 ? swing : 0);
        const vel = step % 2 === 0 ? 0.7 : 0.45;
        drums.add(
          noiseHit(vel * rng.range(0.8, 1), rng, { kind: 'highpass', freq: 6000, decay: 0.03 }),
          g.at(bar, beat) + humanise(),
          0.05,
          -0.25,
        );
      }
      // A few answering notes in the 2nd and 4th cycles only.
      if (cycle % 2 === 1) {
        const pool = [chord.notes[1] as number, chord.notes[2] as number, chord.notes[3] as number];
        for (const beat of [1.5 + swing, 3.5 + swing]) {
          if (rng.next() < 0.65) {
            lead.add(
              malletVoice(hz(rng.pick(pool) + 12), 1.6, rng.range(0.5, 0.8), SOFT_BELL),
              g.at(bar, beat),
              0.06,
              rng.range(0.1, 0.5),
            );
          }
        }
      }
    }
    lead.mix(
      delay(lead, { timeLeft: g.seconds(0.75), timeRight: g.seconds(1), feedback: 0.3 }),
      0.4,
    );

    // Tape hiss and vinyl crackle, generated per sample so they are trivially periodic.
    const vinyl = new Bus(g.length);
    let hissL = 0;
    let hissR = 0;
    for (let i = 0; i < g.length; i += 1) {
      hissL += 0.3 * (rng.bipolar() - hissL);
      hissR += 0.3 * (rng.bipolar() - hissR);
      const crackle = rng.next() < 0.00012 ? rng.bipolar() * rng.range(0.3, 1) : 0;
      vinyl.left[i] = hissL * 0.006 + crackle * 0.05;
      vinyl.right[i] = hissR * 0.006 + crackle * 0.04;
    }
    filterBus(vinyl, biquad('bandpass', 2400, 0.5));

    const mix = new Bus(g.length);
    for (const bus of [keys, bass, drums, lead, vinyl]) mix.mix(bus);
    const send = new Bus(g.length);
    send.mix(keys, 0.7);
    send.mix(lead, 1);
    send.mix(drums, 0.2);
    addReverb(mix, send, 0.8, 0.5, 0.7);
    return mix;
  },
};

/* ============================== 4. Tech pulse ============================== */

const techPulse: MusicTrackSpec = {
  id: 'music-tech-pulse',
  bpm: 120,
  bars: 16,
  seed: 404,
  compose(g, rng) {
    // A minor, one bar per chord: Am – Fmaj7 – C – G
    const chords: Chord[] = [
      { bass: 33, notes: [57, 60, 64, 69] },
      { bass: 41, notes: [53, 57, 60, 64] },
      { bass: 36, notes: [55, 60, 64, 67] },
      { bass: 43, notes: [55, 59, 62, 67] },
    ];
    const arp = new Bus(g.length);
    const pad = new Bus(g.length);
    const bass = new Bus(g.length);
    const drums = new Bus(g.length);
    const order = [0, 1, 2, 3, 2, 1, 0, 1, 2, 3, 2, 1, 0, 1, 2, 3];
    const blip = [
      { ratio: 1, amp: 1, decay: 0.11 },
      { ratio: 2, amp: 0.22, decay: 0.06 },
    ];
    const blipBright = [
      { ratio: 1, amp: 1, decay: 0.13 },
      { ratio: 2, amp: 0.35, decay: 0.08 },
      { ratio: 3, amp: 0.12, decay: 0.04 },
    ];

    for (let bar = 0; bar < g.bars; bar += 1) {
      const chord = chords[bar % chords.length] as Chord;
      const cycle = Math.floor(bar / 4);
      const lifted = cycle % 2 === 1;
      chord.notes.forEach((note, k) => {
        pad.add(
          padVoice(hz(note), g.seconds(4) - 0.15, { attack: 0.25, release: 0.5, cutoff: 1900 }),
          g.at(bar),
          0.09,
          (k - 1.5) * 0.45,
        );
      });
      for (let step = 0; step < 16; step += 1) {
        const note = (chord.notes[order[step] as number] as number) + (lifted ? 12 : 0);
        const vel = step % 4 === 0 ? 1 : step % 2 === 0 ? 0.7 : 0.5;
        arp.add(
          malletVoice(hz(note), 0.5, vel, lifted ? blipBright : blip),
          g.at(bar, step / 4),
          0.11,
          Math.sin(step * 0.9) * 0.4,
        );
      }
      for (let beat = 0; beat < 4; beat += 1) {
        drums.add(kickVoice(0.9, { from: 105, to: 48, decay: 0.15 }), g.at(bar, beat), 0.18);
        bass.add(
          bassVoice(hz(chord.bass), g.seconds(0.4), 1, { growl: 0.35, decay: 0.45 }),
          g.at(bar, beat + 0.5),
          0.13,
        );
        drums.add(
          noiseHit(0.6, rng, { kind: 'highpass', freq: 8000, decay: 0.02 }),
          g.at(bar, beat + 0.5),
          0.06,
          0.25,
        );
        if (lifted && beat % 2 === 1) {
          drums.add(clapVoice(0.7, rng), g.at(bar, beat), 0.07, -0.1);
        }
      }
    }
    pump(pad, g.beat, 0.55);
    arp.mix(
      delay(arp, {
        timeLeft: g.seconds(0.75),
        timeRight: g.seconds(0.75),
        feedback: 0.42,
        damp: 0.45,
        cross: true,
      }),
      0.45,
    );
    const mix = new Bus(g.length);
    for (const bus of [arp, pad, bass, drums]) mix.mix(bus);
    const send = new Bus(g.length);
    send.mix(arp, 0.8);
    send.mix(pad, 0.5);
    addReverb(mix, send, 0.9, 0.65);
    return mix;
  },
};

/* ============================== 5. News desk ============================== */

const newsDesk: MusicTrackSpec = {
  id: 'music-news-desk',
  bpm: 125,
  bars: 20,
  seed: 505,
  compose(g, rng) {
    // D minor, one bar per chord: Dm – Bb – F – C
    const chords: (Chord & { riff: number[] })[] = [
      { bass: 38, notes: [50, 53, 57, 62], riff: [50, 57, 62] },
      { bass: 34, notes: [46, 53, 58, 62], riff: [46, 53, 58] },
      { bass: 41, notes: [48, 53, 57, 60], riff: [53, 60, 65] },
      { bass: 36, notes: [48, 52, 55, 60], riff: [48, 55, 60] },
    ];
    const strings = new Bus(g.length);
    const pad = new Bus(g.length);
    const bass = new Bus(g.length);
    const drums = new Bus(g.length);
    const signal = new Bus(g.length);
    const riffOrder = [0, 0, 1, 0, 0, 1, 0, 2];
    const riffAccent = [1, 0.55, 0.8, 0.55, 0.85, 0.7, 0.55, 0.9];

    for (let bar = 0; bar < g.bars; bar += 1) {
      const chord = chords[bar % chords.length] as (typeof chords)[number];
      chord.notes.forEach((note, k) => {
        pad.add(
          padVoice(hz(note), g.seconds(4) - 0.1, {
            attack: bar % 4 === 3 ? 1.2 : 0.3,
            release: 0.4,
            cutoff: bar % 4 === 3 ? 1900 : 1200,
          }),
          g.at(bar),
          0.075,
          (k - 1.5) * 0.4,
        );
      });
      for (let step = 0; step < 8; step += 1) {
        const note = chord.riff[riffOrder[step] as number] as number;
        const vel = riffAccent[step] as number;
        for (const [shift, pan] of [
          [0, -0.35],
          [12, 0.35],
        ] as const) {
          strings.add(
            padVoice(hz(note + shift), 0.085, {
              attack: 0.006,
              release: 0.09,
              cutoff: 2100,
              detune: 11,
              drift: 0,
            }),
            g.at(bar, step / 2),
            0.2 * vel * (shift === 0 ? 1 : 0.6),
            pan,
          );
        }
        bass.add(
          bassVoice(hz(chord.bass), g.seconds(0.38), step % 2 === 0 ? 1 : 0.75, {
            growl: 0.45,
            decay: 0.4,
          }),
          g.at(bar, step / 2),
          0.08,
        );
      }
      for (let beat = 0; beat < 4; beat += 1) {
        drums.add(kickVoice(0.8, { from: 95, to: 50, decay: 0.12 }), g.at(bar, beat), 0.1);
        for (let sub = 0; sub < 4; sub += 1) {
          drums.add(
            noiseHit(sub === 0 ? 0.8 : 0.4, rng, { kind: 'highpass', freq: 9000, decay: 0.012 }),
            g.at(bar, beat + sub / 4),
            0.035,
            0.3,
          );
        }
      }
      if (bar % 4 === 0) {
        drums.add(boomVoice(1, rng, 55), g.at(bar), 0.1);
        // The station "signal": a rising fifth on a glockenspiel.
        signal.add(malletVoice(hz(74), 1.6, 0.8, GLOCKEN), g.at(bar, 0), 0.06, -0.2);
        signal.add(malletVoice(hz(81), 2, 0.9, GLOCKEN), g.at(bar, 1.5), 0.06, 0.2);
      } else if (bar % 4 === 2) {
        drums.add(boomVoice(0.6, rng, 55), g.at(bar), 0.1);
      }
    }
    signal.mix(
      delay(signal, { timeLeft: g.seconds(1.5), timeRight: g.seconds(1), feedback: 0.3 }),
      0.4,
    );
    const mix = new Bus(g.length);
    for (const bus of [strings, pad, bass, drums, signal]) mix.mix(bus);
    const send = new Bus(g.length);
    send.mix(strings, 0.7);
    send.mix(pad, 0.5);
    send.mix(signal, 1);
    send.mix(drums, 0.25);
    addReverb(mix, send, 0.85, 0.6);
    return mix;
  },
};

/* ============================== 6. Warm acoustic ============================== */

const warmAcoustic: MusicTrackSpec = {
  id: 'music-warm-acoustic',
  bpm: 90,
  bars: 16,
  seed: 606,
  compose(g, rng) {
    // G major, two bars per chord: G – Em7 – Cadd9 – Dsus4/D. `treble` are the picked strings.
    const chords: (Chord & { fifth: number; treble: number[] })[] = [
      { bass: 43, fifth: 50, notes: [43, 50, 55, 59, 62, 67], treble: [55, 59, 62, 67] },
      { bass: 40, fifth: 47, notes: [40, 47, 52, 55, 62, 64], treble: [55, 59, 62, 64] },
      { bass: 48, fifth: 43, notes: [48, 52, 55, 62, 64, 67], treble: [55, 62, 64, 67] },
      { bass: 50, fifth: 45, notes: [50, 57, 62, 66], treble: [57, 62, 66, 69] },
    ];
    const guitar = new Bus(g.length);
    const strum = new Bus(g.length);
    const bass = new Bus(g.length);
    const shaker = new Bus(g.length);
    const pad = new Bus(g.length);
    // 8th-note fingerpicking: thumb on 1 and 3, fingers in between.
    const picking: (number | 'bass' | 'fifth')[] = ['bass', 1, 2, 0, 'fifth', 1, 3, 2];

    for (let bar = 0; bar < g.bars; bar += 1) {
      const chord = chords[Math.floor(bar / 2) % chords.length] as (typeof chords)[number];
      const second = bar >= 8;
      // Dsus4 resolves to D on the second bar of the chord.
      const treble =
        chord.bass === 50 && bar % 2 === 0 ? [57, 62, 67, 69] : (chord.treble as number[]);
      for (let step = 0; step < 8; step += 1) {
        const what = picking[step] as number | 'bass' | 'fifth';
        const thumb = typeof what !== 'number';
        const note = what === 'bass' ? chord.bass : what === 'fifth' ? chord.fifth : treble[what];
        guitar.add(
          pluckVoice(hz(note as number), 2.6, (thumb ? 0.9 : 0.7) * rng.range(0.85, 1), rng, {
            sustain: thumb ? 3.2 : 2.6,
            brightness: thumb ? 0.3 : 0.42,
          }),
          g.at(bar, step / 2) + Math.round(rng.range(-0.003, 0.003) * SAMPLE_RATE),
          0.2,
          thumb ? -0.15 : -0.35 + 0.12 * (what as number),
        );
        const accent = step % 4 === 2 ? 0.9 : step % 2 === 0 ? 0.55 : 0.4;
        shaker.add(
          noiseHit(accent, rng, {
            kind: 'bandpass',
            freq: 5500,
            q: 1,
            attack: 0.012,
            decay: 0.035,
          }),
          g.at(bar, step / 2),
          second ? 0.06 : 0.04,
          0.4,
        );
      }
      if (second) {
        // Second guitar: one soft down-strum per bar, low strings first.
        chord.notes.forEach((note, k) => {
          strum.add(
            pluckVoice(hz(note), 3, 0.55, rng, { sustain: 3, brightness: 0.4 }),
            g.at(bar, 0) + k * 720,
            0.1,
            0.45,
          );
        });
      }
      bass.add(
        bassVoice(hz(chord.bass - 12), g.seconds(1.6), 1, { growl: 0.4, decay: 1.4 }),
        g.at(bar, 0),
        0.05,
      );
      bass.add(
        bassVoice(hz(chord.fifth - 12), g.seconds(1.2), 0.7, { growl: 0.4, decay: 1.2 }),
        g.at(bar, 2),
        0.05,
      );
      if (bar % 2 === 0) {
        for (const note of [chord.notes[1] as number, chord.notes[2] as number]) {
          pad.add(
            padVoice(hz(note + 12), g.seconds(8) - 0.5, { attack: 1.5, release: 1.5, cutoff: 900 }),
            g.at(bar),
            0.045,
            note % 2 === 0 ? -0.4 : 0.4,
          );
        }
      }
    }
    const mix = new Bus(g.length);
    for (const bus of [guitar, strum, bass, shaker, pad]) mix.mix(bus);
    const send = new Bus(g.length);
    send.mix(guitar, 0.6);
    send.mix(strum, 0.8);
    send.mix(pad, 0.6);
    send.mix(shaker, 0.2);
    addReverb(mix, send, 0.75, 0.45, 0.6);
    return mix;
  },
};

/* ============================== 7. Happy day ============================== */

const happyDay: MusicTrackSpec = {
  id: 'music-happy-day',
  bpm: 112.5,
  bars: 16,
  seed: 707,
  compose(g, rng) {
    // C major, one bar per chord: C – F – Am – G
    const chords: (Chord & { fifth: number; uke: number[]; tune: number[] })[] = [
      { bass: 36, fifth: 43, notes: [], uke: [67, 60, 64, 72], tune: [60, 64, 67, 72] },
      { bass: 41, fifth: 48, notes: [], uke: [65, 60, 69, 72], tune: [60, 65, 69, 72] },
      { bass: 45, fifth: 40, notes: [], uke: [69, 60, 64, 72], tune: [60, 64, 69, 72] },
      { bass: 43, fifth: 38, notes: [], uke: [67, 62, 67, 71], tune: [59, 62, 67, 71] },
    ];
    const marimba = new Bus(g.length);
    const uke = new Bus(g.length);
    const bass = new Bus(g.length);
    const drums = new Bus(g.length);
    const sparkle = new Bus(g.length);
    const tuneA = [0, 2, 1, 2, 3, 2, 1, -1];
    const tuneB = [1, 2, 3, 2, 1, -1, 0, 2];

    for (let bar = 0; bar < g.bars; bar += 1) {
      const chord = chords[bar % chords.length] as (typeof chords)[number];
      const cycle = Math.floor(bar / 4);
      const tune = cycle % 2 === 0 ? tuneA : tuneB;
      for (let step = 0; step < 8; step += 1) {
        const degree = tune[step] as number;
        if (degree >= 0) {
          marimba.add(
            malletVoice(
              hz(chord.tune[degree] as number),
              0.9,
              (step % 2 === 0 ? 0.9 : 0.65) * rng.range(0.9, 1),
              MARIMBA,
            ),
            g.at(bar, step / 2),
            0.2,
            -0.2 + 0.1 * degree,
          );
        }
        // Ukulele: muted "chk" on the beat, open strum on the off-beat.
        const offBeat = step % 2 === 1;
        chord.uke.forEach((note, k) => {
          uke.add(
            pluckVoice(hz(note), offBeat ? 0.7 : 0.2, offBeat ? 0.7 : 0.4, rng, {
              sustain: offBeat ? 1.2 : 0.3,
              brightness: 0.65,
              ...(offBeat ? { mute: 0.22 } : { mute: 0.03 }),
            }),
            g.at(bar, step / 2) + k * 330,
            0.075,
            0.35,
          );
        });
        drums.add(
          noiseHit(offBeat ? 0.5 : 0.8, rng, {
            kind: 'bandpass',
            freq: 6000,
            q: 1.1,
            attack: 0.008,
            decay: 0.03,
          }),
          g.at(bar, step / 2),
          0.05,
          -0.4,
        );
      }
      for (const [beat, note, hold] of [
        [0, chord.bass, 0.8],
        [2, chord.fifth, 0.8],
        [3, chord.bass, 0.5],
      ] as const) {
        bass.add(
          bassVoice(hz(note), g.seconds(hold), 1, { growl: 0.45, decay: 0.6 }),
          g.at(bar, beat),
          0.12,
        );
      }
      for (const beat of [0, 2]) drums.add(kickVoice(0.9, { decay: 0.14 }), g.at(bar, beat), 0.18);
      for (const beat of [1, 3]) drums.add(clapVoice(0.8, rng), g.at(bar, beat), 0.1, 0.1);
      if (cycle >= 2) {
        for (const beat of [0, 2]) {
          sparkle.add(
            malletVoice(hz((chord.tune[beat === 0 ? 2 : 1] as number) + 24), 1.4, 0.7, GLOCKEN),
            g.at(bar, beat),
            0.035,
            0.5,
          );
        }
      }
    }
    const mix = new Bus(g.length);
    for (const bus of [marimba, uke, bass, drums, sparkle]) mix.mix(bus);
    const send = new Bus(g.length);
    send.mix(marimba, 0.6);
    send.mix(uke, 0.4);
    send.mix(sparkle, 1);
    send.mix(drums, 0.2);
    addReverb(mix, send, 0.7, 0.45);
    return mix;
  },
};

/* ============================== 8. Cinematic hope ============================== */

const cinematicHope: MusicTrackSpec = {
  id: 'music-cinematic-hope',
  bpm: 72,
  bars: 16,
  seed: 808,
  compose(g, rng) {
    // B minor / D major, two bars per chord: Bm – G – D – A. `top` is the string line.
    const chords: (Chord & { top: number })[] = [
      { bass: 35, notes: [59, 62, 66, 71], top: 78 },
      { bass: 31, notes: [59, 62, 67, 71], top: 79 },
      { bass: 38, notes: [57, 62, 66, 69], top: 81 },
      { bass: 33, notes: [57, 61, 64, 69], top: 76 },
    ];
    const piano = new Bus(g.length);
    const strings = new Bus(g.length);
    const sub = new Bus(g.length);
    const hits = new Bus(g.length);
    const broken = [0, 1, 2, 1, 3, 1, 2, 1];

    for (let bar = 0; bar < g.bars; bar += 1) {
      const chord = chords[Math.floor(bar / 2) % chords.length] as (typeof chords)[number];
      const second = bar >= 8;
      for (let step = 0; step < 8; step += 1) {
        // First pass: quarter notes only. Second pass: flowing eighths.
        if (!second && step % 2 === 1) continue;
        const note = chord.notes[broken[step] as number] as number;
        const vel = (step === 0 ? 0.85 : step % 2 === 0 ? 0.65 : 0.5) * rng.range(0.9, 1);
        piano.add(
          keysVoice(hz(note), g.seconds(1.5), vel, { bright: 1.25, decay: 2.6, tine: 0.03 }),
          g.at(bar, step / 2) + Math.round(rng.range(-0.003, 0.003) * SAMPLE_RATE),
          0.15,
          -0.3 + 0.2 * (broken[step] as number),
        );
      }
      if (bar % 2 === 0) {
        const span = g.seconds(8);
        piano.add(
          keysVoice(hz(chord.bass + 12), span * 0.8, 0.8, { bright: 0.7, decay: 3.5, tine: 0 }),
          g.at(bar),
          0.1,
          -0.1,
        );
        [chord.notes[0] as number, chord.notes[2] as number].forEach((note, k) => {
          strings.add(
            padVoice(hz(note - 12), span - 0.2, { attack: 1.4, release: 1.6, cutoff: 1700 }),
            g.at(bar),
            second ? 0.13 : 0.09,
            k === 0 ? -0.45 : 0.45,
          );
        });
        if (second) {
          strings.add(
            padVoice(hz(chord.top), span - 0.2, {
              attack: 1.8,
              release: 1.8,
              cutoff: 2300,
              detune: 6,
            }),
            g.at(bar),
            0.06,
            0.15,
          );
        }
        sub.add(
          bassVoice(hz(chord.bass + 12), span - 0.4, 1, { growl: 0.3, attack: 0.3, release: 0.8 }),
          g.at(bar),
          second ? 0.05 : 0.04,
        );
      }
      if (bar % 8 === 0) hits.add(boomVoice(bar === 0 ? 0.7 : 1, rng, 47), g.at(bar), 0.12);
    }
    swell(strings, 2, 0.2, 0.5);
    const mix = new Bus(g.length);
    for (const bus of [piano, strings, sub, hits]) mix.mix(bus);
    const send = new Bus(g.length);
    send.mix(piano, 0.8);
    send.mix(strings, 0.7);
    send.mix(hits, 0.5);
    addReverb(mix, send, 1.2, 0.82, 0.55);
    return mix;
  },
};

export const MUSIC_TRACKS: readonly MusicTrackSpec[] = [
  ambientDawn,
  corporateRise,
  lofiStudy,
  techPulse,
  newsDesk,
  warmAcoustic,
  happyDay,
  cinematicHope,
];

/** Render one track to its final, mastered, loopable stereo buffer. */
export function renderTrack(spec: MusicTrackSpec): { bus: Bus; grid: Grid } {
  const grid = new Grid(spec.bpm, spec.bars);
  const bus = spec.compose(grid, new Rng(spec.seed));
  master(bus, { lufs: TARGET_LUFS, ...(spec.lowpass ? { lowpass: spec.lowpass } : {}) });
  return { bus, grid };
}

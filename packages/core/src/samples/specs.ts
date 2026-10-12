/* Parameter specs of the sample generators (section 3.7). normalize clamps SamplePatch.params to these. */

import type {
  SampleGeneratorId,
  SampleGeneratorSpec,
  SampleParamSpec,
} from "../types.ts";

function p(
  label: string,
  min: number,
  max: number,
  def: number
): SampleParamSpec {
  return { default: def, label, max, min };
}

export const SAMPLE_SPECS: Readonly<
  Record<SampleGeneratorId, SampleGeneratorSpec>
> = {
  bass: {
    id: "bass",
    label: "Bass",
    loops: true,
    params: {
      cutoff: p("Cutoff", 0, 1, 0.4),
      resonance: p("Resonance", 0, 1, 0.2),
      sub: p("Sub", 0, 1, 0.3),
    },
  },
  bell: {
    id: "bell",
    label: "Bell",
    loops: false,
    params: {
      decay: p("Decay (s)", 0.2, 3, 1.2),
      index: p("Index", 0, 8, 3),
      ratio: p("Ratio", 1, 8, 3.5),
    },
  },
  choir: {
    id: "choir",
    label: "Choir",
    loops: true,
    params: {
      breath: p("Breath", 0, 1, 0.15),
      vibrato: p("Vibrato", 0, 1, 0.3),
      vowel: p("Vowel", 0, 1, 0.2),
    },
  },
  clap: {
    id: "clap",
    label: "Clap",
    loops: false,
    params: {
      decay: p("Decay (s)", 0.05, 0.6, 0.2),
      spread: p("Spread", 0, 1, 0.5),
      tone: p("Tone", 0, 1, 0.5),
    },
  },
  clap909: {
    id: "clap909",
    label: "Clap 909",
    loops: false,
    params: {
      decay: p("Decay (s)", 0.08, 0.7, 0.26),
      spread: p("Spread", 0, 1, 0.6),
      tone: p("Brightness", 0, 1, 0.55),
    },
  },
  crash: {
    id: "crash",
    label: "Crash",
    loops: false,
    params: {
      decay: p("Decay (s)", 0.3, 3.5, 1.6),
      tone: p("Brightness", 0, 1, 0.6),
    },
  },
  crash909: {
    id: "crash909",
    label: "Crash 909",
    loops: false,
    params: {
      decay: p("Decay (s)", 0.4, 3.5, 1.4),
      tone: p("Brightness", 0, 1, 0.7),
    },
  },
  hat: {
    id: "hat",
    label: "Hat",
    loops: false,
    params: {
      decay: p("Decay (s)", 0.01, 0.5, 0.06),
      open: p("Open", 0, 1, 0),
      tone: p("Brightness", 0, 1, 0.6),
    },
  },
  hat909: {
    id: "hat909",
    label: "Hat 909",
    loops: false,
    params: {
      open: p("Open", 0, 1, 0),
      tone: p("Brightness", 0, 1, 0.6),
    },
  },
  kick: {
    id: "kick",
    label: "Kick",
    loops: false,
    params: {
      click: p("Click", 0, 1, 0.4),
      decay: p("Decay (s)", 0.05, 1, 0.35),
      drive: p("Drive", 0, 1, 0.2),
      pitch: p("Pitch (Hz)", 35, 120, 55),
      sweep: p("Sweep", 0, 1, 0.6),
    },
  },
  kick808: {
    id: "kick808",
    label: "Kick 808",
    loops: false,
    params: {
      click: p("Click", 0, 1, 0.1),
      decay: p("Decay (s)", 0.2, 1.8, 0.8),
      drive: p("Drive", 0, 1, 0.25),
      pitch: p("Pitch (Hz)", 30, 80, 46),
    },
  },
  kick909: {
    id: "kick909",
    label: "Kick 909",
    loops: false,
    params: {
      click: p("Click", 0, 1, 0.55),
      decay: p("Decay (s)", 0.08, 0.9, 0.32),
      drive: p("Drive", 0, 1, 0.5),
      pitch: p("Pitch (Hz)", 38, 90, 52),
      sweep: p("Sweep", 0, 1, 0.7),
    },
  },
  lead: {
    id: "lead",
    label: "Lead",
    loops: true,
    params: {
      bright: p("Brightness", 0, 1, 0.6),
      duty: p("Pulse width", 0.05, 0.5, 0.25),
      vibrato: p("Vibrato", 0, 1, 0.4),
    },
  },
  orchestra: {
    id: "orchestra",
    label: "Orchestra hit",
    loops: false,
    params: {
      bright: p("Brightness", 0, 1, 0.6),
      decay: p("Decay (s)", 0.12, 1.2, 0.42),
      detune: p("Detune", 0, 1, 0.35),
      width: p("Chord width", 0, 1, 0.7),
    },
  },
  organ: {
    id: "organ",
    label: "Organ",
    loops: true,
    params: {
      fourth: p("2 foot", 0, 1, 0.3),
      perc: p("Percussion", 0, 1, 0.2),
      second: p("8 foot", 0, 1, 0.8),
      sub: p("16 foot", 0, 1, 0.5),
      third: p("4 foot", 0, 1, 0.4),
    },
  },
  pad: {
    id: "pad",
    label: "Pad",
    loops: true,
    params: {
      cutoff: p("Cutoff", 0, 1, 0.5),
      detune: p("Detune", 0, 1, 0.4),
      speed: p("Filter motion", 0, 1, 0.3),
    },
  },
  pluck: {
    id: "pluck",
    label: "Pluck",
    loops: false,
    params: {
      brightness: p("Brightness", 0, 1, 0.6),
      damp: p("Damping", 0, 1, 0.3),
      pick: p("Pick position", 0, 1, 0.5),
    },
  },
  snare: {
    id: "snare",
    label: "Snare",
    loops: false,
    params: {
      decay: p("Decay (s)", 0.05, 0.8, 0.2),
      noise: p("Noise", 0, 1, 0.6),
      snap: p("Snap", 0, 1, 0.5),
      tone: p("Tone (Hz)", 120, 400, 190),
    },
  },
  snare909: {
    id: "snare909",
    label: "Snare 909",
    loops: false,
    params: {
      decay: p("Decay (s)", 0.08, 0.6, 0.24),
      noise: p("Noise", 0, 1, 0.8),
      snap: p("Snap", 0, 1, 0.6),
      tone: p("Tone (Hz)", 140, 320, 200),
    },
  },
  strings: {
    id: "strings",
    label: "Strings",
    loops: true,
    params: {
      attack: p("Attack", 0, 1, 0.3),
      bright: p("Brightness", 0, 1, 0.5),
      detune: p("Detune", 0, 1, 0.4),
    },
  },
  tom: {
    id: "tom",
    label: "Tom",
    loops: false,
    params: {
      decay: p("Decay (s)", 0.1, 1, 0.35),
      pitch: p("Pitch (Hz)", 60, 400, 140),
      sweep: p("Sweep", 0, 1, 0.4),
    },
  },
};

/* Decoding an audio file into float channels: WAV by core's own decoder (it keeps the loop points stored in the file
   and needs no audio hardware), anything else (MP3, OGG, FLAC, AAC) through the browser's decodeAudioData. */
import { decodeWav } from "@bleepkit/core/tools";

export interface DecodedAudio {
  channels: Float32Array[];
  /** Loop points in frames, from a WAV file's sampler chunk. */
  loopEnd?: number;
  loopStart?: number;
  sampleRate: number;
}

const WAV_NAME = /\.wave?$/i;

export const AUDIO_ACCEPT = ".wav,.mp3,.ogg,.oga,.flac,.m4a,.aac,audio/*";

type Decoder = (bytes: ArrayBuffer) => Promise<{
  getChannelData: (i: number) => Float32Array;
  numberOfChannels: number;
  sampleRate: number;
}>;

/** The browser's decoder, or null where there is none (a test, an old browser). */
function browserDecoder(): Decoder | null {
  const Offline =
    typeof OfflineAudioContext === "undefined" ? null : OfflineAudioContext;
  if (!Offline) {
    return null;
  }
  return (bytes) => new Offline(1, 1, 44_100).decodeAudioData(bytes);
}

/** Decode a file's bytes. Throws an Error with words the person can read. */
export async function decodeAudioBytes(
  bytes: Uint8Array,
  name: string
): Promise<DecodedAudio> {
  let wavProblem = "";
  if (WAV_NAME.test(name)) {
    try {
      const wav = decodeWav(bytes);
      return {
        channels: wav.channels,
        ...(wav.loopStart === undefined ? {} : { loopStart: wav.loopStart }),
        ...(wav.loopEnd === undefined ? {} : { loopEnd: wav.loopEnd }),
        sampleRate: wav.sampleRate,
      };
    } catch (err) {
      // an unusual WAV (ADPCM, an odd header) may still decode in the browser
      wavProblem = (err as Error).message;
    }
  }
  const decode = browserDecoder();
  if (!decode) {
    throw new Error(
      wavProblem || "this browser cannot decode audio files, try a WAV file"
    );
  }
  try {
    const copy = bytes.slice().buffer;
    const buf = await decode(copy);
    return {
      channels: Array.from({ length: buf.numberOfChannels }, (_, i) =>
        buf.getChannelData(i).slice()
      ),
      sampleRate: buf.sampleRate,
    };
  } catch (error) {
    throw new Error(
      wavProblem ||
        `${name} is not an audio file this browser can read (WAV, MP3 and OGG work)`,
      { cause: error }
    );
  }
}

import { float32ToPcm16, arrayBufferToBase64 } from './pcmUtils';

// Inline worklet source to avoid Vite bundling issues with ?url imports.
// AudioWorklet.addModule() requires a URL to valid JS, so we create a Blob URL.
const WORKLET_SOURCE = `
class PcmRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(4096);
    this.idx = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (input && input.length > 0) {
      const channel = input[0];
      for (let i = 0; i < channel.length; i++) {
        this.buffer[this.idx++] = channel[i];
        if (this.idx >= 4096) {
          this.port.postMessage({ samples: this.buffer.slice() });
          this.idx = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('pcm-recorder-processor', PcmRecorderProcessor);
`;

function createWorkletUrl(): string {
  const blob = new Blob([WORKLET_SOURCE], { type: 'application/javascript' });
  return URL.createObjectURL(blob);
}

export class GeminiAudioRecorder {
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private scriptNode: ScriptProcessorNode | null = null;
  private muted = false;
  private started = false;
  private onErrorCallback: ((error: Error) => void) | undefined;
  private acquiringPromise: Promise<void> | null = null;

  private releaseMediaStream(): void {
    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect();
      } catch {
        // ignore disconnect errors
      }
      this.sourceNode = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => {
        track.onended = null;
        track.stop();
      });
      this.mediaStream = null;
    }
  }

  private connectSourceToGraph(): void {
    if (!this.audioContext || !this.mediaStream) return;
    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect();
      } catch {
        // ignore disconnect errors
      }
    }
    this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
    if (this.workletNode) {
      this.sourceNode.connect(this.workletNode);
    } else if (this.scriptNode) {
      this.sourceNode.connect(this.scriptNode);
    }
  }

  private async ensureMediaStream(): Promise<void> {
    if (this.mediaStream || this.muted || !this.started) return;
    if (this.acquiringPromise) return this.acquiringPromise;

    this.acquiringPromise = (async () => {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: 16000, channelCount: 1 }
      });

      if (this.muted || !this.started || !this.audioContext) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      this.mediaStream = stream;
      this.mediaStream.getTracks().forEach((track) => {
        track.onended = () => {
          if (this.onErrorCallback) this.onErrorCallback(new Error('Microphone disconnected'));
        };
      });

      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }

      this.connectSourceToGraph();
    })().finally(() => {
      this.acquiringPromise = null;
    });

    return this.acquiringPromise;
  }

  async start(onChunk: (base64Pcm: string) => void, onError?: (error: Error) => void): Promise<void> {
    try {
      this.started = true;
      this.onErrorCallback = onError;

      this.audioContext = new AudioContext({ sampleRate: 16000 });
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }

      try {
        const workletUrl = createWorkletUrl();
        await this.audioContext.audioWorklet.addModule(workletUrl);
        URL.revokeObjectURL(workletUrl);

        this.workletNode = new AudioWorkletNode(this.audioContext, 'pcm-recorder-processor');
        this.workletNode.port.onmessage = (event) => {
          if (this.muted) return;
          const pcm16 = float32ToPcm16(event.data.samples);
          const base64 = arrayBufferToBase64(pcm16);
          onChunk(base64);
        };
        // Connect source → worklet → silent sink → destination.
        // The downstream connection is required so the audio graph pulls
        // frames through the worklet node and port.onmessage fires.
        const sink = this.audioContext.createGain();
        sink.gain.value = 0;
        this.workletNode.connect(sink);
        sink.connect(this.audioContext.destination);
      } catch (e) {
        console.warn('[GeminiLive] AudioWorklet failed, falling back to ScriptProcessorNode', e);
        this.scriptNode = this.audioContext.createScriptProcessor(4096, 1, 1);
        this.scriptNode.onaudioprocess = (event) => {
          if (this.muted) return;
          const inputData = event.inputBuffer.getChannelData(0);
          const pcm16 = float32ToPcm16(new Float32Array(inputData));
          const base64 = arrayBufferToBase64(pcm16);
          onChunk(base64);
        };
        this.scriptNode.connect(this.audioContext.destination);
      }

      if (!this.muted) {
        await this.ensureMediaStream();
      }
    } catch (e) {
      this.stop();
      if (onError) onError(e instanceof Error ? e : new Error(String(e)));
      throw e;
    }
  }

  stop(): void {
    this.started = false;
    this.releaseMediaStream();

    if (this.scriptNode) {
      this.scriptNode.disconnect();
      this.scriptNode = null;
    }

    if (this.workletNode) {
      this.workletNode.disconnect();
      this.workletNode = null;
    }

    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) {
      this.releaseMediaStream();
      return;
    }
    if (this.started && !this.mediaStream) {
      void this.ensureMediaStream().catch((err) => {
        if (this.onErrorCallback) {
          this.onErrorCallback(err instanceof Error ? err : new Error(String(err)));
        }
      });
    }
  }

  dispose(): void {
    this.stop();
  }
}

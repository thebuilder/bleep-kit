// fallow-ignore-file unused-class-member
import type { FromWorklet } from "@bleepkit/core";

/** A MessagePort stand-in that records what the processor posts. */
export class FakePort {
  readonly posted: {
    message: FromWorklet;
    transfer: Transferable[] | undefined;
  }[] = [];
  postMessage(message: FromWorklet, transfer?: Transferable[]): void {
    this.posted.push({ message, transfer });
  }
  of<T extends FromWorklet["type"]>(
    type: T
  ): Extract<FromWorklet, { type: T }>[] {
    return this.posted
      .map((p) => p.message)
      .filter((m): m is Extract<FromWorklet, { type: T }> => m.type === type);
  }
}

import type { Writable } from "node:stream";

/** Write one already-bounded protocol frame and observe asynchronous pipe failures exactly. */
export function writeReplayTargetProtocolFrame(input: Writable, frame: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const rejectStreamError = (error: Error): void => reject(error);
    input.once("error", rejectStreamError);
    input.write(frame, (error) => {
      if (error) {
        // Node emits the same failure on the stream after invoking the write callback. Keep the
        // one-shot listener installed so that event is observed instead of escaping the process.
        reject(error);
        return;
      }
      input.off("error", rejectStreamError);
      resolve();
    });
  });
}

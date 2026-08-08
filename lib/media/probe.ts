/**
 * Reading a file's real dimensions in the browser.
 *
 * Browser-only: uses `Image`, `HTMLVideoElement` and object URLs. Keep it out
 * of anything the server imports — `lib/media/aspect.ts` holds the DOM-free
 * maths for that reason.
 *
 * Why the server does not do this instead: it would mean decoding every upload
 * on a process capped at 400 MB RSS, for information the browser already has
 * for free. The trade is that probing can fail — a codec the browser cannot
 * decode, a corrupt file, a `loadedmetadata` that never fires — and **a failed
 * probe is "unknown", never "invalid"**. Every consumer treats null dimensions
 * as "cannot check", because refusing an upload the browser merely failed to
 * inspect would be worse than letting the platform judge it.
 */

export interface ProbedMedia {
  widthPx: number | null;
  heightPx: number | null;
  /** Videos only. */
  durationMs: number | null;
}

const UNKNOWN: ProbedMedia = {
  widthPx: null,
  heightPx: null,
  durationMs: null,
};

/** Metadata rarely takes this long; a file that does is treated as unknown. */
const PROBE_TIMEOUT_MS = 10_000;

function probeImage(url: string): Promise<ProbedMedia> {
  return new Promise((resolve) => {
    const image = new Image();
    const done = (result: ProbedMedia) => {
      image.onload = null;
      image.onerror = null;
      resolve(result);
    };

    image.onload = () =>
      done({
        widthPx: image.naturalWidth || null,
        heightPx: image.naturalHeight || null,
        durationMs: null,
      });
    image.onerror = () => done(UNKNOWN);
    image.src = url;
  });
}

function probeVideo(url: string): Promise<ProbedMedia> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    const done = (result: ProbedMedia) => {
      video.onloadedmetadata = null;
      video.onerror = null;
      // Release the decoder rather than waiting for GC — the composer may probe
      // ten of these in a row.
      video.removeAttribute("src");
      video.load();
      resolve(result);
    };

    video.preload = "metadata";
    video.muted = true;
    video.onloadedmetadata = () =>
      done({
        widthPx: video.videoWidth || null,
        heightPx: video.videoHeight || null,
        durationMs: Number.isFinite(video.duration)
          ? Math.round(video.duration * 1000)
          : null,
      });
    video.onerror = () => done(UNKNOWN);
    video.src = url;
  });
}

/**
 * Dimensions (and duration, for video) of a picked file.
 *
 * Never rejects. Every failure path resolves to nulls, because the caller's
 * only sensible response to "we could not read this" is to skip the checks that
 * depend on it.
 */
export async function probeMedia(file: File): Promise<ProbedMedia> {
  const url = URL.createObjectURL(file);

  try {
    const probe = file.type.startsWith("image/")
      ? probeImage(url)
      : probeVideo(url);

    const timeout = new Promise<ProbedMedia>((resolve) => {
      setTimeout(() => resolve(UNKNOWN), PROBE_TIMEOUT_MS);
    });

    return await Promise.race([probe, timeout]);
  } catch {
    return UNKNOWN;
  } finally {
    // Always revoked, including on the timeout path — a leaked object URL pins
    // the whole file in memory for the life of the document.
    URL.revokeObjectURL(url);
  }
}

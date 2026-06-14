/**
 * URL-safe slug generation. Mirrors Micro.blog conventions:
 *  - Titled posts → slugified title.
 *  - Untitled (microblog) posts → ISO date + short random hex suffix.
 */

export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .toLowerCase()
    .trim()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
}

export function randomHex(len = 4): string {
  const bytes = new Uint8Array(Math.ceil(len / 2));
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, len);
}

/**
 * Build a slug for a post. If a title is given it is slugified, otherwise a
 * date-based slug with a random suffix is produced. `exists` is an optional
 * predicate used to avoid collisions (a numeric/hex suffix is appended).
 */
export function buildSlug(
  opts: { title?: string | null; date?: Date },
  exists?: (slug: string) => boolean,
): string {
  const date = opts.date ?? new Date();
  let base: string;
  if (opts.title && opts.title.trim()) {
    base = slugify(opts.title);
    if (!base) base = timeSlug(date);
  } else {
    // Untitled microblog post: the date lives in the permalink path, so the
    // slug only needs a time-based component plus a short random suffix.
    base = `${timeSlug(date)}-${randomHex(2)}`;
  }
  if (!exists) return base;

  let candidate = base;
  let n = 2;
  while (exists(candidate)) {
    candidate = `${base}-${n}`;
    n++;
    if (n > 1000) {
      candidate = `${base}-${randomHex(6)}`;
      break;
    }
  }
  return candidate;
}

function timeSlug(date: Date): string {
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  const ss = String(date.getUTCSeconds()).padStart(2, "0");
  return `${hh}${mm}${ss}`;
}

/** Date component used for permalink paths: /:year/:month/:day/:slug/ */
export function datePath(date: Date): { year: string; month: string; day: string } {
  return {
    year: String(date.getUTCFullYear()),
    month: String(date.getUTCMonth() + 1).padStart(2, "0"),
    day: String(date.getUTCDate()).padStart(2, "0"),
  };
}

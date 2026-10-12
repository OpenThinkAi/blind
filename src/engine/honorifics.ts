// Honorifics and role words: a title or a job is not part of a person's name, so
// "Dr" in "Dr. A Smith" or "Front Desk" as a speaker never becomes a name part
// that is then pseudonymised everywhere ("Highland Dr." included). The heuristic
// analyst uses it to skip such words and speakers made only of them, and
// partExclusion leaves them out of every spec's name parts, written by hand or not.

const WORDS = [
  // honorifics and titles
  "dr", "doctor", "mr", "mrs", "ms", "miss", "mx", "sir", "madam", "mister", "prof", "professor", "rev", "fr", "hon", "esq", "jr", "sr",
  // roles and desks
  "front", "desk", "reception", "receptionist", "nurse", "vet", "veterinarian", "tech", "technician", "assistant", "manager", "owner",
  "client", "patient", "staff", "admin", "office", "billing", "support", "operator", "agent", "unknown", "speaker", "guest", "caller",
];

const SET: ReadonlySet<string> = new Set(WORDS);

const strip = (w: string): string => w.normalize("NFKC").toLowerCase().replace(/[.,]+$/u, "");

/** A title or a role word ("Dr", "dr.", "Front"), not a name. */
export function isHonorificOrRole(word: string): boolean {
  return SET.has(strip(word));
}

/** A name whose every word is an honorific or role word ("Front Desk", "Dr."); false for an empty name. */
export function isOnlyHonorificsOrRoles(name: string): boolean {
  const words = name.split(/[\s,]+/).filter((w) => w !== "");
  return words.length > 0 && words.every(isHonorificOrRole);
}

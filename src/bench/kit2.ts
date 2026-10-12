// Kit v2: the files kit v1 does not have, each built around a shape that broke
// document blinding before. Generated in code from the same invented cast as
// kit v1 (src/bench/synth.ts), with a PRNG stream of its own so kit v1's files
// are byte-identical inside kit v2.
//
// - workbooks/tenant-access.xlsx: a Contents sheet that names the other sheets
//   (one is named after an organisation) with hyperlinks to them, identity
//   columns, an organisation column under a header no rule names, a `Path`
//   column of the vendor's service-account home directories, a shared string no
//   cell uses that holds an IP address, a pivot cache over the people and
//   organisations, a defined name and document metadata.
// - meetings/renewal-call.docx and .vtt: one Teams meeting, saved as Word
//   (speaker-and-time paragraphs, names split across runs) and as WebVTT (cue
//   GUIDs, voice tags).
//   The meeting also has a phone number spelled out digit by digit, an email
//   address spoken word by word, and number words in ordinary prose (a decoy).
// - exports/scopes.json: a scope list with snake_case keys, hex IDs and
//   four-digit IDs written as strings.
// - logs/agent-container.log: a container log whose registry host carries the
//   cloud account ID as its first label, which is also cited on its own.

import type { ColumnRule, Spec } from "../schema.ts";
import { buildDocument, buildWorkbook, type WbCell, type WbSheet } from "./office.ts";
import { type CastOrg, type CastPerson, emailOf, mention, type OracleBuilder, orgMention, ORGS, PEOPLE, Rng, tenantHost } from "./cast.ts";
import type { Decoy, KitFile, OracleColumn } from "./synth.ts";

export const ACCESS_XLSX = "workbooks/tenant-access.xlsx";
export const CALL_DOCX = "meetings/renewal-call.docx";
export const CALL_VTT = "meetings/renewal-call.vtt";
export const SCOPES_JSON = "exports/scopes.json";
export const CONTAINER_LOG = "logs/agent-container.log";

export const CONTENTS_SHEET = "Contents";
export const ACCESS_SHEET = "Access";

/** The cloud vendor whose registry hosts carry the customer's account ID (`<account>.dkr.registry.<vendor>`). */
export const CLOUD_DOMAIN = "registry.cloudvendor.example";

/** Mixed into the seed for the v2 stream, so v2 draws never move a v1 value. */
const V2_STREAM = 0x5bd1e995;

const pad2 = (n: number): string => String(n).padStart(2, "0");
const HEX = "0123456789abcdef";

const ACCESS_COLUMNS = [
  { header: "User", class: "person", note: "account holder" },
  { header: "Booked Under", class: "org", note: "organisation names under a header no rule names" },
  { header: "Email", class: "email", note: "work email" },
  { header: "Employee No", class: "id", note: "short ID: 4 digits, number cells" },
  { header: "Path", class: "id", note: "the vendor's service-account home directory, named after the customer" },
  { header: "Role", class: "vocabulary", note: "role enum" },
  { header: "Last Login", class: "vocabulary", note: "ISO date" },
] as const;

const SCOPE_KEYS = [
  { path: "$.export_kind", class: "vocabulary", note: "fixed label" },
  { path: "$.generated_by", class: "email", note: "who exported the list" },
  { path: "$.scopes[*].scope_id", class: "id", note: "hex ID: 8 characters" },
  { path: "$.scopes[*].account_no", class: "id", note: "short ID: 4 digits, written as a string" },
  { path: "$.scopes[*].org_name", class: "org", note: "organisation names" },
  { path: "$.scopes[*].owner_email", class: "email", note: "work email" },
  { path: "$.scopes[*].tenant_host", class: "host", note: "vendor-hosted tenant host" },
  { path: "$.scopes[*].access_level", class: "vocabulary", note: "access enum" },
  { path: "$.scopes[*].granted_on", class: "vocabulary", note: "ISO date" },
] as const;

/** A phone number read out digit by digit (555-01xx: reserved for fiction), and its digits. */
export const SPOKEN_PHONE = "eight oh one, five five five, zero one four two";
export const SPOKEN_PHONE_DIGITS = "8015550142";
/** Number words in ordinary prose in the meeting. A decoy: it must survive blinding. */
export const SPOKEN_DECOY = "two dogs, one cat";

/** Speakers of the meeting. Sam and Jan stay out: their given names are kit v1's decoys. */
const SPEAKERS: readonly CastPerson[] = PEOPLE.filter((p) => p.given !== "Sam" && p.given !== "Jan");
const OPENERS = ["Thanks", "Right", "Okay", "Good point", "Agreed"] as const;

export interface KitV2 {
  files: KitFile[];
  columns: OracleColumn[];
  /** The organisation the third worksheet is named after. */
  sheetOrg: CastOrg;
  /** The cloud account IDs in the container log. */
  cloudAccounts: string[];
  /** Words that look like values but are not; they must survive blinding. */
  decoys: Decoy[];
}

/** One meeting turn: who speaks and what they say. */
interface Turn {
  speaker: CastPerson;
  text: string;
}

export function generateV2(seed: number, rows: number, oracle: OracleBuilder): KitV2 {
  const rng = new Rng((seed ^ V2_STREAM) >>> 0);
  const files: KitFile[] = [];
  const add = oracle.add.bind(oracle);
  const date = () => `2026-${pad2(rng.int(1, 9))}-${pad2(rng.int(1, 28))}`;
  const hex = (n: number) => {
    for (;;) {
      const s = Array.from({ length: n }, () => HEX[rng.int(0, 15)]).join("");
      if (/[0-9]/.test(s) && /[a-f]/.test(s)) return s;
    }
  };

  // ---------------------------------------------------------- the workbook
  // Four-digit IDs are drawn from 1000-1999: kit v1's account numbers are 3000-9999 and every date
  // starts 2026, so no ID is ever a token of another value.
  const users = Math.max(8, Math.floor(rows / 3));
  const ids = rng.distinct(users * 2, () => String(rng.int(1000, 1999)));
  const sheetOrg = rng.pick(ORGS);
  const access: WbCell[][] = [ACCESS_COLUMNS.map((c) => c.header)];
  const where = (h: string) => `sheet ${ACCESS_SHEET}, column ${h}`;
  const pivotUsers: string[] = [];
  const pivotOrgs: string[] = [];
  const records: number[][] = [];
  for (let i = 0; i < users; i++) {
    const p = i < PEOPLE.length ? (PEOPLE[i] as CastPerson) : rng.pick(PEOPLE);
    const o = i < ORGS.length ? (ORGS[i] as CastOrg) : rng.pick(ORGS);
    const emp = ids[i] as string;
    const path = `/var/lib/tenanthub/home/svc-${o.slug}-${rng.pick(["sync", "export", "audit"])}`;
    access.push([p.canonical, o.canonical, emailOf(p, o), Number(emp), path, rng.pick(["admin", "reader", "auditor"]), date()]);
    add(p.canonical, "person", p.canonical, "canonical", ACCESS_XLSX, where("User"));
    add(o.canonical, "org", o.canonical, "canonical", ACCESS_XLSX, where("Booked Under"));
    add(emailOf(p, o), "email", emailOf(p, o), "value", ACCESS_XLSX, where("Email"));
    add(emp, "id", emp, "value", ACCESS_XLSX, where("Employee No"));
    add(path, "id", path, "value", ACCESS_XLSX, where("Path"));
    if (!pivotUsers.includes(p.canonical)) pivotUsers.push(p.canonical);
    if (!pivotOrgs.includes(o.canonical)) pivotOrgs.push(o.canonical);
    records.push([pivotUsers.indexOf(p.canonical), pivotOrgs.indexOf(o.canonical)]);
    add(p.canonical, "person", p.canonical, "canonical", ACCESS_XLSX, "pivot cache");
    add(o.canonical, "org", o.canonical, "canonical", ACCESS_XLSX, "pivot cache");
  }
  const keeper = rng.pick(PEOPLE);
  const contents: WbCell[][] = [
    ["Sheet", "Description"],
    [ACCESS_SHEET, `Who can reach each tenant, kept by ${keeper.canonical}`],
    [sheetOrg.short, `Renewal figures for ${sheetOrg.canonical}`],
  ];
  add(keeper.canonical, "person", keeper.canonical, "canonical", ACCESS_XLSX, `sheet ${CONTENTS_SHEET}`);
  add(sheetOrg.canonical, "org", sheetOrg.canonical, "canonical", ACCESS_XLSX, `sheet ${CONTENTS_SHEET}`);
  add(sheetOrg.short, "org", sheetOrg.canonical, "part", ACCESS_XLSX, `sheet ${CONTENTS_SHEET}`);
  for (const w of ["sheet name", "hyperlink", "defined name", "docProps/app.xml"]) add(sheetOrg.short, "org", sheetOrg.canonical, "part", ACCESS_XLSX, w);
  const renewal: WbCell[][] = [["Quarter", "Amount"], ...[1, 2, 3, 4].map((q) => [`Q${q}`, rng.int(100, 999) + rng.int(0, 9) / 10])];
  const ip = `${rng.pick(["192.0.2", "198.51.100", "203.0.113"])}.${rng.int(1, 254)}`;
  add(ip, "host", ip, "value", ACCESS_XLSX, "orphaned shared string");
  const creator = rng.pick(PEOPLE);
  const editor = rng.pick(PEOPLE.filter((p) => p !== creator));
  const editorAlias = rng.pick(editor.aliases);
  add(creator.canonical, "person", creator.canonical, "canonical", ACCESS_XLSX, "docProps/core.xml");
  add(editorAlias, "person", editor.canonical, "alias", ACCESS_XLSX, "docProps/core.xml");
  const sheets: WbSheet[] = [
    {
      name: CONTENTS_SHEET,
      rows: contents,
      hyperlinks: [
        { ref: "A2", location: `'${ACCESS_SHEET}'!A1`, display: ACCESS_SHEET },
        { ref: "A3", location: `'${sheetOrg.short}'!A1`, display: sheetOrg.short },
      ],
    },
    { name: ACCESS_SHEET, rows: access },
    { name: sheetOrg.short, rows: renewal },
  ];
  files.push({
    path: ACCESS_XLSX,
    bytes: buildWorkbook({
      sheets,
      orphans: [`Old jump host ${ip}, retired`],
      definedNames: [{ name: `${sheetOrg.short}_Total`, formula: `'${sheetOrg.short}'!$B$2:$B$5` }],
      pivot: { sheet: ACCESS_SHEET, ref: `A1:B${users + 1}`, fields: [{ name: "User", items: pivotUsers }, { name: "Booked Under", items: pivotOrgs }], records },
      core: { title: "Tenant access review", creator: creator.canonical, modifiedBy: editorAlias },
    }),
  });

  // ---------------------------------------------------------- the meeting, as Word and as WebVTT
  const turns: Turn[] = [];
  for (let i = 0; i < Math.max(12, Math.floor(rows / 4)); i++) {
    const speaker = SPEAKERS[i % SPEAKERS.length] as CastPerson;
    const about = rng.pick(PEOPLE.filter((p) => p !== speaker));
    const org = rng.pick(ORGS);
    const opener = rng.pick(OPENERS);
    const t = rng.int(0, 2);
    // Both files hold the same words, so each mention is recorded for both.
    const who = mention(rng, about, oracle, CALL_DOCX, "transcript turn");
    const firm = orgMention(rng, org, oracle, CALL_DOCX, "transcript turn");
    oracle.add(who, "person", about.canonical, who === about.canonical ? "canonical" : about.aliases.includes(who) ? "alias" : "part", CALL_VTT, "transcript turn");
    oracle.add(firm, "org", org.canonical, firm === org.canonical ? "canonical" : firm === org.acronym ? "alias" : "part", CALL_VTT, "transcript turn");
    const text =
      t === 0 ? `${opener} ${who}, can you send the ${firm} renewal figures?` : t === 1 ? `${opener}, ${who} says ${firm} wants the export by Friday.` : `${opener} ${who}, the ${firm} tenant is still on the old plan.`;
    turns.push({ speaker, text });
    add(speaker.canonical, "person", speaker.canonical, "canonical", CALL_DOCX, "speaker");
    add(speaker.canonical, "person", speaker.canonical, "canonical", CALL_VTT, "speaker");
  }
  // Values read aloud (AGT-1829): a phone number spelled digit by digit and an email address spoken
  // word by word, which no written shape matches, and number words in ordinary prose, which must
  // survive. Fixed text, no PRNG draws, so every other value in the kit stays where it was.
  const [caller, mailer] = [SPEAKERS[0] as CastPerson, SPEAKERS[1] as CastPerson];
  const mailOrg = ORGS[0] as CastOrg;
  const spokenEmail = emailOf(caller, mailOrg).replace("@", " at ").replaceAll(".", " dot ");
  turns.push({ speaker: caller, text: `If the line drops, my cell is ${SPOKEN_PHONE}.` });
  turns.push({ speaker: mailer, text: `Send the signed copy to ${spokenEmail} and I will file it.` });
  turns.push({ speaker: caller, text: `Sure. No rush, I have ${SPOKEN_DECOY} at home and a train to catch.` });
  for (const f of [CALL_DOCX, CALL_VTT]) {
    oracle.add(SPOKEN_PHONE, "id", SPOKEN_PHONE_DIGITS, "alias", f, "spelled digits");
    oracle.add(spokenEmail, "email", emailOf(caller, mailOrg), "alias", f, "spoken email");
  }
  for (const p of [caller, mailer]) for (const f of [CALL_DOCX, CALL_VTT]) add(p.canonical, "person", p.canonical, "canonical", f, "speaker");
  const clock = (i: number) => `${Math.floor((i * 17) / 60)}:${pad2((i * 17) % 60)}`;
  const paragraphs: (string | null)[][] = [["Renewal call"]];
  turns.forEach((t, i) => {
    const head = `${t.speaker.canonical}   ${clock(i)}`;
    // Odd turns split the speaker's name across two runs, as Word does after an edit.
    paragraphs.push(i % 2 === 1 ? [head.slice(0, 4), head.slice(4)] : [head]);
    paragraphs.push([t.text]);
  });
  const host = SPEAKERS[0] as CastPerson;
  add(host.canonical, "person", host.canonical, "canonical", CALL_DOCX, "docProps/core.xml");
  files.push({ path: CALL_DOCX, bytes: buildDocument(paragraphs, { title: "Renewal call", creator: host.canonical, modifiedBy: host.canonical }) });
  const guid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}`;
  const cueIds = Array.from({ length: 4 }, guid);
  const ts = (s: number) => `00:${pad2(Math.floor(s / 60))}:${pad2(s % 60)}.000`;
  const cues = turns.map((t, i) => `${cueIds[i % cueIds.length]}/${i + 10}-0\n${ts(i * 17)} --> ${ts(i * 17 + 15)}\n<v ${t.speaker.canonical}>${t.text}</v>`);
  files.push({ path: CALL_VTT, text: `WEBVTT\n\n${cues.join("\n\n")}\n` });

  // ---------------------------------------------------------- the JSON scope list
  const exporter = rng.pick(PEOPLE);
  const exporterOrg = rng.pick(ORGS);
  const scopeIds = rng.distinct(Math.max(8, Math.floor(rows / 4)), () => hex(8));
  const scopes = scopeIds.map((id, i) => {
    const p = rng.pick(PEOPLE);
    const o = rng.pick(ORGS);
    const acct = ids[users + i] as string;
    const at = (k: string) => `key path $.scopes[*].${k}`;
    add(id, "id", id, "value", SCOPES_JSON, at("scope_id"));
    add(acct, "id", acct, "value", SCOPES_JSON, at("account_no"));
    add(o.canonical, "org", o.canonical, "canonical", SCOPES_JSON, at("org_name"));
    add(emailOf(p, o), "email", emailOf(p, o), "value", SCOPES_JSON, at("owner_email"));
    add(tenantHost(o), "host", tenantHost(o), "value", SCOPES_JSON, at("tenant_host"));
    return {
      scope_id: id,
      account_no: acct,
      org_name: o.canonical,
      owner_email: emailOf(p, o),
      tenant_host: tenantHost(o),
      access_level: rng.pick(["read", "write", "admin"]),
      granted_on: date(),
    };
  });
  add(emailOf(exporter, exporterOrg), "email", emailOf(exporter, exporterOrg), "value", SCOPES_JSON, "key path $.generated_by");
  files.push({ path: SCOPES_JSON, text: `${JSON.stringify({ export_kind: "scope_list", generated_by: emailOf(exporter, exporterOrg), scopes }, null, 2)}\n` });

  // ---------------------------------------------------------- the container log
  const account = `${rng.int(1, 9)}${Array.from({ length: 11 }, () => rng.int(0, 9)).join("")}`;
  const registry = `${account}.dkr.${CLOUD_DOMAIN}`;
  const peers = rng.distinct(3, () => `${rng.pick(["192.0.2", "198.51.100", "203.0.113"])}.${rng.int(1, 254)}`);
  const log: string[] = [];
  const stamp = (i: number) => `2026-10-0${1 + (i % 9)}T${pad2(rng.int(0, 23))}:${pad2(rng.int(0, 59))}:${pad2(rng.int(0, 59))}Z`;
  for (let i = 0; i < Math.max(10, Math.floor(rows / 5)); i++) {
    const pid = rng.int(10, 99);
    const kind = i < 2 ? i : rng.int(0, 2);
    if (kind === 0) {
      log.push(`${stamp(i)} agent[${pid}] pull ${registry}/sync-agent:1.4.${rng.int(0, 9)} ok`);
      add(registry, "host", registry, "value", CONTAINER_LOG, "registry host");
      add(account, "id", account, "value", CONTAINER_LOG, "registry host label");
    } else if (kind === 1) {
      log.push(`${stamp(i)} agent[${pid}] assumed role sync-reader in account ${account}`);
      add(account, "id", account, "value", CONTAINER_LOG, "log line");
    } else {
      const o = rng.pick(ORGS);
      const peer = rng.pick(peers);
      log.push(`${stamp(i)} agent[${pid}] tenant=${tenantHost(o)} peer=${peer} sync ok`);
      add(tenantHost(o), "host", tenantHost(o), "value", CONTAINER_LOG, "log line");
      add(peer, "host", peer, "value", CONTAINER_LOG, "log line");
    }
  }
  files.push({ path: CONTAINER_LOG, text: `${log.join("\n")}\n` });

  const columns: OracleColumn[] = [
    { file: ACCESS_XLSX, sheet: CONTENTS_SHEET, header: "Sheet", class: "org", note: "the sheet list; one sheet is named after an organisation" },
    { file: ACCESS_XLSX, sheet: CONTENTS_SHEET, header: "Description", class: "vocabulary", note: "free text that names people and organisations" },
    ...ACCESS_COLUMNS.map((c) => ({ file: ACCESS_XLSX, sheet: ACCESS_SHEET, header: c.header, class: c.class, note: c.note })),
    { file: ACCESS_XLSX, sheet: sheetOrg.short, header: "Quarter", class: "vocabulary", note: "quarter label" },
    { file: ACCESS_XLSX, sheet: sheetOrg.short, header: "Amount", class: "vocabulary", note: "money" },
    ...SCOPE_KEYS.map((k) => ({ file: SCOPES_JSON, jsonPath: k.path, class: k.class, note: k.note })),
  ];
  const decoys: Decoy[] = [{ text: SPOKEN_DECOY, resembles: "spelled digits", why: "number words in ordinary prose, not a value read aloud", files: [CALL_DOCX, CALL_VTT] }];
  return { files, columns, sheetOrg, cloudAccounts: [account], decoys };
}

/**
 * The reviewed spec for kit v2: kit v1's spec, plus a rule for every worksheet column and JSON key
 * path, and the cloud account IDs as `id` entities. The Contents sheet's two columns are declared
 * unknowns: a reviewer cannot keep them (they name people and organisations) and must not blind the
 * sheet list away.
 */
export function kitSpecV2(base: Spec, v2: KitV2): Spec {
  const rule = (loc: { file: string; sheet?: string; header?: string; jsonPath?: string }, cls: string): ColumnRule => {
    const where = loc.jsonPath === undefined ? { file: loc.file, sheet: loc.sheet as string, header: loc.header as string } : { file: loc.file, jsonPath: loc.jsonPath };
    return cls === "vocabulary"
      ? { ...where, class: "vocabulary", treatment: "keep", confidence: 1, source: "human" }
      : { ...where, class: cls as ColumnRule["class"], treatment: "blind", confidence: 1, source: "human" };
  };
  const columns: ColumnRule[] = v2.columns.map((c) =>
    c.sheet === CONTENTS_SHEET ? { file: c.file, sheet: c.sheet, header: c.header as string, class: "unknown", treatment: "value", confidence: 0, source: "human" } : rule(c, c.class),
  );
  return {
    ...base,
    columns: [...base.columns, ...columns],
    entities: { ...base.entities, id: v2.cloudAccounts.map((a) => ({ canonical: a, aliases: [], parts: [] })) },
  };
}

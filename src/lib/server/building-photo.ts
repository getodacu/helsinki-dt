import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Building } from "../types.ts";
import { validBuildingPhoto, type BuildingPhoto } from "../building-photo.ts";
import { requestBytes, requestText, type RequestOptions } from "./io.ts";

type FetchText = (url: string, options: RequestOptions) => Promise<{ body: string }>;
type Binding = { item?: { value?: string }; image?: { value?: string }; vtj?: { value?: string }; ratu?: { value?: string } };
const DAY = 24 * 3600_000;
const DIRECTORY = resolve(process.env.CITY_MAP_CACHE_DIR || '.cache/city-map', 'building-photos');
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

async function save(path: string, body: string | Buffer) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  try { await writeFile(temporary, body, { flag: 'wx' }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }).catch(() => {}); }
}
const OPTIONS: RequestOptions = { maxBytes: 256 * 1024, timeoutMs: 10_000, redirect: "error",
  headers: { "User-Agent": "HelsinkiLens/0.1 (building photos; https://www.wikidata.org/wiki/Property:P8355)", Accept: "application/json" } };

function plainText(value: unknown): string {
  if (typeof value !== "string") return "";
  const entities: Record<string, string> = { amp: "&", quot: "\"", apos: "\u0027", lt: "<", gt: ">", nbsp: " " };
  return value.replace(/<[^>]*>/g, " ").replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (match, entity: string) => {
    if (!entity.startsWith("#")) return entities[entity.toLowerCase()] ?? match;
    const point = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : "";
  }).replace(/\s+/g, " ").trim();
}

/** Only exact source IDs can attach a photo; conflicting Wikidata items stay unresolved. */
export class BuildingPhotoCache {
  private entries = new Map<string, { photo: BuildingPhoto | null; dueAt: number; pending: Promise<BuildingPhoto | null> | null }>();
  private active = 0;
  private fetchText: FetchText;
  private now: () => number;
  private directory: string;
  constructor(fetchText: FetchText = requestText, now: () => number = Date.now, directory = DIRECTORY) { this.fetchText = fetchText; this.now = now; this.directory = directory; }

  async get(building: Pick<Building, "vtjPrt" | "ratu">): Promise<BuildingPhoto | null> {
    const vtj = building.vtjPrt && /^\d{9}[0-9A-Z]$/.test(building.vtjPrt) ? building.vtjPrt : null;
    const ratu = building.ratu && /^\d{1,10}$/.test(building.ratu) ? building.ratu : null;
    if (!vtj && !ratu) return null;
    const key = JSON.stringify([vtj, ratu]);
    const saved = this.entries.get(key);
    if (saved?.pending) return saved.pending;
    if (saved && this.now() < saved.dueAt) return saved.photo;
    if (this.active >= 2) throw new Error("Building photo lookup is busy");
    if (!saved && this.entries.size >= 512) {
      const oldest = [...this.entries].find(([, entry]) => !entry.pending);
      if (oldest) this.entries.delete(oldest[0]);
    }
    const entry = saved ?? { photo: null, dueAt: 0, pending: null };
    this.entries.set(key, entry);
    this.active++;
    entry.pending = (async () => {
      const path = resolve(this.directory, hash(key) + '.json');
      if (!saved) {
        try {
          if ((await stat(path)).size > 16_384) throw new Error('Oversized photo metadata');
          const record = JSON.parse(await readFile(path, 'utf8'));
          if (record.key !== key || !Number.isFinite(record.retrievedAt) || record.retrievedAt > this.now() + 60_000
            || !(record.photo === null || validBuildingPhoto(record.photo))) throw new Error('Invalid saved photo metadata');
          entry.photo = record.photo; entry.dueAt = record.retrievedAt + DAY;
          if (this.now() < entry.dueAt) return entry.photo;
        } catch { /* Missing or corrupt metadata is refreshed from the source. */ }
      }
      const photo = await this.lookup(vtj, ratu);
      entry.photo = photo; entry.dueAt = this.now() + DAY;
      try {
        await mkdir(this.directory, { recursive: true });
        await save(path, JSON.stringify({ key, retrievedAt: this.now(), photo }));
      } catch { console.warn('Building photo metadata could not be saved. Check cache directory permissions and disk space.'); }
      return photo;
    })().catch(error => {
      console.warn("Building photo lookup failed:", error instanceof Error ? error.message.slice(0, 200) : "Unknown upstream error");
      entry.dueAt = this.now() + 5 * 60_000; return entry.photo;
    }).finally(() => { entry.pending = null; this.active--; });
    return entry.pending;
  }

  private async lookup(vtj: string | null, ratu: string | null): Promise<BuildingPhoto | null> {
    const options = { ...OPTIONS, signal: AbortSignal.timeout(12_000) };
    const matches = [vtj && `{ ?item wdt:P3824 "${vtj}" }`, ratu && `{ ?item wdt:P8355 "${ratu}" }`].filter(Boolean).join(" UNION ");
    const query = `SELECT DISTINCT ?item ?image ?vtj ?ratu WHERE { ${matches} OPTIONAL { ?item wdt:P18 ?image } OPTIONAL { ?item wdt:P3824 ?vtj } OPTIONAL { ?item wdt:P8355 ?ratu } } ORDER BY ?item ?image LIMIT 21`;
    const response = await this.fetchText(`https://query.wikidata.org/sparql?${new URLSearchParams({ query, format: "json" })}`, options);
    const bindings: Binding[] = JSON.parse(response.body)?.results?.bindings;
    if (!Array.isArray(bindings) || bindings.length > 20 || bindings.some(row => !/^http:\/\/www\.wikidata\.org\/entity\/Q\d+$/.test(row.item?.value ?? ""))) throw new Error("Invalid building photo matches");
    if (new Set(bindings.map(row => row.item!.value)).size !== 1) return null;
    for (const [field, expected] of [["vtj", vtj], ["ratu", ratu]] as const) {
      const supplied = bindings.flatMap(row => row[field]?.value ? [row[field]!.value] : []);
      if (expected && supplied.length && !supplied.includes(expected)) return null;
    }
    const image = bindings.find(row => row.image?.value)?.image?.value;
    if (!image || !/^https?:\/\/commons\.wikimedia\.org\/wiki\/Special:FilePath\//.test(image)) return null;
    const filename = decodeURIComponent(new URL(image).pathname.slice("/wiki/Special:FilePath/".length));
    if (!filename || filename.length > 500 || /[|\u0000-\u001f]/.test(filename)) return null;
    const url = `https://commons.wikimedia.org/w/api.php?${new URLSearchParams({ action: "query", format: "json", formatversion: "2", prop: "imageinfo",
      titles: `File:${filename}`, iiprop: "url|extmetadata|mime", iiurlwidth: "960", iiextmetadatalanguage: "en",
      iiextmetadatafilter: "Artist|Attribution|LicenseShortName|LicenseUrl|Restrictions" })}`;
    const commons = JSON.parse((await this.fetchText(url, options)).body);
    const info = commons?.query?.pages?.[0]?.imageinfo?.[0], metadata = info?.extmetadata;
    if (!info || !["image/jpeg", "image/png", "image/webp"].includes(info.mime) || plainText(metadata?.Restrictions?.value)) return null;
    const photo = { url: info.thumburl ?? info.url, pageUrl: info.descriptionurl, title: filename,
      author: plainText(metadata?.Attribution?.value || metadata?.Artist?.value),
      license: plainText(metadata?.LicenseShortName?.value), licenseUrl: metadata?.LicenseUrl?.value };
    // shortcut: CC BY, CC BY-SA and public-domain photos only; expand after supporting other attribution requirements.
    return validBuildingPhoto(photo) ? photo : null;
  }
}

export const buildingPhotoCache = new BuildingPhotoCache();

const IMAGE_MAX_BYTES = 4 * 1024 ** 2;
type FetchImage = (url: string, options: RequestOptions) => Promise<{ body: Buffer }>;

function imageType(body: Buffer): string {
  if (body.length > IMAGE_MAX_BYTES) throw new Error('Building photo exceeds its byte limit');
  if (body.length >= 20 && body.readUInt16BE(0) === 0xffd8 && body.readUInt16BE(body.length - 2) === 0xffd9) return 'image/jpeg';
  if (body.length >= 33 && body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && body.toString('ascii', body.length - 8, body.length - 4) === 'IEND') return 'image/png';
  if (body.length >= 20 && body.toString('ascii', 0, 4) === 'RIFF' && body.toString('ascii', 8, 12) === 'WEBP'
    && body.readUInt32LE(4) + 8 === body.length) return 'image/webp';
  throw new Error('Invalid building photo image');
}

/** Validated photo bytes persist beside their source metadata, independently of the browser cache. */
export class BuildingImageCache {
  private directory: string;
  private fetchImage: FetchImage;
  private active = 0;
  private pending = new Map<string, Promise<{ body: Buffer; type: string; etag: string }>>();
  constructor(directory = DIRECTORY, fetchImage: FetchImage = requestBytes) { this.directory = directory; this.fetchImage = fetchImage; }

  async read(photo: BuildingPhoto) {
    if (!validBuildingPhoto(photo)) throw new Error('Invalid building photo source');
    const key = hash(photo.url), path = resolve(this.directory, key + '.image');
    const pending = this.pending.get(key);
    if (pending) return pending;
    const load = (async () => {
      try {
        if ((await stat(path)).size > IMAGE_MAX_BYTES || (await stat(path + '.sha256')).size !== 64) throw new Error('Invalid cached photo size');
        const body = await readFile(path), checksum = await readFile(path + '.sha256', 'utf8');
        if (checksum !== hash(body)) throw new Error('Corrupt cached photo');
        return { body, type: imageType(body), etag: '"' + checksum + '"' };
      } catch { /* A missing or corrupt image is downloaded and validated before replacement. */ }
      if (this.active >= 2) throw new Error('Building photo downloads are busy');
      this.active++;
      try {
        const { body } = await this.fetchImage(photo.url, { maxBytes: IMAGE_MAX_BYTES, timeoutMs: 15_000, redirect: 'error',
          headers: { 'User-Agent': 'HelsinkiLens/0.1 (building photos; https://www.wikidata.org/wiki/Property:P8355)' } });
        const type = imageType(body), checksum = hash(body);
        try {
          await mkdir(this.directory, { recursive: true });
          await save(path, body); await save(path + '.sha256', checksum);
        } catch { console.warn('Building photo image could not be saved. Check cache directory permissions and disk space.'); }
        return { body, type, etag: '"' + checksum + '"' };
      } finally { this.active--; }
    })().finally(() => { this.pending.delete(key); });
    this.pending.set(key, load);
    return load;
  }
}

export const buildingImageCache = new BuildingImageCache();

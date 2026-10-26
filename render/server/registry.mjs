// Dates are ISO strings (`toString(datetime)`), never driver temporal objects. Queries are index-backed
// and LIMITed; only the publisher leaderboards aggregate a whole relationship type, so the routes cache them.
import neo4j from 'neo4j-driver';

const page = (rows, limit) => {
  const hasMore = rows.length > limit;
  return { rows: hasMore ? rows.slice(0, limit) : rows, hasMore };
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const parseInstant = (value, fallback) => {
  const s = String(value ?? '').trim();
  if (!s) return fallback;
  if (ISO_DATE.test(s)) return `${s}T00:00:00.000Z`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? fallback : d.toISOString();
};

// A plain `to` date is inclusive in the UI, so it becomes the start of the next day.
export const dateRange = (fromValue, toValue, defaultDays = 7) => {
  const now = new Date();
  const toRaw = String(toValue ?? '').trim();
  let to = parseInstant(toRaw, null);
  if (to && ISO_DATE.test(toRaw)) to = new Date(Date.parse(to) + 86_400_000).toISOString();
  if (!to) to = new Date(now.getTime() + 86_400_000).toISOString();
  const from = parseInstant(fromValue, new Date(Date.parse(to) - defaultDays * 86_400_000).toISOString());
  return Date.parse(from) < Date.parse(to) ? { from, to } : { from: to, to: from };
};

// Version coverage is a label scan of every version (seconds), so callers cache it.
export const registryStats = async (read) => {
  const [counts, crates, latest, all] = await Promise.all([
    read(
      `CALL { MATCH (u:User) RETURN count(u) AS users }
       CALL { MATCH (t:Team) RETURN count(t) AS teams }
       CALL { MATCH ()-[r:OWNS]->() RETURN count(r) AS owns }
       CALL { MATCH ()-[p:PUBLISHED]->(:Crate) RETURN count(p) AS cratePublishers }
       CALL { MATCH ()-[p:PUBLISHED]->(:Version) RETURN count(p) AS versionUploads }
       CALL { MATCH (c:Category) RETURN count(c) AS categories }
       CALL { MATCH (k:Keyword) RETURN count(k) AS keywords }
       RETURN users, teams, owns, cratePublishers, versionUploads, categories, keywords`,
    ),
    read(
      `MATCH (c:Crate)
       RETURN count(c) AS crates, count(c.registry_id) AS cratesInRegistry,
              count(CASE WHEN c.trustpub_only THEN 1 END) AS trustpubOnly,
              count(CASE WHEN c.registry_id IS NOT NULL AND NOT EXISTS { (c)<-[:OWNS]-() } THEN 1 END) AS cratesWithoutOwner`,
    ),
    read(
      `MATCH (v:Version) WHERE v.latest = true
       RETURN count(v) AS latestVersions, count(v.meta_registry) AS latestInRegistry,
              count(CASE WHEN v.yanked THEN 1 END) AS latestYanked, max(v.meta_registry) AS dump`,
    ),
    read(
      `MATCH (v:Version)
       RETURN count(v) AS versions, count(v.meta_registry) AS versionsInRegistry,
              count(v.published_at) AS versionsWithDate, count(v.registry_missing) AS versionsMissing,
              count(CASE WHEN v.yanked THEN 1 END) AS yanked`,
    ),
  ]);
  return { ...counts[0], ...crates[0], ...latest[0], ...all[0] };
};

// `STARTS WITH` is case-sensitive and served by idx_user_login, so try the typed, lowercase and capitalised spellings.
export const searchUsers = async (read, q, limit) => {
  const variants = [...new Set([q, q.toLowerCase(), q.toUpperCase(), q.charAt(0).toUpperCase() + q.slice(1)])];
  const [users, teams] = await Promise.all([
    read(
      `MATCH (u:User) WHERE ${variants.map((_, i) => `u.login STARTS WITH $v${i}`).join(' OR ')}
       WITH u, COUNT { (u)-[:PUBLISHED]->(:Crate) } AS crates, COUNT { (u)-[:OWNS]->() } AS owns
       RETURN u.login AS login, u.name AS name, crates, owns
       ORDER BY toLower(u.login) = $lower DESC, crates + owns DESC, size(u.login), u.login LIMIT $limit`,
      { ...Object.fromEntries(variants.map((v, i) => [`v${i}`, v])), lower: q.toLowerCase(), limit: neo4j.int(limit) },
    ),
    read(
      `MATCH (t:Team) WHERE toLower(t.login) CONTAINS $lower
       WITH t, COUNT { (t)-[:OWNS]->() } AS owns
       RETURN t.login AS login, t.name AS name, 0 AS crates, owns ORDER BY owns DESC, t.login LIMIT $limit`,
      { lower: q.toLowerCase(), limit: neo4j.int(Math.min(limit, 10)) },
    ),
  ]);
  return { users, teams };
};

const CRATE_FACTS = `
  OPTIONAL MATCH (c)-[:VERSION_OF]->(lv:Version {latest: true})
  WITH c, rel, head(collect(lv)) AS lv
  RETURN c.name AS name, c.downloads AS downloads, c.num_versions AS numVersions, toString(c.created_at) AS createdAt,
         toString(c.updated_at) AS updatedAt, c.description AS description, c.trustpub_only AS trustpubOnly,
         COUNT { (c)<-[:OWNS]-() } AS owners, COUNT { (c)<-[:PUBLISHED]-() } AS publishers,
         lv.version AS latestVersion, coalesce(lv.yanked, false) AS yanked, lv.unsafe_total AS unsafeTotal,
         coalesce(lv.has_build_script, false) AS hasBuildScript, coalesce(lv.has_native_code, false) AS hasNativeCode,
         coalesce(lv.vendored_native, false) AS vendoredNative, rel`;

const CRATE_LIST_LIMIT = 5000;

export const userProfile = async (read, login) => {
  const [who] = await read(
    `OPTIONAL MATCH (u:User {login: $login})
     OPTIONAL MATCH (t:Team {login: $login})
     WITH coalesce(u, t) AS n
     WHERE n IS NOT NULL
     RETURN labels(n)[0] AS kind, n.id AS id, n.login AS login, n.name AS name, n.gh_id AS ghId, toString(n.created_at) AS createdAt, n.avatar AS avatar`,
    { login },
  );
  if (!who) return null;
  const label = who.kind === 'Team' ? 'Team' : 'User';
  const [published, owned, timeline] = await Promise.all([
    label === 'User'
      ? read(
          `MATCH (u:User {login: $login})-[p:PUBLISHED]->(c:Crate)
           WITH c, {first: toString(p.at), last: toString(p.last), versions: p.versions} AS rel
           ORDER BY c.downloads DESC LIMIT $limit
           ${CRATE_FACTS}`,
          { login, limit: neo4j.int(CRATE_LIST_LIMIT) },
        )
      : [],
    read(
      `MATCH (o:${label} {login: $login})-[r:OWNS]->(c:Crate)
       WITH c, {since: toString(r.since), addedBy: r.added_by} AS rel
       ORDER BY c.downloads DESC LIMIT $limit
       ${CRATE_FACTS}`,
      { login, limit: neo4j.int(CRATE_LIST_LIMIT) },
    ),
    label === 'User'
      ? read(
          `MATCH (:User {login: $login})-[p:PUBLISHED]->(:Version)
           WITH p.at.year AS year, p.at.month AS month, count(*) AS uploads
           RETURN year, month, uploads ORDER BY year, month`,
          { login },
        )
      : [],
  ]);
  const crates = new Map();
  const facts = ({ rel, ...c }) => c;
  for (const row of published) crates.set(row.name, { ...facts(row), published: row.rel, owns: null });
  for (const row of owned) {
    const hit = crates.get(row.name);
    if (hit) hit.owns = row.rel;
    else crates.set(row.name, { ...facts(row), published: null, owns: row.rel });
  }
  const list = [...crates.values()];
  const sum = (xs, f) => xs.reduce((a, x) => a + (f(x) ?? 0), 0);
  const ownedList = list.filter((c) => c.owns);
  const pubList = list.filter((c) => c.published);
  const totals = {
    crates: list.length,
    published: pubList.length,
    uploads: sum(pubList, (c) => c.published.versions),
    owned: ownedList.length,
    ownedDownloads: sum(ownedList, (c) => c.downloads),
    publishedDownloads: sum(pubList, (c) => c.downloads),
    soleOwner: ownedList.filter((c) => c.owners === 1).length,
    unsafe: list.filter((c) => (c.unsafeTotal ?? 0) > 0).length,
    buildScripts: list.filter((c) => c.hasBuildScript).length,
    native: list.filter((c) => c.hasNativeCode).length,
    yanked: list.filter((c) => c.yanked).length,
    withLatest: list.filter((c) => c.latestVersion).length,
    firstUpload: pubList.map((c) => c.published.first).sort()[0] ?? null,
    lastUpload: pubList.map((c) => c.published.last).sort().at(-1) ?? null,
    truncated: published.length >= CRATE_LIST_LIMIT || owned.length >= CRATE_LIST_LIMIT,
  };
  return { ...who, kind: label, crates: list, timeline, totals };
};

const TOP_CRATES_FOR_OWNERS = 5000;

// The prolific boards aggregate every PUBLISHED->Crate edge (355k, ~4 s each); the download boards use the top 5,000 crates (idx_crate_downloads).
export const publisherLeaderboards = async (read, limit = 100) => {
  const prolific = (order) =>
    read(
      `MATCH (u:User)-[p:PUBLISHED]->(:Crate)
       WITH u, count(p) AS crates, sum(p.versions) AS uploads, min(p.at) AS first, max(p.last) AS last
       ORDER BY ${order} DESC, crates DESC LIMIT $limit
       RETURN u.login AS login, u.name AS name, crates, uploads, toString(first) AS first, toString(last) AS last`,
      { limit: neo4j.int(limit) },
    );
  const [byCrates, byUploads, owners, publishers] = await Promise.all([
    prolific('crates'),
    prolific('uploads'),
    read(
      `MATCH (c:Crate) WHERE c.downloads IS NOT NULL
       WITH c ORDER BY c.downloads DESC LIMIT $top
       MATCH (o)-[:OWNS]->(c)
       WITH o, count(c) AS crates, sum(c.downloads) AS downloads, collect(c.name)[0..5] AS sample,
            count(CASE WHEN COUNT { (c)<-[:OWNS]-() } = 1 THEN 1 END) AS sole
       ORDER BY downloads DESC LIMIT $limit
       RETURN labels(o)[0] AS kind, o.login AS login, o.name AS name, crates, sole, downloads, sample`,
      { top: neo4j.int(TOP_CRATES_FOR_OWNERS), limit: neo4j.int(limit) },
    ),
    read(
      `MATCH (c:Crate) WHERE c.downloads IS NOT NULL
       WITH c ORDER BY c.downloads DESC LIMIT $top
       MATCH (u:User)-[p:PUBLISHED]->(c)
       WITH u, count(c) AS crates, sum(p.versions) AS uploads, sum(c.downloads) AS downloads, collect(c.name)[0..5] AS sample
       ORDER BY downloads DESC LIMIT $limit
       RETURN u.login AS login, u.name AS name, crates, uploads, downloads, sample`,
      { top: neo4j.int(TOP_CRATES_FOR_OWNERS), limit: neo4j.int(limit) },
    ),
  ]);
  return { byCrates, byUploads, owners, publishers, topCrates: TOP_CRATES_FOR_OWNERS };
};

export const RELEASE_SOURCES = {
  crates: ['created', 'publisher'],
  versions: ['publisher', 'published_at'],
};

export const RELEASE_SORTS = ['date', 'downloads', 'name'];

const CRATE_RELEASE_ROW = `
  RETURN c.name AS name, null AS version, login, at, c.downloads AS downloads, c.num_versions AS numVersions,
         c.default_version AS defaultVersion, toString(c.created_at) AS createdAt, c.description AS description,
         c.trustpub_only AS trustpubOnly, [(c)<-[:OWNS]-(o) | o.login][0..4] AS owners,
         COUNT { (c)<-[:OWNS]-() } AS ownerCount, COUNT { (c)<-[:PUBLISHED]-() } AS publisherCount, extra`;

const VERSION_RELEASE_ROW = `
  RETURN v.name AS name, v.version AS version, login, at, v.downloads AS downloads, coalesce(v.latest, false) AS latest,
         coalesce(v.yanked, false) AS yanked, v.license AS license, v.crate_size AS crateSize, v.edition AS edition,
         v.rust_version AS rustVersion, v.unsafe_total AS unsafeTotal, coalesce(v.has_build_script, false) AS hasBuildScript,
         coalesce(v.has_native_code, false) AS hasNativeCode, coalesce(v.vendored_native, false) AS vendoredNative, extra`;

// `sort=date` walks the index in order; downloads / name sort the whole range, so the route gives them the long timeout.
// `extra.joined` is true when the crate already existed (a new publisher).
export const releases = async (read, { kind, source, from, to, q, minDownloads, sort, desc, limit, offset }) => {
  const dir = desc ? 'DESC' : 'ASC';
  const params = { from, to, q: q.toLowerCase(), minDownloads: neo4j.int(minDownloads), offset: neo4j.int(offset), limit: neo4j.int(limit + 1) };
  const filters = (nameExpr, dlExpr) => `AND ($q = '' OR toLower(${nameExpr}) CONTAINS $q) AND coalesce(${dlExpr}, 0) >= $minDownloads`;
  let cypher;
  if (kind === 'crates' && source === 'created') {
    const order = { date: 'c.created_at', downloads: 'c.downloads', name: 'c.name' }[sort];
    cypher = `MATCH (c:Crate) WHERE c.created_at >= datetime($from) AND c.created_at < datetime($to) ${filters('c.name', 'c.downloads')}
      WITH c ORDER BY ${order} ${dir}, c.name SKIP $offset LIMIT $limit
      WITH c, null AS login, toString(c.created_at) AS at, {} AS extra
      ${CRATE_RELEASE_ROW}`;
  } else if (kind === 'crates') {
    const order = { date: 'p.at', downloads: 'c.downloads', name: 'c.name' }[sort];
    cypher = `MATCH (u:User)-[p:PUBLISHED]->(c:Crate) WHERE p.at >= datetime($from) AND p.at < datetime($to) ${filters('c.name', 'c.downloads')}
      WITH u, p, c ORDER BY ${order} ${dir}, c.name SKIP $offset LIMIT $limit
      WITH c, u.login AS login, toString(p.at) AS at,
           {uploads: p.versions, last: toString(p.last), joined: p.at > c.created_at + duration({minutes: 1})} AS extra
      ${CRATE_RELEASE_ROW}`;
  } else if (source === 'publisher') {
    const order = { date: 'p.at', downloads: 'v.downloads', name: 'v.name' }[sort];
    cypher = `MATCH (u:User)-[p:PUBLISHED]->(v:Version) WHERE p.at >= datetime($from) AND p.at < datetime($to) ${filters('v.name', 'v.downloads')}
      WITH u, p, v ORDER BY ${order} ${dir}, v.name, v.version SKIP $offset LIMIT $limit
      WITH v, u.login AS login, toString(p.at) AS at, {} AS extra
      ${VERSION_RELEASE_ROW}`;
  } else {
    const order = { date: 'v.published_at', downloads: 'v.downloads', name: 'v.name' }[sort];
    cypher = `MATCH (v:Version) WHERE v.published_at >= datetime($from) AND v.published_at < datetime($to) ${filters('v.name', 'v.downloads')}
      WITH v ORDER BY ${order} ${dir}, v.name, v.version SKIP $offset LIMIT $limit
      OPTIONAL MATCH (v)<-[:PUBLISHED]-(u:User)
      WITH v, head(collect(u.login)) AS login, toString(v.published_at) AS at, {} AS extra
      ${VERSION_RELEASE_ROW}`;
  }
  const rows = await read(cypher, params);
  return page(rows, limit);
};

// Scans the whole range, so the route caches it per range.
export const releasesHistogram = async (read, { kind, source, from, to }) => {
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  const unit = days <= 92 ? 'day' : 'month';
  const match =
    kind === 'crates' && source === 'created'
      ? `MATCH (c:Crate) WHERE c.created_at >= datetime($from) AND c.created_at < datetime($to) WITH c.created_at AS at`
      : kind === 'crates'
        ? `MATCH (:User)-[p:PUBLISHED]->(:Crate) WHERE p.at >= datetime($from) AND p.at < datetime($to) WITH p.at AS at`
        : source === 'publisher'
          ? `MATCH (:User)-[p:PUBLISHED]->(:Version) WHERE p.at >= datetime($from) AND p.at < datetime($to) WITH p.at AS at`
          : `MATCH (v:Version) WHERE v.published_at >= datetime($from) AND v.published_at < datetime($to) WITH v.published_at AS at`;
  const buckets = await read(`${match} WITH date.truncate($unit, at) AS bucket, count(*) AS n RETURN toString(bucket) AS bucket, n ORDER BY bucket`, {
    from,
    to,
    unit,
  });
  return { kind, source, from, to, unit, buckets, total: buckets.reduce((a, b) => a + b.n, 0) };
};

const TOP_CRATES = `MATCH (c:Crate) WHERE c.downloads IS NOT NULL WITH c ORDER BY c.downloads DESC LIMIT $top`;

// `degree` comes from the Map precompute when it exists; counting DEPENDS_ON edges live would scan millions.
export const busFactor = async (read, { top, limit, offset }) => {
  const rows = await read(
    `${TOP_CRATES}
     WHERE COUNT { (c)<-[:OWNS]-() } = 1 AND NOT EXISTS { (c)<-[:OWNS]-(:Team) }
     MATCH (u:User)-[r:OWNS]->(c)
     WITH c, u, r ORDER BY c.downloads DESC SKIP $offset LIMIT $limit
     OPTIONAL MATCH (c)-[:VERSION_OF]->(lv:Version {latest: true})
     WITH c, u, r, head(collect(lv)) AS lv
     RETURN c.name AS name, c.downloads AS downloads, c.num_versions AS numVersions, toString(c.updated_at) AS updatedAt,
            c.lod_degree AS degree, c.trustpub_only AS trustpubOnly, c.repository AS repository,
            u.login AS login, u.name AS ownerName, toString(r.since) AS since, r.added_by AS addedBy,
            COUNT { (u)-[:OWNS]->() } AS ownerCrates, COUNT { (c)<-[:PUBLISHED]-() } AS publishers,
            lv.version AS latestVersion, coalesce(lv.yanked, false) AS yanked, toString(lv.published_at) AS latestAt`,
    { top: neo4j.int(top), offset: neo4j.int(offset), limit: neo4j.int(limit + 1) },
  );
  return page(rows, limit);
};

export const ownerAdditions = async (read, { since, minDownloads, self, limit, offset }) => {
  const rows = await read(
    `MATCH (o)-[r:OWNS]->(c:Crate)
     WHERE r.since >= datetime($since) AND coalesce(c.downloads, 0) >= $minDownloads
       AND ($self OR r.added_by IS NULL OR r.added_by <> o.login)
     WITH o, r, c ORDER BY c.downloads DESC, r.since DESC SKIP $offset LIMIT $limit
     RETURN c.name AS name, c.downloads AS downloads, c.num_versions AS numVersions, toString(c.created_at) AS createdAt,
            labels(o)[0] AS kind, o.login AS login, o.name AS ownerName, r.added_by AS addedBy, toString(r.since) AS since,
            COUNT { (c)<-[:OWNS]-() } AS owners, EXISTS { (o)-[:PUBLISHED]->(c) } AS hasPublished,
            CASE WHEN o:User THEN COUNT { (o)-[:PUBLISHED]->(:Crate) } ELSE null END AS ownerPublished,
            CASE WHEN o:User THEN toString(o.created_at) ELSE null END AS ownerCreatedAt`,
    { since, minDownloads: neo4j.int(minDownloads), self: self === 'include', offset: neo4j.int(offset), limit: neo4j.int(limit + 1) },
  );
  return page(rows, limit);
};

export const newUploaders = async (read, { top, limit, offset }) => {
  const rows = await read(
    `${TOP_CRATES}
     WHERE c.num_versions > 1
     MATCH (c)-[:VERSION_OF]->(v:Version {latest: true})<-[pv:PUBLISHED]-(u:User)-[pc:PUBLISHED]->(c)
     WHERE pc.versions = 1
     WITH c, v, u, pv ORDER BY c.downloads DESC SKIP $offset LIMIT $limit
     RETURN c.name AS name, c.downloads AS downloads, c.num_versions AS numVersions, v.version AS version,
            coalesce(v.yanked, false) AS yanked, toString(pv.at) AS at, u.login AS login, u.name AS uploaderName,
            toString(u.created_at) AS uploaderCreatedAt, EXISTS { (u)-[:OWNS]->(c) } AS owner,
            COUNT { (c)<-[:PUBLISHED]-() } AS publishers, COUNT { (u)-[:PUBLISHED]->(:Crate) } AS uploaderCrates,
            [(c)<-[:OWNS]-(o) | o.login][0..4] AS owners`,
    { top: neo4j.int(top), offset: neo4j.int(offset), limit: neo4j.int(limit + 1) },
  );
  return page(rows, limit);
};

export const crateRegistry = async (read, name) => {
  const [row] = await read(
    `MATCH (c:Crate {name: $name})
     OPTIONAL MATCH (c)<-[o:OWNS]-(ow)
     WITH c, collect({kind: labels(ow)[0], login: ow.login, name: ow.name, since: toString(o.since), addedBy: o.added_by}) AS owners
     OPTIONAL MATCH (c)<-[p:PUBLISHED]-(u:User)
     WITH c, owners, collect({login: u.login, name: u.name, first: toString(p.at), last: toString(p.last), versions: p.versions}) AS publishers
     RETURN c.name AS name, c.registry_id IS NOT NULL AS inRegistry,
            [x IN owners WHERE x.login IS NOT NULL] AS owners,
            [x IN publishers WHERE x.login IS NOT NULL] AS publishers,
            [(c)-[:IN_CATEGORY]->(k) | {slug: k.slug, name: k.name, crates: k.crates}] AS categories,
            [(c)-[:HAS_KEYWORD]->(k) | k.name] AS keywords`,
    { name },
  );
  if (!row) return null;
  row.owners.sort((a, b) => (a.since ?? '').localeCompare(b.since ?? ''));
  row.publishers.sort((a, b) => b.versions - a.versions || a.login.localeCompare(b.login));
  return row;
};

export const versionPublisher = async (read, { crate, version }) => {
  const [row] = await read(
    `MATCH (:Crate {name: $crate})-[:VERSION_OF]->(v:Version {version: $version})
     OPTIONAL MATCH (v)<-[p:PUBLISHED]-(u:User)
     RETURN v.name AS name, v.version AS version, u.login AS login, u.name AS publisherName, toString(p.at) AS at,
            toString(v.published_at) AS publishedAt, v.meta_registry IS NOT NULL AS inRegistry`,
    { crate, version },
  );
  return row ?? null;
};

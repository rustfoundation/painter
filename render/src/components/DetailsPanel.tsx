import { useEffect, useState } from 'react';
import { api, type CrateRegistry, type ExpandType, type GraphNode, type GraphRel, type OverviewPart, type VersionPublisher, type View } from '../api';
import { isCrate, isTeam, isUser, isVersion, nodeTitle, relTitle } from '../graph';
import { ROLE_COLORS } from '../overview';
import { fmtBytes, fmtCompact, fmtDate, fmtDateTime, UserLink } from './meta';

interface Props {
  view: View;
  selected: GraphNode | GraphRel | null;
  nodeById: (id: string) => GraphNode | undefined;
  onExpand: (id: string, direction: 'in' | 'out' | 'both', types: ExpandType[]) => void;
  /** Default view: add one bounded part of a crate (or of one of its versions) to the canvas. */
  onOverview?: (name: string, part: OverviewPart, opts?: { version?: string }) => void;
  /** Default view: how many versions / dependents of a crate are already drawn. */
  shownCount?: (name: string, part: OverviewPart) => number;
  onRemove: (id: string) => void;
  onLoadCrate: (name: string) => void;
  onOpenUser: (login: string) => void;
  busy: boolean;
}

const isRel = (x: GraphNode | GraphRel): x is GraphRel => 'from' in x && 'to' in x;

const fmt = (v: unknown): string => {
  if (v === null || v === undefined) return '—';
  if (Array.isArray(v)) return v.length ? v.map(fmt).join(', ') : '[]';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};

const UNSAFE_CATEGORIES: { key: string; label: string; color: string }[] = [
  { key: 'functions', label: 'unsafe fns', color: '#E5484D' },
  { key: 'exprs', label: 'unsafe exprs', color: '#F5A623' },
  { key: 'impls', label: 'unsafe impls', color: '#B88BFF' },
  { key: 'traits', label: 'unsafe traits', color: '#4C8DFF' },
  { key: 'methods', label: 'unsafe methods', color: '#2BB673' },
];

function UnsafeSummary({ p }: { p: Record<string, unknown> }) {
  const num = (k: string) => (typeof p[k] === 'number' ? (p[k] as number) : null);
  if (!p.unsafe_scanner) {
    return (
      <>
        <h3>Unsafe</h3>
        <p className="muted">Not scanned yet (run painter count-unsafe).</p>
      </>
    );
  }
  if (p.unsafe_error) {
    return (
      <>
        <h3>Unsafe</h3>
        <p className="muted">Could not scan: {String(p.unsafe_error)}</p>
      </>
    );
  }
  const total = num('unsafe_total') ?? 0;
  const lines = num('rs_lines') ?? 0;
  const exprs = num('unsafe_exprs') ?? 0;
  return (
    <>
      <h3>
        Unsafe <span className={`unsafe-total ${total ? 'hot' : ''}`}>{total.toLocaleString()}</span>
      </h3>
      <div className="unsafe-flags">
        {p.forbids_unsafe === true && (
          <span className="flag forbid" title="Crate root has #![forbid(unsafe_code)]">
            forbid(unsafe_code)
          </span>
        )}
        {p.has_build_script === true && (
          <span className="flag build" title="Has a build script">
            build.rs
          </span>
        )}
        {num('rs_files_failed') ? (
          <span className="flag failed" title="Files that could not be parsed and are not counted">
            {num('rs_files_failed')} unparsed
          </span>
        ) : null}
      </div>
      <table className="props unsafe-cats">
        <tbody>
          {UNSAFE_CATEGORIES.map((c) => {
            const u = num(`unsafe_${c.key}`) ?? 0;
            const s = num(`safe_${c.key}`) ?? 0;
            return (
              <tr key={c.key}>
                <th>
                  <span className="swatch" style={{ background: c.color }} /> {c.label}
                </th>
                <td>
                  <b className={u ? '' : 'muted'}>{u.toLocaleString()}</b>
                  <span className="muted"> / {(u + s).toLocaleString()}</span>
                  <span className="meter inline">
                    <span style={{ width: u + s ? `${(100 * u) / (u + s)}%` : 0, background: c.color }} />
                  </span>
                </td>
              </tr>
            );
          })}
          <tr>
            <th>source</th>
            <td>
              {(num('rs_files') ?? 0).toLocaleString()} files · {lines.toLocaleString()} lines
              {lines ? ` · ${((1000 * exprs) / lines).toFixed(1)} unsafe exprs / kloc` : ''}
            </td>
          </tr>
          <tr>
            <th>scanned</th>
            <td className="muted">
              {String(p.unsafe_scanner)}
              {p.unsafe_scanned_at ? `, ${new Date(String(p.unsafe_scanned_at)).toLocaleString()}` : ''}
            </td>
          </tr>
        </tbody>
      </table>
    </>
  );
}

const numOf = (p: Record<string, unknown>, k: string) => (typeof p[k] === 'number' ? (p[k] as number) : null);
const n = (v: number | null) => (v === null ? '—' : v.toLocaleString());

function BuildSummary({ p }: { p: Record<string, unknown> }) {
  if (!p.meta_build) {
    return (
      <>
        <h3>Build script</h3>
        <p className="muted">{p.has_build_script === true ? 'Has a build script (details pending generate-metadata).' : 'Not scanned yet (run painter generate-metadata --job build).'}</p>
      </>
    );
  }
  if (p.has_build_script !== true) {
    return (
      <>
        <h3>Build script</h3>
        <p className="muted">None.</p>
      </>
    );
  }
  return (
    <>
      <h3>Build script</h3>
      <table className="props unsafe-cats">
        <tbody>
          <tr>
            <th>script</th>
            <td>
              <code>{String(p.build_script ?? 'build.rs')}</code>
              {p.build_script_lines === null || p.build_script_lines === undefined ? <span className="muted"> (not in the tarball)</span> : ` · ${n(numOf(p, 'build_script_lines'))} lines`}
            </td>
          </tr>
          {typeof p.links === 'string' && (
            <tr>
              <th>links</th>
              <td>
                <span className="flag links">{p.links}</span>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}

function NativeSummary({ p }: { p: Record<string, unknown> }) {
  if (!p.meta_native) {
    return (
      <>
        <h3>Native code</h3>
        <p className="muted">Not scanned yet (run painter generate-metadata --job native).</p>
      </>
    );
  }
  if (p.has_native_code !== true) {
    return (
      <>
        <h3>Native code</h3>
        <p className="muted">None{numOf(p, 'native_prebuilt_files') ? ` (${n(numOf(p, 'native_prebuilt_files'))} prebuilt binaries)` : ''}.</p>
      </>
    );
  }
  const langs = Array.isArray(p.native_langs) ? (p.native_langs as string[]) : [];
  const dirs = Array.isArray(p.native_dirs) ? (p.native_dirs as string[]) : [];
  return (
    <>
      <h3>
        Native code{' '}
        {p.vendored_native === true ? (
          <span className="flag vendored" title="Enough native code to be a vendored library">
            vendored
          </span>
        ) : (
          <span className="flag native">shim</span>
        )}
      </h3>
      <table className="props unsafe-cats">
        <tbody>
          <tr>
            <th>languages</th>
            <td>{langs.join(', ') || '—'}</td>
          </tr>
          <tr>
            <th>files</th>
            <td>
              {n(numOf(p, 'native_source_files'))} sources · {n(numOf(p, 'native_header_files'))} headers
            </td>
          </tr>
          <tr>
            <th>lines</th>
            <td>
              {n(numOf(p, 'native_lines'))} ({n(numOf(p, 'native_source_lines'))} in sources)
              {numOf(p, 'native_vendor_dir_lines') ? ` · ${n(numOf(p, 'native_vendor_dir_lines'))} under vendor dirs` : ''}
            </td>
          </tr>
          <tr>
            <th>size</th>
            <td>
              {n(numOf(p, 'native_bytes'))} bytes · largest {n(numOf(p, 'native_largest_bytes'))}
            </td>
          </tr>
          {numOf(p, 'native_prebuilt_files') ? (
            <tr>
              <th>prebuilt</th>
              <td>{n(numOf(p, 'native_prebuilt_files'))} binaries (.a .so .dll .o …)</td>
            </tr>
          ) : null}
          <tr>
            <th>in</th>
            <td>{dirs.map((d) => `${d}/`).join(' ') || '—'}</td>
          </tr>
        </tbody>
      </table>
    </>
  );
}

function DiffSummary({ p }: { p: Record<string, unknown> }) {
  if (!p.meta_diff) {
    return (
      <>
        <h3>Changes since previous version</h3>
        <p className="muted">Not diffed yet (run painter generate-metadata --job diff).</p>
      </>
    );
  }
  const base = typeof p.diff_base === 'string' ? p.diff_base : null;
  const added = numOf(p, 'diff_lines_added') ?? 0;
  const removed = numOf(p, 'diff_lines_removed') ?? 0;
  const fa = numOf(p, 'diff_files_added') ?? 0;
  const fr = numOf(p, 'diff_files_removed') ?? 0;
  const fm = numOf(p, 'diff_files_modified') ?? 0;
  const paths = Array.isArray(p.diff_paths) ? (p.diff_paths as string[]) : [];
  const pAdded = Array.isArray(p.diff_added) ? (p.diff_added as number[]) : [];
  const pRemoved = Array.isArray(p.diff_removed) ? (p.diff_removed as number[]) : [];
  const pStatus = Array.isArray(p.diff_status) ? (p.diff_status as string[]) : [];
  const top = paths
    .map((path, i) => ({ path, status: pStatus[i], added: pAdded[i] ?? 0, removed: pRemoved[i] ?? 0 }))
    .sort((a, b) => b.added + b.removed - (a.added + a.removed))
    .slice(0, 8);
  return (
    <>
      <h3>
        Changes since {base ? `v${base}` : 'nothing (first version)'}{' '}
        {p.diff_approximate === true && (
          <span className="flag approx" title="A file hit the diff timeout; counts are an upper bound">
            approx
          </span>
        )}
      </h3>
      <table className="props unsafe-cats">
        <tbody>
          <tr>
            <th>lines</th>
            <td>
              <span className="added">+{added.toLocaleString()}</span> / <span className="removed">−{removed.toLocaleString()}</span>
            </td>
          </tr>
          <tr>
            <th>files</th>
            <td>
              {base === null ? `${n(numOf(p, 'diff_files_total'))} added` : `+${fa} · −${fr} · ~${fm} of ${n(numOf(p, 'diff_files_total'))}`}
              {base !== null && fa + fr + fm === 0 ? <span className="muted"> (identical)</span> : null}
            </td>
          </tr>
        </tbody>
      </table>
      {base !== null && top.length > 0 && (
        <ul className="targets diff-top">
          {top.map((f) => (
            <li key={f.path} title={`${f.status}: +${f.added} / −${f.removed}`}>
              <span className={`status ${f.status}`}>{f.status === 'added' ? '+' : f.status === 'removed' ? '−' : '~'}</span> <code>{f.path}</code>{' '}
              <span className="muted small">
                +{f.added}/−{f.removed}
              </span>
            </li>
          ))}
          {paths.length > top.length && <li className="muted small">… {paths.length - top.length} more in the Diffs view</li>}
        </ul>
      )}
    </>
  );
}

const str = (p: Record<string, unknown>, k: string) => (typeof p[k] === 'string' && p[k] ? (p[k] as string) : null);

const ExtLink = ({ href, label }: { href: string; label?: string }) => (
  <a href={href} target="_blank" rel="noreferrer" className="ext">
    {label ?? href.replace(/^https?:\/\//, '')}
  </a>
);

function CrateRegistrySummary({ p, onOpenUser }: { p: Record<string, unknown>; onOpenUser: (login: string) => void }) {
  const name = String(p.name ?? '');
  const [reg, setReg] = useState<CrateRegistry | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setReg(null);
    setError(null);
    api
      .crateRegistry(name)
      .then((r) => !cancelled && setReg(r))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [name]);
  if (!p.registry_id) {
    return (
      <>
        <h3>crates.io</h3>
        <p className="muted">Not in the registry dump yet (run painter generate-metadata --job registry).</p>
      </>
    );
  }
  const description = str(p, 'description');
  return (
    <>
      <h3>crates.io</h3>
      {description && <p className="crate-description">{description}</p>}
      <table className="props unsafe-cats">
        <tbody>
          <tr>
            <th>downloads</th>
            <td>
              <b>{fmtCompact(numOf(p, 'downloads'))}</b> <span className="muted">{n(numOf(p, 'downloads'))}</span>
            </td>
          </tr>
          <tr>
            <th>versions</th>
            <td>
              {n(numOf(p, 'num_versions'))}
              {str(p, 'default_version') ? ` · default ${str(p, 'default_version')}` : ''}
            </td>
          </tr>
          <tr>
            <th>created</th>
            <td title={fmtDateTime(str(p, 'created_at'))}>{fmtDate(str(p, 'created_at'))}</td>
          </tr>
          <tr>
            <th>updated</th>
            <td title={fmtDateTime(str(p, 'updated_at'))}>{fmtDate(str(p, 'updated_at'))}</td>
          </tr>
          <tr>
            <th>links</th>
            <td>
              {str(p, 'repository') && (
                <div>
                  <ExtLink href={str(p, 'repository')!} />
                </div>
              )}
              {str(p, 'homepage') && str(p, 'homepage') !== str(p, 'repository') && (
                <div>
                  <ExtLink href={str(p, 'homepage')!} />
                </div>
              )}
              {str(p, 'documentation') && (
                <div>
                  <ExtLink href={str(p, 'documentation')!} label="documentation" />
                </div>
              )}
              <div>
                <ExtLink href={`https://crates.io/crates/${name}`} label="crates.io" />
              </div>
            </td>
          </tr>
          {p.trustpub_only === true && (
            <tr>
              <th>publishing</th>
              <td>
                <span className="flag forbid" title="Only trusted publishing (CI identity) may upload">
                  trusted publishing only
                </span>
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {error && <p className="muted small">{error}</p>}
      {reg && (
        <>
          <h3>Owners {reg.owners.length ? <span className="muted">{reg.owners.length}</span> : null}</h3>
          {reg.owners.length ? (
            <table className="props unsafe-cats owners">
              <tbody>
                {reg.owners.map((o) => (
                  <tr key={o.login}>
                    <th>
                      <span className="swatch" style={{ background: o.kind === 'Team' ? '#20B2AA' : '#E36BAE' }} /> <UserLink login={o.login} name={o.name} onOpen={onOpenUser} />
                    </th>
                    <td className="muted small" title={fmtDateTime(o.since)}>
                      since {fmtDate(o.since)}
                      {o.addedBy && o.addedBy !== o.login ? (
                        <>
                          {' '}
                          by <UserLink login={o.addedBy} onOpen={onOpenUser} />
                        </>
                      ) : (
                        ''
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted">No owners recorded.</p>
          )}
          <h3>Publishers {reg.publishers.length ? <span className="muted">{reg.publishers.length}</span> : null}</h3>
          {reg.publishers.length ? (
            <table className="props unsafe-cats owners">
              <tbody>
                {reg.publishers.slice(0, 8).map((u) => (
                  <tr key={u.login}>
                    <th>
                      <UserLink login={u.login} name={u.name} onOpen={onOpenUser} />
                    </th>
                    <td className="muted small" title={`first ${fmtDateTime(u.first)}, last ${fmtDateTime(u.last)}`}>
                      {u.versions} upload{u.versions === 1 ? '' : 's'} · {fmtDate(u.first)} → {fmtDate(u.last)}
                    </td>
                  </tr>
                ))}
                {reg.publishers.length > 8 && (
                  <tr>
                    <td colSpan={2} className="muted small">
                      … {reg.publishers.length - 8} more
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          ) : (
            <p className="muted">No uploader recorded (crates.io records uploaders since 2017).</p>
          )}
          {(reg.categories.length > 0 || reg.keywords.length > 0) && (
            <>
              <h3>Categories and keywords</h3>
              <div className="chips">
                {reg.categories.map((c) => (
                  <span key={c.slug} className="flag category" title={`${c.slug}${c.crates ? ` · ${c.crates.toLocaleString()} crates` : ''}`}>
                    {c.name}
                  </span>
                ))}
                {reg.keywords.map((k) => (
                  <span key={k} className="flag keyword">
                    #{k}
                  </span>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}

function VersionRegistrySummary({ p, onOpenUser }: { p: Record<string, unknown>; onOpenUser: (login: string) => void }) {
  const name = String(p.name ?? '');
  const version = String(p.version ?? '');
  const [pub, setPub] = useState<VersionPublisher | null>(null);
  useEffect(() => {
    let cancelled = false;
    setPub(null);
    api
      .versionPublisher(name, version)
      .then((r) => !cancelled && setPub(r))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [name, version]);
  if (!p.meta_registry) {
    return (
      <>
        <h3>crates.io</h3>
        <p className="muted">{p.registry_missing ? 'Not in the crates.io dump (deleted or renamed).' : 'Not in the registry dump yet (run painter generate-metadata --job registry).'}</p>
      </>
    );
  }
  const bins = Array.isArray(p.bin_names) ? (p.bin_names as string[]) : [];
  return (
    <>
      <h3>
        crates.io{' '}
        {p.yanked === true && (
          <span className="flag yanked" title="Yanked on crates.io">
            yanked
          </span>
        )}
      </h3>
      <table className="props unsafe-cats">
        <tbody>
          <tr>
            <th>published</th>
            <td title={fmtDateTime(str(p, 'published_at'))}>{fmtDate(str(p, 'published_at'))}</td>
          </tr>
          <tr>
            <th>uploader</th>
            <td>{pub ? pub.login ? <UserLink login={pub.login} name={pub.publisherName} onOpen={onOpenUser} /> : <span className="muted">not recorded</span> : <span className="muted">…</span>}</td>
          </tr>
          <tr>
            <th>downloads</th>
            <td>
              <b>{fmtCompact(numOf(p, 'downloads'))}</b> <span className="muted">{n(numOf(p, 'downloads'))}</span>
            </td>
          </tr>
          <tr>
            <th>license</th>
            <td>{str(p, 'license') ?? <span className="muted">—</span>}</td>
          </tr>
          <tr>
            <th>crate size</th>
            <td>{fmtBytes(numOf(p, 'crate_size'))}</td>
          </tr>
          <tr>
            <th>edition · msrv</th>
            <td>
              {str(p, 'edition') ?? '—'} · {str(p, 'rust_version') ?? '—'}
            </td>
          </tr>
          <tr>
            <th>targets</th>
            <td>
              {p.has_lib === true ? 'lib' : p.has_lib === false ? <span className="muted">no lib</span> : '—'}
              {bins.length ? ` · bin ${bins.join(', ')}` : ''}
            </td>
          </tr>
        </tbody>
      </table>
    </>
  );
}

const SUMMARISED = /^(diff_(paths|status|added|removed|binary)|description)$/;

function Properties({ props }: { props: Record<string, unknown> }) {
  const entries = Object.entries(props).sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) return <p className="muted">no properties</p>;
  return (
    <table className="props">
      <tbody>
        {entries.map(([k, v]) => (
          <tr key={k}>
            <th>{k}</th>
            <td>{fmt(v)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const plus = (n: number | undefined | null) => (typeof n === 'number' && n > 0 ? ` +${n.toLocaleString()}` : '');

function GraphCounts({ node }: { node: GraphNode }) {
  const c = node.counts;
  if (!c) return null;
  return (
    <>
      <h3>In the graph</h3>
      <table className="props unsafe-cats">
        <tbody>
          {typeof c.deps === 'number' && (
            <tr>
              <th>dependencies</th>
              <td>{c.deps.toLocaleString()} crates <span className="muted">(any version)</span></td>
            </tr>
          )}
          {typeof c.dependents === 'number' && (
            <tr>
              <th>dependents</th>
              <td>
                <b>{c.dependents.toLocaleString()}</b> crates
                {typeof c.dependentVersions === 'number' ? <span className="muted"> · {c.dependentVersions.toLocaleString()} version declarations</span> : null}
              </td>
            </tr>
          )}
          {typeof c.versions === 'number' && (
            <tr>
              <th>versions</th>
              <td>{c.versions.toLocaleString()}</td>
            </tr>
          )}
          {typeof c.symbolsCalled === 'number' && (
            <tr>
              <th>called from other crates</th>
              <td>
                {c.symbolsCalled.toLocaleString()} functions <span className="muted">(Callers view lists who)</span>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}

export function DetailsPanel({ view, selected, nodeById, onExpand, onOverview, shownCount, onRemove, onLoadCrate, onOpenUser, busy }: Props) {
  if (!selected) {
    return (
      <div className="details">
        <h2>Nothing selected</h2>
        <p className="muted">
          Click a node or edge to inspect it. Double-click a crate or version to add its dependencies. Drag nodes; the layout stays where you put it.
        </p>
        <h3>Legend</h3>
        {view === 'default' ? (
          <ul className="legend">
            <li>
              <span className="swatch" style={{ background: ROLE_COLORS.root }} /> Loaded crate (centre)
            </li>
            <li>
              <span className="swatch" style={{ background: ROLE_COLORS.dep }} /> Dependency (right; size = downloads)
            </li>
            <li>
              <span className="swatch" style={{ background: ROLE_COLORS.depOptional }} /> optional ·{' '}
              <span className="swatch" style={{ background: ROLE_COLORS.depBuild }} /> build ·{' '}
              <span className="swatch" style={{ background: ROLE_COLORS.depDev }} /> dev
            </li>
            <li>
              <span className="swatch" style={{ background: ROLE_COLORS.callee }} /> Called into but not declared (inlined transitive code)
            </li>
            <li>
              <span className="swatch" style={{ background: ROLE_COLORS.dependent }} /> Dependent (left; the most-downloaded users)
            </li>
            <li>
              <span className="swatch" style={{ background: ROLE_COLORS.version }} /> Version (bottom strip, oldest → latest) ·{' '}
              <span className="swatch" style={{ background: ROLE_COLORS.versionPre }} /> pre-release ·{' '}
              <span className="swatch" style={{ background: ROLE_COLORS.versionYanked }} /> yanked
            </li>
            <li>
              <span className="line" style={{ background: ROLE_COLORS.dep }} /> DEPENDS_ON (thicker = more calls into it; turn on edge labels for requirement / kind)
            </li>
            <li>
              <span className="line" style={{ background: ROLE_COLORS.callee }} /> INVOKES: calls into a crate that is not a direct dependency
            </li>
            <li>
              <span className="swatch" style={{ background: '#E36BAE' }} /> User · <span className="swatch" style={{ background: '#20B2AA' }} /> Team (crates.io, top)
            </li>
            <li className="muted small">Captions: ⊘ yanked · ☢N unsafe · ⚙ build script · C native code · Δ lines changed</li>
          </ul>
        ) : (
        <ul className="legend">
          <li>
            <span className="swatch" style={{ background: '#1F5FD1' }} /> Crate (loaded root)
          </li>
          <li>
            <span className="swatch" style={{ background: '#4C8DFF' }} /> Crate
          </li>
          <li>
            <span className="swatch" style={{ background: '#F5A623' }} /> Version
          </li>
          <li>
            <span className="swatch" style={{ background: '#2BB673' }} /> Version (latest = true)
          </li>
          <li>
            <span className="swatch" style={{ background: '#B88BFF' }} /> Version (pre-release)
          </li>
          <li>
            <span className="line" style={{ background: '#9AA3B2' }} /> VERSION_OF
          </li>
          <li>
            <span className="line" style={{ background: '#4C8DFF' }} /> DEPENDS_ON
          </li>
          <li>
            <span className="line" style={{ background: '#E5484D' }} /> INVOKES: calls into a crate (width = distinct calls)
          </li>
          <li>
            <span className="swatch" style={{ background: '#E36BAE' }} /> User · <span className="swatch" style={{ background: '#20B2AA' }} /> Team (crates.io)
          </li>
          <li>
            <span className="line" style={{ background: '#E36BAE' }} /> OWNS · <span className="line" style={{ background: '#C9A227' }} /> PUBLISHED (width = uploads)
          </li>
        </ul>
        )}
      </div>
    );
  }

  if (isRel(selected)) {
    const from = nodeById(selected.from);
    const to = nodeById(selected.to);
    const targets = Array.isArray(selected.properties.targets) ? (selected.properties.targets as string[]) : null;
    return (
      <div className="details">
        <h2>
          <span className="badge rel">{selected.type}</span> {relTitle(selected)}
        </h2>
        <p>
          <strong>{from ? nodeTitle(from) : selected.from}</strong> → <strong>{to ? nodeTitle(to) : selected.to}</strong>
        </p>
        {selected.properties.aggregated === true && selected.type === 'INVOKES' && (
          <p className="muted">
            Aggregated: {fmt(selected.properties.count)} distinct calls (CALLS edges) collapsed into one. Showing up
            to 10 distinct targets.
          </p>
        )}
        {selected.properties.aggregated === true && selected.type === 'DEPENDS_ON' && (
          <p className="muted">
            Crate-level edge: {fmt(selected.properties.versions)} version(s) of {from ? nodeTitle(from) : selected.from}{' '}
            declare a dependency on {to ? nodeTitle(to) : selected.to}.
          </p>
        )}
        {selected.type === 'DEPENDS_ON' && typeof selected.properties.via === 'string' && (
          <p className="muted">
            Declared by version {selected.properties.via}
            {Number(selected.properties.declarations) > 1 ? ` (${fmt(selected.properties.declarations)} declarations, e.g. per target, folded into one edge)` : ''}
            {typeof selected.properties.calls === 'number' && selected.properties.calls > 0
              ? `; its compiled code makes ${selected.properties.calls.toLocaleString()} distinct calls into ${fmt(selected.properties.symbols)} of its functions.`
              : '.'}
          </p>
        )}
        {targets ? (
          <>
            <h3>Targets</h3>
            <ul className="targets">
              {targets.map((t) => (
                <li key={t}>
                  <code>{t}</code>
                </li>
              ))}
            </ul>
          </>
        ) : null}
        <h3>Properties</h3>
        <Properties props={Object.fromEntries(Object.entries(selected.properties).filter(([k]) => k !== 'targets'))} />
      </div>
    );
  }

  const node = selected;
  const name = String(node.properties.name ?? '');
  return (
    <div className="details">
      <h2>
        <span className={`badge ${isCrate(node) ? 'crate' : isVersion(node) ? 'version' : isUser(node) ? 'user' : isTeam(node) ? 'team' : ''}`}>{node.labels.join(':')}</span>{' '}
        {nodeTitle(node)}
      </h2>

      <div className="actions">
        {isCrate(node) && view === 'default' && onOverview && (
          <>
            {node.role !== 'root' && (
              <button disabled={busy} className="primary" onClick={() => onLoadCrate(name)} title="Redraw the canvas around this crate">
                Focus
              </button>
            )}
            <button disabled={busy} onClick={() => onOverview(name, 'deps')} title={`Add what its latest version depends on (one edge per crate)${typeof node.counts?.deps === 'number' ? `; ${node.counts.deps.toLocaleString()} crates across all versions` : ''}`}>
              Latest deps
            </button>
            <button
              disabled={busy}
              onClick={() => onOverview(name, 'dependents')}
              title="Add the 25 most-downloaded crates that depend on it; press again for the next 25"
            >
              Dependents{plus(node.counts?.dependents !== undefined ? node.counts.dependents - (shownCount?.(name, 'dependents') ?? 0) : undefined)}
            </button>
            <button disabled={busy} onClick={() => onOverview(name, 'versions')} title="Add the next 12 older versions to the strip">
              Versions{plus(node.counts?.versions !== undefined ? node.counts.versions - (shownCount?.(name, 'versions') ?? 0) : undefined)}
            </button>
            <button disabled={busy} onClick={() => onOverview(name, 'calls')} title="Crates the latest version's compiled code calls into">
              Calls
            </button>
            <button disabled={busy} onClick={() => onExpand(node.id, 'in', ['OWNS'])} title="Add the crates.io owners (users and teams)">
              Owners
            </button>
            <button disabled={busy} onClick={() => onExpand(node.id, 'in', ['PUBLISHED'])} title="Add every user who uploaded a version">
              Publishers
            </button>
          </>
        )}
        {isCrate(node) && view === 'default' && !onOverview && (
          <button disabled={busy} onClick={() => onLoadCrate(name)}>
            Load crate
          </button>
        )}
        {isVersion(node) && view === 'default' && onOverview && (
          <>
            <button disabled={busy} onClick={() => onOverview(name, 'deps', { version: String(node.properties.version) })} title="What this version declares (edges from this version)">
              Dependencies
            </button>
            <button disabled={busy} onClick={() => onOverview(name, 'calls', { version: String(node.properties.version) })} title="Crates this version's compiled code calls into">
              Calls
            </button>
            <button disabled={busy} onClick={() => onExpand(node.id, 'in', ['PUBLISHED'])} title="Add the user who uploaded this version">
              Uploader
            </button>
          </>
        )}
        {isVersion(node) && !(view === 'default' && onOverview) && (
          <>
            <button disabled={busy} onClick={() => onExpand(node.id, 'out', ['DEPENDS_ON'])}>
              Dependencies
            </button>
            <button disabled={busy} onClick={() => onExpand(node.id, 'out', ['INVOKES'])}>
              Invokes
            </button>
            <button disabled={busy} onClick={() => onExpand(node.id, 'both', ['VERSION_OF'])}>
              Crate
            </button>
            {view === 'default' && (
              <button disabled={busy} onClick={() => onExpand(node.id, 'in', ['PUBLISHED'])} title="Add the user who uploaded this version">
                Uploader
              </button>
            )}
          </>
        )}
        {(isUser(node) || isTeam(node)) && (
          <>
            <button disabled={busy} className="primary" onClick={() => onOpenUser(String(node.properties.login ?? ''))} title="Open in the Publishers view">
              Open publisher
            </button>
            <button disabled={busy} onClick={() => onExpand(node.id, 'out', ['OWNS'])} title="Add the crates this account owns">
              Owns
            </button>
            {isUser(node) && (
              <button disabled={busy} onClick={() => onExpand(node.id, 'out', ['PUBLISHED'])} title="Add crates and versions this user uploaded (capped at 100)">
                Published
              </button>
            )}
          </>
        )}
        {view === 'default' && !(onOverview && (isCrate(node) || isVersion(node))) && (
          <button disabled={busy} onClick={() => onExpand(node.id, 'both', [])}>
            Expand all
          </button>
        )}
        <button disabled={busy} className="danger" onClick={() => onRemove(node.id)}>
          Remove
        </button>
      </div>

      {isCrate(node) && view === 'default' && <GraphCounts node={node} />}
      {isCrate(node) && <CrateRegistrySummary p={node.properties} onOpenUser={onOpenUser} />}
      {isVersion(node) && (
        <>
          <VersionRegistrySummary p={node.properties} onOpenUser={onOpenUser} />
          <UnsafeSummary p={node.properties} />
          <BuildSummary p={node.properties} />
          <NativeSummary p={node.properties} />
          <DiffSummary p={node.properties} />
        </>
      )}
      {(isUser(node) || isTeam(node)) && (
        <>
          <h3>crates.io {isTeam(node) ? 'team' : 'user'}</h3>
          <p className="muted">
            {String(node.properties.name ?? '')}
            {isUser(node) && (
              <>
                {' '}
                · <ExtLink href={`https://github.com/${String(node.properties.login ?? '')}`} />
              </>
            )}
          </p>
        </>
      )}
      <h3>Properties</h3>
      <Properties props={Object.fromEntries(Object.entries(node.properties).filter(([k]) => !SUMMARISED.test(k)))} />
      <p className="muted small">elementId {node.id}</p>
    </div>
  );
}

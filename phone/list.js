/*
 * The first screen: recently opened requests, then the workspace's
 * collections as a tree, with search across the loaded ones.
 */
'use no memo'; // React Compiler mis-memoizes optional chains here (env?.variables read as env.variables).
import React, { useState } from 'react';
import { useDispatch } from 'react-redux';
import { mountCollection } from 'providers/ReduxStore/slices/collections/actions';
import { findItemInCollection, isItemAFolder, isItemARequest } from 'utils/collections';
import { Icon, IconButton, Empty, methodClass } from './ui';

const RECENT_KEY = 'bruno-web-phone-recent';
const RECENT_MAX = 5;

export const bySeq = (a, b) => (a.seq ?? 0) - (b.seq ?? 0) || String(a.name).localeCompare(String(b.name));

export const methodOf = (item) => {
  if (item.type === 'http-request') return (item.draft || item).request?.method || 'GET';
  return { 'graphql-request': 'GQL', 'grpc-request': 'gRPC', 'ws-request': 'WS' }[item.type] || '?';
};

export const hasDraft = (items) => (items || []).some((i) => i.draft || (isItemAFolder(i) && hasDraft(i.items)));

// Requests in a collection with the folders above them, for search.
const flatten = (items, trail, out) => {
  for (const item of [...(items || [])].sort(bySeq)) {
    if (isItemAFolder(item)) flatten(item.items, [...trail, item.name], out);
    else if (isItemARequest(item)) out.push({ item, trail });
  }
  return out;
};

// Recently opened requests live in this browser only (one key, per device).
export const readRecent = () => {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
};
export const rememberRecent = (collectionUid, uid) => {
  const list = [{ uid, collectionUid, at: Date.now() }, ...readRecent().filter((r) => r.uid !== uid)].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch (e) {
    // Without storage the list just stays empty.
  }
  return list;
};

const ago = (at) => {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} d`;
};

export const statusTone = (status) => (Number(status) >= 200 && Number(status) < 400 ? 'ok' : 'danger');

const Guides = ({ depth }) => Array.from({ length: depth }, (_, i) => (
  <span key={i} className="bw-guide" style={{ left: 23 + i * 24 }} aria-hidden="true" />
));

const RequestRow = ({ item, depth, trail, onOpen, extra }) => (
  <button type="button" className="bw-row bw-request" style={{ paddingLeft: depth ? 40 + (depth - 1) * 24 : 16 }} onClick={() => onOpen(item)} data-testid="bw-phone-request">
    <Guides depth={depth} />
    <span className={methodClass(methodOf(item))}>{methodOf(item)}</span>
    <span className="bw-name">
      {item.name}
      {trail ? <span className="bw-trail">{trail}</span> : null}
    </span>
    {extra}
    {item.draft ? <span className="bw-dot" aria-label="unsaved" title="unsaved" /> : null}
  </button>
);

const GroupRow = ({ name, depth, open, onToggle, onMenu, draft, testId, menuLabel }) => (
  <div className="bw-row-wrap">
    <button type="button" className={`bw-row bw-group${depth ? '' : ' bw-collection'}`} style={{ paddingLeft: 16 + depth * 24 }} onClick={onToggle} aria-expanded={open} data-testid={testId}>
      <Guides depth={depth} />
      <Icon name={open ? 'down' : 'right'} size={16} width={2} className="bw-chevron" />
      <span className="bw-name">{name}</span>
      {draft ? <span className="bw-dot" aria-label="unsaved" title="unsaved" /> : null}
    </button>
    {onMenu ? <IconButton icon="more" label={menuLabel} onClick={onMenu} testId={`${testId}-menu`} /> : null}
  </div>
);

const Tree = ({ items, depth, onOpen, onMenu, open, setOpen }) => [...(items || [])].sort(bySeq).map((item) => {
  if (isItemAFolder(item)) {
    const expanded = !!open[item.uid];
    return (
      <div key={item.uid}>
        <GroupRow
          name={item.name}
          depth={depth}
          open={expanded}
          draft={hasDraft(item.items) || !!item.draft}
          onToggle={() => setOpen((o) => ({ ...o, [item.uid]: !expanded }))}
          onMenu={() => onMenu(item)}
          menuLabel={`More for folder ${item.name}`}
          testId="bw-phone-folder"
        />
        {expanded ? <Tree items={item.items} depth={depth + 1} onOpen={onOpen} onMenu={onMenu} open={open} setOpen={setOpen} /> : null}
      </div>
    );
  }
  if (!isItemARequest(item)) return null;
  return <RequestRow key={item.uid} item={item} depth={depth} onOpen={onOpen} />;
});

export const ListScreen = ({ collections, workspaceName, recent, onOpen, onNew, onMenu, onWorkspaceMenu, hidden }) => {
  const dispatch = useDispatch();
  const [open, setOpen] = useState({});
  const [failed, setFailed] = useState({});
  const [query, setQuery] = useState('');

  const load = (c) => {
    setFailed((f) => ({ ...f, [c.uid]: false }));
    Promise.resolve(dispatch(mountCollection({ collectionUid: c.uid, collectionPathname: c.pathname, brunoConfig: c.brunoConfig })))
      .catch(() => setFailed((f) => ({ ...f, [c.uid]: true })));
  };
  const toggle = (c) => {
    if (!open[c.uid] && c.mountStatus !== 'mounted' && c.mountStatus !== 'mounting') load(c);
    setOpen((o) => ({ ...o, [c.uid]: !o[c.uid] }));
  };

  const q = query.trim().toLowerCase();
  const matches = q
    ? collections.flatMap((c) => flatten(c.items, [c.name], [])
      .filter(({ item }) => item.name.toLowerCase().includes(q) || String((item.draft || item).request?.url || '').toLowerCase().includes(q))
      .map((m) => ({ ...m, collection: c })))
    : [];
  const unsearched = q ? collections.filter((c) => c.mountStatus !== 'mounted').length : 0;

  const recentRows = recent
    .map((r) => {
      const c = collections.find((x) => x.uid === r.collectionUid);
      const item = c && findItemInCollection(c, r.uid);
      return item && isItemARequest(item) ? { ...r, c, item } : null;
    })
    .filter(Boolean)
    .slice(0, 3);

  const body = (c) => {
    if (failed[c.uid]) {
      return (
        <Empty>
          This collection could not be loaded.
          <button type="button" className="bw-link" onClick={() => load(c)}>Retry</button>
        </Empty>
      );
    }
    if (c.mountStatus !== 'mounted') return <Empty>Loading…</Empty>;
    if (!(c.items || []).length) return <Empty>No requests yet.</Empty>;
    return <Tree items={c.items} depth={1} onOpen={(item) => onOpen(c, item)} onMenu={(item) => onMenu(c, item)} open={open} setOpen={setOpen} />;
  };

  return (
    <div className="bw-screen bw-list" hidden={hidden}>
      <header className="bw-phone-header">
        <div className="bw-phone-title bw-phone-title-root">{workspaceName}</div>
        <IconButton icon="plus" label="New request or folder" onClick={() => onNew(null)} testId="bw-phone-new-request" />
        <IconButton icon="more" label="More" onClick={onWorkspaceMenu} testId="bw-phone-more" />
      </header>
      <div className="bw-scroll">
        <label className="bw-search">
          <span className="bw-sr">Search requests</span>
          <Icon name="search" size={15} width={2} />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search requests"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            data-testid="bw-phone-search"
          />
        </label>
        {q ? (
          <>
            {matches.map(({ item, trail, collection }) => (
              <RequestRow key={item.uid} item={item} depth={0} trail={trail.join(' / ')} onOpen={() => onOpen(collection, item)} />
            ))}
            {matches.length === 0 ? <Empty>No matching requests.</Empty> : null}
            {unsearched ? <Empty>{unsearched} collection{unsearched > 1 ? 's have' : ' has'} not been opened yet and {unsearched > 1 ? 'are' : 'is'} not searched.</Empty> : null}
          </>
        ) : (
          <>
            {recentRows.length ? (
              <section aria-label="Recent" className="bw-section">
                <h2 className="bw-section-title"><Icon name="clock" size={15} />Recent</h2>
                {recentRows.map(({ c, item, at }) => (
                  <RequestRow
                    key={item.uid}
                    item={item}
                    depth={0}
                    onOpen={() => onOpen(c, item)}
                    extra={(
                      <span className="bw-recent-meta">
                        {item.response?.status ? <span className={`bw-${statusTone(item.response.status)}`}>{item.response.status}</span> : null}
                        <span>{ago(at)}</span>
                      </span>
                    )}
                  />
                ))}
              </section>
            ) : null}
            <section aria-label="Collections" className="bw-section">
              <h2 className="bw-section-title"><Icon name="box" size={15} />Collections</h2>
              {collections.length === 0 ? <Empty>This workspace has no collections yet. Open or import one in the full interface.</Empty> : null}
              {collections.map((c) => (
                <div key={c.uid}>
                  <GroupRow
                    name={c.name}
                    depth={0}
                    open={!!open[c.uid]}
                    draft={hasDraft(c.items) || !!c.draft}
                    onToggle={() => toggle(c)}
                    onMenu={c.mountStatus === 'mounted' ? () => onMenu(c, null) : null}
                    menuLabel={`More for collection ${c.name}`}
                    testId="bw-phone-collection"
                  />
                  {open[c.uid] ? body(c) : null}
                </div>
              ))}
            </section>
          </>
        )}
      </div>
    </div>
  );
};

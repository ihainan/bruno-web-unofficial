/*
 * Phone mode: a request manager for phones built from upstream's own store,
 * actions and components. scripts/fetch-upstream.sh copies this directory into
 * the renderer source as src/bruno-web-phone, and patches/0001-phone-mode.patch
 * renders it from pages/Bruno instead of the desktop layout on phones.
 *
 * The current request is upstream's active tab, and edits go through
 * upstream's draft actions, so switching to the full interface and back keeps
 * the same request, draft, environment and response.
 *
 * Everything imported from upstream here is a contract the phone tests in
 * test/e2e/web.spec.js ("on a phone") check after every upstream upgrade.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import styled from 'styled-components';
import { addTab, makeTabPermanent } from 'providers/ReduxStore/slices/tabs';
import { requestUrlChanged, updateRequestMethod } from 'providers/ReduxStore/slices/collections';
import { sendRequest, saveRequest, mountCollection } from 'providers/ReduxStore/slices/collections/actions';
import {
  findItemInCollection,
  getGlobalEnvironmentVariables,
  getGlobalEnvironmentVariablesMasked,
  getWorkspaceCollections,
  isItemAFolder,
  isItemARequest
} from 'utils/collections';
import ResponsePane from 'components/ResponsePane';
import HttpRequestPane from 'components/RequestPane/HttpRequestPane';
import EnvironmentSelector from 'components/Environments/EnvironmentSelector';
import NewRequest from 'components/Sidebar/NewRequest';
import RequestNotLoaded from 'components/RequestTabPanel/RequestNotLoaded';
import RequestIsLoading from 'components/RequestTabPanel/RequestIsLoading';
import './phone.css';

// A phone in either orientation: narrow, or (in landscape) short. Tablets are
// neither and keep the full interface.
const QUERY = '(pointer: coarse) and (max-width: 760px), (pointer: coarse) and (max-height: 500px)';
const KEY = 'bruno-web-phone-mode';
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD', 'TRACE', 'CONNECT'];

const readChoice = () => {
  try {
    return sessionStorage.getItem(KEY);
  } catch (e) {
    return null;
  }
};

export const usePhoneMode = () => {
  const [eligible, setEligible] = useState(() => window.matchMedia(QUERY).matches);
  const [choice, setChoice] = useState(readChoice);
  useEffect(() => {
    const mq = window.matchMedia(QUERY);
    const onChange = () => setEligible(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  const choose = (value) => {
    try {
      sessionStorage.setItem(KEY, value);
    } catch (e) {
      // The choice then lasts until the page reloads.
    }
    setChoice(value);
  };
  const active = eligible && choice !== 'full';
  useEffect(() => {
    document.documentElement.classList.toggle('bw-phone-mode', active);
    // The full interface's drawer (web/mobile.js) must not stay open underneath.
    if (active) document.documentElement.classList.remove('bw-drawer-open');
  }, [active]);
  return { eligible, active, showFull: () => choose('full'), showPhone: () => choose('phone') };
};

// Bruno's theme (light, dark and their variants) as variables for phone.css.
const themed = (props) => {
  const t = props.theme;
  const m = t.request?.methods || {};
  return `
    --bw-bg: ${t.bg};
    --bw-text: ${t.text};
    --bw-muted: ${t.colors?.text?.muted || t.text};
    --bw-border: ${t.border?.border2 || 'rgba(128, 128, 128, 0.3)'};
    --bw-brand: ${t.button2?.color?.primary?.bg || t.brand};
    --bw-on-brand: ${t.button2?.color?.primary?.text || '#fff'};
    --bw-draft: ${t.draftColor || t.brand};
    --bw-get: ${m.get}; --bw-post: ${m.post}; --bw-put: ${m.put}; --bw-patch: ${m.patch};
    --bw-delete: ${m.delete}; --bw-options: ${m.options}; --bw-head: ${m.head};
  `;
};
const Root = styled.div`${themed}`;
const SwitchButton = styled.button`${themed}`;

export const PhoneModeSwitch = ({ phone }) => (
  <SwitchButton type="button" className="bw-phone-switch" data-testid="bw-phone-switch" onClick={phone.showPhone}>
    手机视图
  </SwitchButton>
);

const bySeq = (a, b) => (a.seq ?? 0) - (b.seq ?? 0) || String(a.name).localeCompare(String(b.name));

const methodOf = (item) => {
  if (item.type === 'http-request') return (item.draft || item).request?.method || 'GET';
  return { 'graphql-request': 'GQL', 'grpc-request': 'gRPC', 'ws-request': 'WS' }[item.type] || '?';
};

const hasDraft = (items) => (items || []).some((i) => i.draft || (isItemAFolder(i) && hasDraft(i.items)));

// Requests in a collection with the folders above them, for search.
const flatten = (items, trail, out) => {
  for (const item of [...(items || [])].sort(bySeq)) {
    if (isItemAFolder(item)) flatten(item.items, [...trail, item.name], out);
    else if (isItemARequest(item)) out.push({ item, trail });
  }
  return out;
};

const RequestRow = ({ item, depth = 1, trail, onOpen }) => (
  <button type="button" className="bw-phone-row bw-request" style={{ paddingLeft: 16 + depth * 16 }} onClick={() => onOpen(item)} data-testid="bw-phone-request">
    <span className={`bw-method bw-${methodOf(item).toLowerCase()}`}>{methodOf(item)}</span>
    <span className="bw-name">
      {item.name}
      {trail ? <span className="bw-trail">{trail}</span> : null}
    </span>
    {item.draft ? <span className="bw-draft" title="未保存">●</span> : null}
  </button>
);

const Tree = ({ items, depth, onOpen }) => {
  const [open, setOpen] = useState({});
  return [...(items || [])].sort(bySeq).map((item) => {
    if (isItemAFolder(item)) {
      const expanded = !!open[item.uid];
      return (
        <div key={item.uid}>
          <button type="button" className="bw-phone-row bw-folder" style={{ paddingLeft: 16 + depth * 16 }} onClick={() => setOpen({ ...open, [item.uid]: !expanded })}>
            <span className="bw-chevron">{expanded ? '▾' : '▸'}</span>
            <span className="bw-name">{item.name}</span>
          </button>
          {expanded && <Tree items={item.items} depth={depth + 1} onOpen={onOpen} />}
        </div>
      );
    }
    if (!isItemARequest(item)) return null;
    return <RequestRow key={item.uid} item={item} depth={depth} onOpen={onOpen} />;
  });
};

const ListScreen = ({ collections, onOpen, hidden }) => {
  const dispatch = useDispatch();
  const [open, setOpen] = useState({});
  const [failed, setFailed] = useState({});
  const [query, setQuery] = useState('');
  const [creatingIn, setCreatingIn] = useState(null);

  const load = (c) => {
    setFailed((f) => ({ ...f, [c.uid]: false }));
    Promise.resolve(dispatch(mountCollection({ collectionUid: c.uid, collectionPathname: c.pathname, brunoConfig: c.brunoConfig })))
      .catch(() => setFailed((f) => ({ ...f, [c.uid]: true })));
  };
  const toggle = (c) => {
    if (!open[c.uid] && c.mountStatus !== 'mounted' && c.mountStatus !== 'mounting') load(c);
    setOpen({ ...open, [c.uid]: !open[c.uid] });
  };

  const q = query.trim().toLowerCase();
  const matches = q
    ? collections.flatMap((c) => flatten(c.items, [c.name], [])
      .filter(({ item }) => item.name.toLowerCase().includes(q) || String((item.draft || item).request?.url || '').toLowerCase().includes(q))
      .map((m) => ({ ...m, collection: c })))
    : [];
  const unsearched = q ? collections.filter((c) => c.mountStatus !== 'mounted').length : 0;

  const body = (c) => {
    if (failed[c.uid]) {
      return (
        <p className="bw-phone-empty">
          这个集合没能加载。
          <button type="button" className="bw-phone-link" onClick={() => load(c)}>重试</button>
        </p>
      );
    }
    if (c.mountStatus !== 'mounted') return <p className="bw-phone-empty">加载中…</p>;
    return (
      <>
        <Tree items={c.items} depth={1} onOpen={(item) => onOpen(c, item)} />
        <button type="button" className="bw-phone-row bw-add" style={{ paddingLeft: 32 }} onClick={() => setCreatingIn(c.uid)} data-testid="bw-phone-new-request">
          ＋ 新建请求
        </button>
      </>
    );
  };

  return (
    <div className="bw-phone-scroll" hidden={hidden}>
      <div className="bw-phone-search">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索请求名称或地址"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          data-testid="bw-phone-search"
        />
      </div>
      {q ? (
        <>
          {matches.map(({ item, trail, collection }) => (
            <RequestRow key={item.uid} item={item} depth={0} trail={trail.join(' / ')} onOpen={() => onOpen(collection, item)} />
          ))}
          {matches.length === 0 ? <p className="bw-phone-empty">没有找到匹配的请求。</p> : null}
          {unsearched ? <p className="bw-phone-empty">还有 {unsearched} 个集合没有展开过，不在搜索范围内。</p> : null}
        </>
      ) : (
        <>
          {collections.length === 0 ? <p className="bw-phone-empty">这个工作区还没有集合。请切到完整界面打开或导入集合。</p> : null}
          {collections.map((c) => (
            <div key={c.uid}>
              <button type="button" className="bw-phone-row bw-collection" onClick={() => toggle(c)} data-testid="bw-phone-collection">
                <span className="bw-chevron">{open[c.uid] ? '▾' : '▸'}</span>
                <span className="bw-name">{c.name}</span>
                {hasDraft(c.items) ? <span className="bw-draft" title="有未保存的修改">●</span> : null}
              </button>
              {open[c.uid] ? body(c) : null}
            </div>
          ))}
        </>
      )}
      {creatingIn ? <NewRequest collectionUid={creatingIn} onClose={() => setCreatingIn(null)} /> : null}
    </div>
  );
};

const statusText = (item) => {
  if (['queued', 'sending'].includes(item.requestState)) return '发送中…';
  const r = item.response;
  if (!r) return '';
  if (r.error) return '出错';
  return `${r.status ?? ''} ${r.statusText ?? ''} · ${r.duration ?? '-'} ms`.trim();
};

export default function BrunoWebPhone({ phone }) {
  const dispatch = useDispatch();
  const allCollections = useSelector((state) => state.collections.collections);
  const workspaces = useSelector((state) => state.workspaces.workspaces);
  const activeWorkspaceUid = useSelector((state) => state.workspaces.activeWorkspaceUid);
  const tabs = useSelector((state) => state.tabs.tabs);
  const activeTabUid = useSelector((state) => state.tabs.activeTabUid);
  const { globalEnvironments, activeGlobalEnvironmentUid, globalEnvironmentDraft } = useSelector((state) => state.globalEnvironments);

  const activeWorkspace = workspaces.find((w) => w.uid === activeWorkspaceUid);
  const collections = useMemo(
    () => getWorkspaceCollections({ collections: allCollections, workspaces, activeWorkspace }),
    [allCollections, workspaces, activeWorkspace]
  );

  const tab = tabs.find((t) => t.uid === activeTabUid);
  const tabCollection = tab ? allCollections.find((c) => c.uid === tab.collectionUid) : null;
  // As upstream's RequestTabPanel does, give the panes the selected global
  // environment (variable highlighting and autocomplete use it).
  const collection = useMemo(() => tabCollection && {
    ...tabCollection,
    globalEnvironmentVariables: getGlobalEnvironmentVariables({ globalEnvironments, activeGlobalEnvironmentUid }),
    globalEnvSecrets: getGlobalEnvironmentVariablesMasked({ globalEnvironments, activeGlobalEnvironmentUid }),
    globalEnvironments,
    activeGlobalEnvironmentUid
  }, [tabCollection, globalEnvironments, activeGlobalEnvironmentUid]);
  const found = collection && tab ? findItemInCollection(collection, tab.uid) : null;
  const item = found && isItemARequest(found) ? found : null;

  const [screen, setScreen] = useState(item ? 'request' : 'list');
  // A request file that failed to parse, or is still loading, has no request yet.
  const unreadable = item && (item.partial || item.loading);
  const current = !item ? 'list' : unreadable && screen !== 'list' ? 'request' : screen;

  // A request opened elsewhere (a new request, once its file is loaded) becomes
  // the current one.
  const lastTab = useRef(activeTabUid);
  useEffect(() => {
    if (!item || activeTabUid === lastTab.current) return;
    lastTab.current = activeTabUid;
    setScreen('request');
  }, [activeTabUid, item]);

  // Like a click in the desktop sidebar, opening a request replaces the
  // previous preview tab; editing it keeps the tab, as on the desktop.
  useEffect(() => {
    if (tab && tab.preview && item && item.draft) dispatch(makeTabPermanent({ uid: tab.uid }));
  }, [tab, item, dispatch]);

  // Closing the browser tab asks first while anything is unsaved (web/bridge.js
  // reads this; the desktop layout's tab bar, which marks the same drafts, is
  // not rendered here).
  const unsaved = !!globalEnvironmentDraft || allCollections.some((c) => c.draft || c.environmentsDraft || hasDraft(c.items));
  useEffect(() => {
    document.documentElement.classList.toggle('bw-has-draft', unsaved);
    return () => document.documentElement.classList.remove('bw-has-draft');
  }, [unsaved]);

  const open = (c, it) => {
    dispatch(addTab({ uid: it.uid, collectionUid: c.uid, type: 'request', requestPaneTab: 'params', preview: true }));
    setScreen('request');
  };

  const isHttp = item && !unreadable && item.type === 'http-request';
  const inFlight = item && ['queued', 'sending'].includes(item.requestState);
  const request = item ? (item.draft || item).request : null;
  // Show the response screen once the request is under way: sendRequest first
  // asks for any {{?prompt}} variables (cancelling resolves it with nothing
  // sent), then gives the item a new requestUid. It does not settle at all
  // for some failures, so its promise only ends the wait.
  const [waiting, setWaiting] = useState(null);
  const send = () => {
    setWaiting({ itemUid: item.uid, requestUid: item.requestUid });
    Promise.resolve(dispatch(sendRequest(item, collection.uid)))
      .catch(() => {})
      .finally(() => setWaiting(null));
  };
  useEffect(() => {
    if (!waiting || !item || item.uid !== waiting.itemUid || item.requestUid === waiting.requestUid) return;
    setWaiting(null);
    setScreen('response');
  }, [waiting, item]);

  return (
    <Root className="bw-phone" data-testid="bw-phone">
      <header className="bw-phone-header">
        {current !== 'list' ? (
          <button type="button" className="bw-phone-back" onClick={() => setScreen(current === 'request' ? 'list' : 'request')} aria-label="返回" data-testid="bw-phone-back">‹</button>
        ) : null}
        <div className="bw-phone-title">{current === 'list' ? (activeWorkspace?.name || 'Bruno') : item.name}</div>
        {current !== 'list' && item.draft ? (
          <button type="button" className="bw-phone-action" onClick={() => dispatch(saveRequest(item.uid, collection.uid))} data-testid="bw-phone-save">保存</button>
        ) : null}
        <button type="button" className="bw-phone-action bw-subtle" onClick={phone.showFull} data-testid="bw-phone-full">完整界面</button>
      </header>

      {/* Kept while a request is open, so going back finds the list as it was
          (open folders, search, scroll position). */}
      <ListScreen collections={collections} onOpen={open} hidden={current !== 'list'} />

      {current === 'request' && unreadable ? (
        <div className="bw-phone-scroll">
          {item.partial ? <RequestNotLoaded item={item} collection={collection} /> : <RequestIsLoading item={item} />}
        </div>
      ) : null}

      {current === 'request' && !unreadable && !isHttp ? (
        <div className="bw-phone-scroll">
          <p className="bw-phone-empty">
            {methodOf(item)} 请求在手机视图里还不能编辑和发送，请在完整界面里使用。
          </p>
          <button type="button" className="bw-phone-send" onClick={phone.showFull}>在完整界面打开</button>
        </div>
      ) : null}

      {current === 'request' && isHttp ? (
        <div className="bw-phone-scroll">
          <div className="bw-phone-env"><EnvironmentSelector collection={collection} /></div>
          <div className="bw-phone-url">
            <select
              className={`bw-method bw-${String(request.method).toLowerCase()}`}
              value={request.method}
              onChange={(e) => dispatch(updateRequestMethod({ method: e.target.value, itemUid: item.uid, collectionUid: collection.uid }))}
              aria-label="请求方法"
              data-testid="bw-phone-method"
            >
              {(METHODS.includes(request.method) ? METHODS : [request.method, ...METHODS]).map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <textarea
              data-testid="bw-phone-url"
              value={request.url}
              rows={3}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              placeholder="请求地址"
              onChange={(e) => dispatch(requestUrlChanged({ itemUid: item.uid, collectionUid: collection.uid, url: e.target.value }))}
            />
          </div>
          <button type="button" className="bw-phone-send" onClick={send} disabled={!!waiting || inFlight} data-testid="bw-phone-send">发送</button>
          {item.response || item.requestState ? (
            <button type="button" className="bw-phone-row" onClick={() => setScreen('response')} data-testid="bw-phone-last-response">
              <span className="bw-name">上次响应：{statusText(item)}</span>
              <span className="bw-chevron">›</span>
            </button>
          ) : null}
          <button type="button" className="bw-phone-row" onClick={() => setScreen('edit')} data-testid="bw-phone-edit">
            <span className="bw-name">参数、请求头、请求体、认证…</span>
            <span className="bw-chevron">›</span>
          </button>
        </div>
      ) : null}

      {current === 'edit' ? (
        <div className="bw-phone-pane"><HttpRequestPane item={item} collection={collection} /></div>
      ) : null}

      {current === 'response' ? (
        <div className="bw-phone-pane" data-testid="bw-phone-response">
          <ResponsePane item={item} collection={collection} response={item.response} />
        </div>
      ) : null}
    </Root>
  );
}
